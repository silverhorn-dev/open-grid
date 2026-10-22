import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const GRID_TTL_MS = 10 * 60 * 1000;
const REMOVED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_QUEUE_TTL_HOURS = 72;

export function createStore(databasePath) {
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
    `);
    const peerColumns = database.prepare('PRAGMA table_info(peers)').all();
    if (!peerColumns.some(column => column.name === 'auth_hash')) {
        database.exec('ALTER TABLE peers ADD COLUMN auth_hash TEXT');
    }
    const credentialColumns = database.prepare('PRAGMA table_info(peer_credentials)').all();
    if (!credentialColumns.some(column => column.name === 'identity_jwk')) {
        database.exec('ALTER TABLE peer_credentials ADD COLUMN identity_jwk TEXT');
    }

    const statements = {
        findPeer: database.prepare(`
            SELECT peer_id AS peerId, registration_id AS registrationId, auth_hash AS authHash, geohash
            FROM peers
            WHERE peer_id = ?
        `),
        findPeerCredential: database.prepare(`
            SELECT auth_hash AS authHash, identity_jwk AS identityJwk
            FROM peer_credentials
            WHERE peer_id = ?
        `),
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
            INSERT INTO peers (peer_id, registration_id, auth_hash, geohash, thumbnail, name, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(peer_id) DO UPDATE SET
                registration_id = excluded.registration_id,
                auth_hash = excluded.auth_hash,
                geohash = excluded.geohash,
                thumbnail = excluded.thumbnail,
                name = excluded.name,
                expires_at = excluded.expires_at
        `),
        deletePeer: database.prepare('DELETE FROM peers WHERE peer_id = ?'),
        deletePeerRegistration: database.prepare('DELETE FROM peers WHERE peer_id = ? AND registration_id = ?'),
        listPeers: database.prepare(`
            SELECT peer_id AS peerId, geohash, thumbnail, name
            FROM peers
            WHERE geohash = ? AND expires_at > ?
            ORDER BY peer_id
        `),
        upsertRemoved: database.prepare(`
            INSERT INTO removed_peers (geohash, peer_id, removed_at, expires_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(geohash, peer_id) DO UPDATE SET
                removed_at = excluded.removed_at,
                expires_at = excluded.expires_at
        `),
        deleteRemoved: database.prepare('DELETE FROM removed_peers WHERE geohash = ? AND peer_id = ?'),
        listRemoved: database.prepare(`
            SELECT peer_id AS peerId
            FROM removed_peers
            WHERE geohash = ? AND expires_at > ?
            ORDER BY removed_at
        `),
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
            } else if (!credential.identityJwk || !credentialMatches) {
                statements.updatePeerCredential.run(
                    session.authHash,
                    session.identityJwk,
                    session.peerId
                );
            }
            if (previous && previous.geohash !== session.geohash) {
                statements.upsertRemoved.run(
                    previous.geohash,
                    session.peerId,
                    now,
                    now + REMOVED_TTL_MS
                );
            }
            statements.upsertPeer.run(
                session.peerId,
                session.registrationId,
                session.authHash,
                session.geohash,
                session.thumbnail,
                session.name,
                now + GRID_TTL_MS
            );
            statements.deleteRemoved.run(session.geohash, session.peerId);
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
    }

    return {
        registerPeer(session, now = Date.now()) {
            return registerPeerTransaction(session, now);
        },

        authenticatePeer(peerId, authHash) {
            const credential = statements.findPeerCredential.get(peerId);
            return Boolean(credential?.authHash && authHash && credential.authHash === authHash);
        },

        unregisterPeer(peerId, registrationId, geohash = null, now = Date.now()) {
            return unregisterPeerTransaction(peerId, registrationId, geohash, now);
        },

        getGrid(geohash, now = Date.now()) {
            cleanup(now);
            const peers = statements.listPeers.all(geohash, now);
            const activePeerIds = new Set(peers.map(peer => peer.peerId));
            const removedPeerIds = statements.listRemoved
                .all(geohash, now)
                .map(record => record.peerId)
                .filter(peerId => !activePeerIds.has(peerId));
            return { peers, removedPeerIds };
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

        cleanup,

        close() {
            database.close();
        }
    };
}
