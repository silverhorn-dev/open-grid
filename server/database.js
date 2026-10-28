import { randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const GRID_TTL_MS = 10 * 60 * 1000;
const MIN_GRID_TTL_MS = 1 * 60 * 1000;
const MAX_GRID_TTL_MS = 60 * 60 * 1000;
const REMOVED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_QUEUE_TTL_HOURS = 72;

const DEFAULT_CREDENTIAL_RETENTION_DAYS = 180;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Aufbewahrung verwaister Identitaeten (CREDENTIAL_RETENTION_DAYS, mindestens 7 Tage).
export function parseRetentionDays(value) {
    const days = Number(value);
    return Number.isFinite(days) && days >= 7 ? Math.floor(days) : DEFAULT_CREDENTIAL_RETENTION_DAYS;
}

export function createStore(databasePath, { credentialRetentionDays = DEFAULT_CREDENTIAL_RETENTION_DAYS } = {}) {
    const retentionMs = parseRetentionDays(credentialRetentionDays) * 24 * 60 * 60 * 1000;
    let lastRetentionSweep = 0;
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(`
        CREATE TABLE IF NOT EXISTS peers (
            peer_id TEXT PRIMARY KEY,
            registration_id TEXT NOT NULL,
            auth_hash TEXT,
            geohash TEXT NOT NULL,
            thumbnail TEXT,
            name TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS peers_geohash_expires
            ON peers (geohash, expires_at);

        CREATE TABLE IF NOT EXISTS peer_credentials (
            peer_id TEXT PRIMARY KEY,
            auth_hash TEXT NOT NULL,
            identity_jwk TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS removed_peers (
            geohash TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            removed_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            PRIMARY KEY (geohash, peer_id)
        );
        CREATE INDEX IF NOT EXISTS removed_peers_expires
            ON removed_peers (expires_at);

        CREATE TABLE IF NOT EXISTS queued_messages (
            msg_id TEXT PRIMARY KEY,
            recipient_id TEXT NOT NULL,
            sender_id TEXT,
            ciphertext_payload TEXT NOT NULL,
            iv_hex TEXT,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS queued_messages_recipient_expires
            ON queued_messages (recipient_id, expires_at);

        CREATE TABLE IF NOT EXISTS chat_controls (
            owner_id TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            deleted_before INTEGER,
            blocked_at INTEGER,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (owner_id, peer_id)
        );
        CREATE INDEX IF NOT EXISTS chat_controls_owner
            ON chat_controls (owner_id, updated_at);

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            peer_id TEXT PRIMARY KEY,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS server_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);
    const peerColumns = database.prepare('PRAGMA table_info(peers)').all();
    if (!peerColumns.some(column => column.name === 'auth_hash')) {
        database.exec('ALTER TABLE peers ADD COLUMN auth_hash TEXT');
    }
    if (!peerColumns.some(column => column.name === 'silent')) {
        database.exec('ALTER TABLE peers ADD COLUMN silent INTEGER NOT NULL DEFAULT 0');
    }
    // App-Modi (P8): wo der Peer sichtbar ist (public, friends, event) und der Hash des Event-Codes.
    if (!peerColumns.some(column => column.name === 'scope')) {
        database.exec("ALTER TABLE peers ADD COLUMN scope TEXT NOT NULL DEFAULT 'public'");
    }
    if (!peerColumns.some(column => column.name === 'event_hash')) {
        database.exec('ALTER TABLE peers ADD COLUMN event_hash TEXT');
        database.exec('CREATE INDEX IF NOT EXISTS peers_event_expires ON peers (event_hash, expires_at)');
    }
    const credentialColumns = database.prepare('PRAGMA table_info(peer_credentials)').all();
    if (!credentialColumns.some(column => column.name === 'identity_jwk')) {
        database.exec('ALTER TABLE peer_credentials ADD COLUMN identity_jwk TEXT');
    }
    // Letzte Registrierung; alte Datensaetze starten mit ihrem Erstellungsdatum.
    if (!credentialColumns.some(column => column.name === 'last_active_at')) {
        database.exec('ALTER TABLE peer_credentials ADD COLUMN last_active_at INTEGER');
        database.exec('UPDATE peer_credentials SET last_active_at = created_at WHERE last_active_at IS NULL');
    }

    // Profil-Version (nur ein Zaehler, kein Inhalt): Clients holen ein Profil nur neu, wenn es sich geaendert hat.
    if (!database.prepare('PRAGMA table_info(peers)').all().some(column => column.name === 'profile_version')) {
        database.exec('ALTER TABLE peers ADD COLUMN profile_version INTEGER');
    }
    // "Nur zeigen fuer ...": kurzer Code der Sichtbarkeitsregel (die Apps der Betrachter werten ihn aus).
    if (!database.prepare('PRAGMA table_info(peers)').all().some(column => column.name === 'audience')) {
        database.exec('ALTER TABLE peers ADD COLUMN audience TEXT');
    }

    // Benachrichtigungsarten, die der Peer nicht per Push will (JSON-Liste, z. B. ["flame"]).
    const pushColumns = database.prepare('PRAGMA table_info(push_subscriptions)').all();
    if (!pushColumns.some(column => column.name === 'muted_kinds')) {
        database.exec('ALTER TABLE push_subscriptions ADD COLUMN muted_kinds TEXT');
    }

    const statements = {
        findPeer: database.prepare(`
            SELECT peer_id AS peerId, registration_id AS registrationId, auth_hash AS authHash, geohash, silent, scope
            FROM peers
            WHERE peer_id = ?
        `),
        findPeerCredential: database.prepare(`
            SELECT auth_hash AS authHash, identity_jwk AS identityJwk
            FROM peer_credentials
            WHERE peer_id = ?
        `),
        touchPeerCredential: database.prepare('UPDATE peer_credentials SET last_active_at = ? WHERE peer_id = ?'),
        listStaleCredentials: database.prepare('SELECT peer_id AS peerId FROM peer_credentials WHERE COALESCE(last_active_at, created_at) < ?'),
        deleteCredential: database.prepare('DELETE FROM peer_credentials WHERE peer_id = ?'),
        deleteOwnerControls: database.prepare('DELETE FROM chat_controls WHERE owner_id = ?'),
        deleteRecipientMessages: database.prepare('DELETE FROM queued_messages WHERE recipient_id = ?'),
        insertPeerCredential: database.prepare(`
            INSERT INTO peer_credentials (peer_id, auth_hash, identity_jwk, created_at)
            VALUES (?, ?, ?, ?)
        `),
        updatePeerCredential: database.prepare(`
            UPDATE peer_credentials
            SET auth_hash = ?, identity_jwk = ?
            WHERE peer_id = ?
        `),
        upsertPeer: database.prepare(`
            INSERT INTO peers (peer_id, registration_id, auth_hash, geohash, thumbnail, name, silent, scope, event_hash, expires_at, profile_version, audience)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(peer_id) DO UPDATE SET
                registration_id = excluded.registration_id,
                auth_hash = excluded.auth_hash,
                geohash = excluded.geohash,
                thumbnail = excluded.thumbnail,
                name = excluded.name,
                silent = excluded.silent,
                scope = excluded.scope,
                event_hash = excluded.event_hash,
                expires_at = excluded.expires_at,
                profile_version = excluded.profile_version,
                audience = excluded.audience
        `),
        deletePeer: database.prepare('DELETE FROM peers WHERE peer_id = ?'),
        deletePeerRegistration: database.prepare('DELETE FROM peers WHERE peer_id = ? AND registration_id = ?'),
        // Prefix-Abfrage ueber den (geohash, expires_at)-Index: geohash >= prefix AND geohash < prefix + '~'.
        listPeersInCell: database.prepare(`
            SELECT peer_id AS peerId, geohash, thumbnail, name, profile_version AS profileVersion, audience
            FROM peers
            WHERE geohash >= ? AND geohash < ? AND expires_at > ? AND silent = 0 AND scope = 'public'
        `),
        listEventPeers: database.prepare(`
            SELECT peer_id AS peerId, geohash, thumbnail, name, profile_version AS profileVersion, audience
            FROM peers
            WHERE event_hash = ? AND scope = 'event' AND expires_at > ? AND silent = 0
            LIMIT 500
        `),
        findVisiblePeer: database.prepare(`
            SELECT peer_id AS peerId, geohash, thumbnail, name, profile_version AS profileVersion, audience
            FROM peers
            WHERE peer_id = ? AND expires_at > ? AND silent = 0 AND scope IN ('public', 'friends')
        `),
        listRemovedInCell: database.prepare(`
            SELECT peer_id AS peerId
            FROM removed_peers
            WHERE geohash >= ? AND geohash < ? AND expires_at > ?
        `),
        upsertRemoved: database.prepare(`
            INSERT INTO removed_peers (geohash, peer_id, removed_at, expires_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(geohash, peer_id) DO UPDATE SET
                removed_at = excluded.removed_at,
                expires_at = excluded.expires_at
        `),
        deleteRemoved: database.prepare('DELETE FROM removed_peers WHERE geohash = ? AND peer_id = ?'),
        deleteExpiredPeers: database.prepare('DELETE FROM peers WHERE expires_at <= ?'),
        deleteExpiredRemoved: database.prepare('DELETE FROM removed_peers WHERE expires_at <= ?'),
        insertMessage: database.prepare(`
            INSERT INTO queued_messages
                (msg_id, recipient_id, sender_id, ciphertext_payload, iv_hex, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `),
        listMessages: database.prepare(`
            SELECT
                msg_id AS msgId,
                sender_id AS senderId,
                ciphertext_payload AS ciphertextPayload,
                iv_hex AS ivHex,
                expires_at AS expiresAt
            FROM queued_messages
            WHERE recipient_id = ? AND expires_at > ?
            ORDER BY rowid
        `),
        deleteMessage: database.prepare('DELETE FROM queued_messages WHERE msg_id = ?'),
        queueUsage: database.prepare(`
            SELECT
                COUNT(*) AS count,
                COALESCE(SUM(LENGTH(ciphertext_payload)), 0) AS bytes,
                COALESCE(SUM(CASE WHEN sender_id = ? THEN 1 ELSE 0 END), 0) AS fromSender
            FROM queued_messages
            WHERE recipient_id = ? AND expires_at > ?
        `),
        findMessageRecipient: database.prepare('SELECT recipient_id AS recipientId FROM queued_messages WHERE msg_id = ?'),
        deleteExpiredMessages: database.prepare('DELETE FROM queued_messages WHERE expires_at <= ?'),
        deleteConversationMessages: database.prepare(`
            DELETE FROM queued_messages
            WHERE (recipient_id = ? AND sender_id = ?)
               OR (recipient_id = ? AND sender_id = ?)
        `),
        findChatControl: database.prepare(`
            SELECT
                owner_id AS ownerId,
                peer_id AS peerId,
                deleted_before AS deletedBefore,
                blocked_at AS blockedAt,
                updated_at AS updatedAt
            FROM chat_controls
            WHERE owner_id = ? AND peer_id = ?
        `),
        listChatControls: database.prepare(`
            SELECT
                owner_id AS ownerId,
                peer_id AS peerId,
                deleted_before AS deletedBefore,
                blocked_at AS blockedAt,
                updated_at AS updatedAt
            FROM chat_controls
            WHERE owner_id = ?
            ORDER BY updated_at
        `),
        upsertDeletedBefore: database.prepare(`
            INSERT INTO chat_controls (owner_id, peer_id, deleted_before, blocked_at, updated_at)
            VALUES (?, ?, ?, NULL, ?)
            ON CONFLICT(owner_id, peer_id) DO UPDATE SET
                deleted_before = MAX(COALESCE(chat_controls.deleted_before, 0), excluded.deleted_before),
                updated_at = excluded.updated_at
        `),
        upsertBlockedAt: database.prepare(`
            INSERT INTO chat_controls (owner_id, peer_id, deleted_before, blocked_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(owner_id, peer_id) DO UPDATE SET
                deleted_before = MAX(COALESCE(chat_controls.deleted_before, 0), excluded.deleted_before),
                blocked_at = excluded.blocked_at,
                updated_at = excluded.updated_at
        `),
        clearBlockedAt: database.prepare(`
            UPDATE chat_controls
            SET blocked_at = NULL, updated_at = ?
            WHERE owner_id = ? AND peer_id = ?
        `),
        upsertPushSubscription: database.prepare(`
            INSERT INTO push_subscriptions (peer_id, endpoint, p256dh, auth, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(peer_id) DO UPDATE SET
                endpoint = excluded.endpoint,
                p256dh = excluded.p256dh,
                auth = excluded.auth,
                updated_at = excluded.updated_at
        `),
        findPushSubscription: database.prepare(`
            SELECT endpoint, p256dh, auth
            FROM push_subscriptions
            WHERE peer_id = ?
        `),
        deletePushSubscription: database.prepare('DELETE FROM push_subscriptions WHERE peer_id = ?'),
        setPushMutedKinds: database.prepare('UPDATE push_subscriptions SET muted_kinds = ? WHERE peer_id = ?'),
        findPushMutedKinds: database.prepare('SELECT muted_kinds AS mutedKinds FROM push_subscriptions WHERE peer_id = ?'),
        deletePushSubscriptionEndpoint: database.prepare('DELETE FROM push_subscriptions WHERE peer_id = ? AND endpoint = ?'),
        findSetting: database.prepare('SELECT value FROM server_settings WHERE key = ?'),
        insertSetting: database.prepare('INSERT OR IGNORE INTO server_settings (key, value) VALUES (?, ?)'),
        deleteEmptyChatControl: database.prepare(`
            DELETE FROM chat_controls
            WHERE owner_id = ? AND peer_id = ?
              AND deleted_before IS NULL AND blocked_at IS NULL
        `)
    };

    function transaction(operation) {
        database.exec('BEGIN IMMEDIATE');
        try {
            const result = operation();
            database.exec('COMMIT');
            return result;
        } catch (error) {
            database.exec('ROLLBACK');
            throw error;
        }
    }

    function registerPeerTransaction(session, now) {
        return transaction(() => {
            const previous = statements.findPeer.get(session.peerId);
            const credential = statements.findPeerCredential.get(session.peerId);
            const credentialMatches = credential?.authHash === session.authHash;
            const identityMatches = credential?.identityJwk
                && credential.identityJwk === session.identityJwk;
            if (credential?.authHash && !credentialMatches && !identityMatches) return false;
            if (!credential) {
                statements.insertPeerCredential.run(
                    session.peerId,
                    session.authHash,
                    session.identityJwk,
                    now
                );
            } else if (session.identityJwk && (!credential.identityJwk || !credentialMatches)) {
                statements.updatePeerCredential.run(
                    session.authHash,
                    session.identityJwk,
                    session.peerId
                );
            }
            statements.touchPeerCredential.run(now, session.peerId);
            const silent = session.silent ? 1 : 0;
            const scope = ['friends', 'event'].includes(session.scope) ? session.scope : 'public';
            const wasPublic = previous && !previous.silent && (previous.scope || 'public') === 'public';
            const isPublic = !silent && scope === 'public';
            if (wasPublic && (previous.geohash !== session.geohash || !isPublic)) {
                // Tombstone, damit andere Clients den Peer aus ihrem lokalen Grid-Cache entfernen.
                statements.upsertRemoved.run(
                    previous.geohash,
                    session.peerId,
                    now,
                    now + REMOVED_TTL_MS
                );
            }
            const ttlMs = Number.isFinite(session.ttlMs)
                ? Math.min(Math.max(session.ttlMs, MIN_GRID_TTL_MS), MAX_GRID_TTL_MS)
                : GRID_TTL_MS;
            statements.upsertPeer.run(
                session.peerId,
                session.registrationId,
                session.authHash,
                session.geohash,
                session.thumbnail,
                session.name,
                silent,
                scope,
                scope === 'event' ? session.eventHash : null,
                now + ttlMs,
                Number.isSafeInteger(session.profileVersion) ? session.profileVersion : null,
                session.audience || null
            );
            if (isPublic) statements.deleteRemoved.run(session.geohash, session.peerId);
            return true;
        });
    }

    function unregisterPeerTransaction(peerId, registrationId, geohash, now) {
        return transaction(() => {
            const current = statements.findPeer.get(peerId);
            if (!current || current.registrationId !== registrationId) return 0;
            const registeredGeohash = geohash || current.geohash;
            const result = statements.deletePeerRegistration.run(peerId, registrationId);
            if (result.changes) {
                statements.upsertRemoved.run(
                    registeredGeohash,
                    peerId,
                    now,
                    now + REMOVED_TTL_MS
                );
            }
            return Number(result.changes);
        });
    }

    function cleanup(now = Date.now()) {
        statements.deleteExpiredPeers.run(now);
        statements.deleteExpiredRemoved.run(now);
        statements.deleteExpiredMessages.run(now);
        if (now - lastRetentionSweep >= RETENTION_SWEEP_INTERVAL_MS) {
            lastRetentionSweep = now;
            removeStaleIdentities(now);
        }
    }

    // Seit der Aufbewahrungsfrist nicht mehr registriert: Zugangsdaten, Push-Abo, eigene
    // Chat-Kontrollen und wartende Nachrichten loeschen. Bei Rueckkehr registriert sich der
    // Client mit seinem Signaturschluessel neu.
    function removeStaleIdentities(now) {
        const stale = statements.listStaleCredentials.all(now - retentionMs);
        if (!stale.length) return 0;
        transaction(() => {
            for (const { peerId } of stale) {
                statements.deleteCredential.run(peerId);
                statements.deletePushSubscription.run(peerId);
                statements.deleteOwnerControls.run(peerId);
                statements.deleteRecipientMessages.run(peerId);
                statements.deletePeer.run(peerId);
            }
        });
        return stale.length;
    }

    return {
        registerPeer(session, now = Date.now()) {
            return registerPeerTransaction(session, now);
        },

        // Fuer Tests und Betrieb: sofortiger Durchlauf der Aufbewahrungsregel.
        removeStaleIdentities(now = Date.now()) {
            return removeStaleIdentities(now);
        },

        getPeerGeohash(peerId) {
            return statements.findPeer.get(peerId)?.geohash || null;
        },

        isPeerSilent(peerId) {
            return Boolean(statements.findPeer.get(peerId)?.silent);
        },

        // Nur im oeffentlichen Grid sichtbare Peers loesen PEER_OFFLINE in ihrer Zelle aus.
        isPeerPublic(peerId) {
            const peer = statements.findPeer.get(peerId);
            return Boolean(peer) && !peer.silent && (peer.scope || 'public') === 'public';
        },

        getEventPeers(eventHash, now = Date.now()) {
            cleanup(now);
            return statements.listEventPeers.all(eventHash, now);
        },

        // Fuer das Freunde-Grid: nur nicht stille Peers im Modus public oder friends.
        getVisiblePeers(peerIds, now = Date.now()) {
            return peerIds.map(peerId => statements.findVisiblePeer.get(peerId, now)).filter(Boolean);
        },

        authenticatePeer(peerId, authHash) {
            const credential = statements.findPeerCredential.get(peerId);
            if (!credential?.authHash || typeof authHash !== 'string') return false;
            // Konstante Laufzeit: der Vergleich verraet nichts ueber den gespeicherten Hash.
            const stored = Buffer.from(credential.authHash);
            const given = Buffer.from(authHash);
            return stored.length === given.length && timingSafeEqual(stored, given);
        },

        unregisterPeer(peerId, registrationId, geohash = null, now = Date.now()) {
            return unregisterPeerTransaction(peerId, registrationId, geohash, now);
        },

        getGridArea(cells, now = Date.now()) {
            cleanup(now);
            const peers = new Map();
            const removed = new Set();
            for (const cell of cells) {
                for (const peer of statements.listPeersInCell.all(cell, `${cell}~`, now)) peers.set(peer.peerId, peer);
                for (const record of statements.listRemovedInCell.all(cell, `${cell}~`, now)) removed.add(record.peerId);
            }
            const removedPeerIds = [...removed].filter(peerId => !peers.has(peerId));
            return { peers: [...peers.values()], removedPeerIds };
        },

        enqueueMessage(message, now = Date.now()) {
            const ttlHours = Math.min(Math.max(Number(message.ttlHours) || 24, 1), MAX_QUEUE_TTL_HOURS);
            const queued = {
                msgId: `msg_${now}_${randomUUID()}`,
                recipientId: message.recipientId,
                senderId: message.senderId || null,
                ciphertextPayload: message.ciphertextPayload,
                ivHex: message.ivHex || null,
                expiresAt: now + ttlHours * 60 * 60 * 1000
            };
            statements.insertMessage.run(
                queued.msgId,
                queued.recipientId,
                queued.senderId,
                queued.ciphertextPayload,
                queued.ivHex,
                queued.expiresAt
            );
            return queued;
        },

        getQueueUsage(recipientId, senderId, now = Date.now()) {
            const usage = statements.queueUsage.get(senderId, recipientId, now);
            return { count: Number(usage.count), bytes: Number(usage.bytes), fromSender: Number(usage.fromSender) };
        },

        getMessages(recipientId, now = Date.now()) {
            cleanup(now);
            return statements.listMessages.all(recipientId, now);
        },

        deleteMessage(msgId) {
            return Number(statements.deleteMessage.run(msgId).changes);
        },

        getMessageRecipient(msgId) {
            return statements.findMessageRecipient.get(msgId)?.recipientId || null;
        },

        setChatControl(ownerId, peerId, action, now = Date.now()) {
            return transaction(() => {
                if (action === 'DELETE_CHAT') {
                    statements.upsertDeletedBefore.run(ownerId, peerId, now, now);
                } else if (action === 'BLOCK') {
                    statements.upsertBlockedAt.run(ownerId, peerId, now, now, now);
                } else {
                    throw new Error(`Unsupported chat control action: ${action}`);
                }
                statements.deleteConversationMessages.run(ownerId, peerId, peerId, ownerId);
                return statements.findChatControl.get(ownerId, peerId);
            });
        },

        clearBlock(ownerId, peerId, now = Date.now()) {
            return transaction(() => {
                statements.clearBlockedAt.run(now, ownerId, peerId);
                statements.deleteEmptyChatControl.run(ownerId, peerId);
                return statements.findChatControl.get(ownerId, peerId) || null;
            });
        },

        getChatControls(ownerId) {
            return statements.listChatControls.all(ownerId);
        },

        isBlocked(ownerId, peerId) {
            return Boolean(statements.findChatControl.get(ownerId, peerId)?.blockedAt);
        },

        setPushSubscription(peerId, subscription, now = Date.now()) {
            statements.upsertPushSubscription.run(
                peerId,
                subscription.endpoint,
                subscription.keys.p256dh,
                subscription.keys.auth,
                now
            );
        },

        setPushMutedKinds(peerId, kinds) {
            return Number(statements.setPushMutedKinds.run(JSON.stringify(kinds), peerId).changes);
        },

        getPushMutedKinds(peerId) {
            try {
                const value = JSON.parse(statements.findPushMutedKinds.get(peerId)?.mutedKinds || '[]');
                return Array.isArray(value) ? value : [];
            } catch {
                return [];
            }
        },

        getPushSubscription(peerId) {
            const record = statements.findPushSubscription.get(peerId);
            return record
                ? { endpoint: record.endpoint, keys: { p256dh: record.p256dh, auth: record.auth } }
                : null;
        },

        deletePushSubscription(peerId, endpoint = null) {
            const result = endpoint
                ? statements.deletePushSubscriptionEndpoint.run(peerId, endpoint)
                : statements.deletePushSubscription.run(peerId);
            return Number(result.changes);
        },

        // Liefert einen gespeicherten Wert oder legt ihn genau einmal an, damit
        // generierte Server-Schluessel einen Neustart ueberleben.
        getOrCreateSetting(key, createValue) {
            const existing = statements.findSetting.get(key);
            if (existing) return existing.value;
            statements.insertSetting.run(key, createValue());
            return statements.findSetting.get(key).value;
        },

        cleanup,

        close() {
            database.close();
        }
    };
}
