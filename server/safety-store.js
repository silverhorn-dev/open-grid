// Speicher fuer Alters-/E-Mail-Nachweise, Sperren und das optionale IP-Protokoll (server/safety.js).
// Der Router speichert nur das Noetigste: Status und Ablauf je Peer, die E-Mail verschluesselt
// (Betreiber-Schluessel) plus einen HMAC fuer den Abgleich mit Sperren, nie Ausweis- oder Gesichtsdaten.

export function createSafetyStore(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS safety_verifications (
            peer_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            method TEXT NOT NULL,
            verified_at INTEGER NOT NULL,
            expires_at INTEGER,
            subject_hash TEXT,
            email_encrypted TEXT,
            PRIMARY KEY (peer_id, kind)
        );

        CREATE TABLE IF NOT EXISTS safety_email_codes (
            peer_id TEXT PRIMARY KEY,
            email_hash TEXT NOT NULL,
            email_encrypted TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS safety_bans (
            kind TEXT NOT NULL,
            value TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            reason TEXT,
            PRIMARY KEY (kind, value)
        );

        CREATE TABLE IF NOT EXISTS abuse_log (
            peer_id TEXT NOT NULL,
            ip TEXT NOT NULL,
            seen_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS abuse_log_peer ON abuse_log (peer_id, seen_at);
        CREATE INDEX IF NOT EXISTS abuse_log_seen ON abuse_log (seen_at);
    `);

    const statements = {
        findVerification: database.prepare(`
            SELECT method, verified_at AS verifiedAt, expires_at AS expiresAt
            FROM safety_verifications WHERE peer_id = ? AND kind = ?
        `),
        upsertVerification: database.prepare(`
            INSERT INTO safety_verifications (peer_id, kind, method, verified_at, expires_at, subject_hash, email_encrypted)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (peer_id, kind) DO UPDATE SET method = excluded.method, verified_at = excluded.verified_at,
                expires_at = excluded.expires_at, subject_hash = excluded.subject_hash, email_encrypted = excluded.email_encrypted
        `),
        deleteVerifications: database.prepare('DELETE FROM safety_verifications WHERE peer_id = ?'),
        findEmailCiphertext: database.prepare("SELECT email_encrypted AS value FROM safety_verifications WHERE peer_id = ? AND kind = 'email'"),
        peersBySubject: database.prepare('SELECT peer_id AS peerId FROM safety_verifications WHERE subject_hash = ?'),
        findEmailCode: database.prepare(`
            SELECT email_hash AS emailHash, email_encrypted AS emailEncrypted, code_hash AS codeHash,
                expires_at AS expiresAt, attempts
            FROM safety_email_codes WHERE peer_id = ?
        `),
        upsertEmailCode: database.prepare(`
            INSERT INTO safety_email_codes (peer_id, email_hash, email_encrypted, code_hash, expires_at, attempts)
            VALUES (?, ?, ?, ?, ?, 0)
            ON CONFLICT (peer_id) DO UPDATE SET email_hash = excluded.email_hash, email_encrypted = excluded.email_encrypted,
                code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0
        `),
        countEmailAttempt: database.prepare('UPDATE safety_email_codes SET attempts = attempts + 1 WHERE peer_id = ?'),
        deleteEmailCode: database.prepare('DELETE FROM safety_email_codes WHERE peer_id = ?'),
        findBan: database.prepare('SELECT 1 FROM safety_bans WHERE kind = ? AND value = ?'),
        insertBan: database.prepare('INSERT OR IGNORE INTO safety_bans (kind, value, created_at, reason) VALUES (?, ?, ?, ?)'),
        insertAbuseLog: database.prepare('INSERT INTO abuse_log (peer_id, ip, seen_at) VALUES (?, ?, ?)'),
        lastAbuseLog: database.prepare('SELECT ip, seen_at AS seenAt FROM abuse_log WHERE peer_id = ? ORDER BY seen_at DESC LIMIT 1'),
        listAbuseLog: database.prepare('SELECT ip, seen_at AS seenAt FROM abuse_log WHERE peer_id = ? ORDER BY seen_at'),
        pruneAbuseLog: database.prepare('DELETE FROM abuse_log WHERE seen_at < ?')
    };

    return {
        // Gueltiger Nachweis (kind = 'age' | 'email') oder null.
        getVerification(peerId, kind, now = Date.now()) {
            const row = statements.findVerification.get(peerId, kind);
            if (!row || (row.expiresAt != null && row.expiresAt <= now)) return null;
            return row;
        },

        saveVerification(peerId, kind, { method, expiresAt = null, subjectHash = null, emailEncrypted = null }, now = Date.now()) {
            statements.upsertVerification.run(peerId, kind, method, now, expiresAt, subjectHash, emailEncrypted);
        },

        getEmailCiphertext(peerId) {
            return statements.findEmailCiphertext.get(peerId)?.value || null;
        },

        removePeer(peerId) {
            statements.deleteVerifications.run(peerId);
            statements.deleteEmailCode.run(peerId);
        },

        getEmailCode(peerId) {
            return statements.findEmailCode.get(peerId) || null;
        },

        saveEmailCode(peerId, { emailHash, emailEncrypted, codeHash, expiresAt }) {
            statements.upsertEmailCode.run(peerId, emailHash, emailEncrypted, codeHash, expiresAt);
        },

        countEmailAttempt(peerId) {
            statements.countEmailAttempt.run(peerId);
        },

        deleteEmailCode(peerId) {
            statements.deleteEmailCode.run(peerId);
        },

        // Sperren: kind = 'peer' (Peer-ID), 'email' (HMAC der Adresse), 'subject' (HMAC des Anbieter-Pseudonyms).
        isBanned(kind, value) {
            return Boolean(value) && Boolean(statements.findBan.get(kind, value));
        },

        addBan(kind, value, reason = null, now = Date.now()) {
            statements.insertBan.run(kind, value, now, reason);
        },

        peersWithSubject(subjectHash) {
            return statements.peersBySubject.all(subjectHash).map(row => row.peerId);
        },

        // IP-Protokoll: hoechstens ein Eintrag je Peer und IP pro Stunde.
        logAccess(peerId, ip, now = Date.now()) {
            const last = statements.lastAbuseLog.get(peerId);
            if (last && last.ip === ip && now - last.seenAt < 60 * 60 * 1000) return false;
            statements.insertAbuseLog.run(peerId, ip, now);
            return true;
        },

        listAccess(peerId) {
            return statements.listAbuseLog.all(peerId).map(row => ({ ...row }));
        },

        pruneAccessLog(before) {
            return Number(statements.pruneAbuseLog.run(before).changes);
        }
    };
}
