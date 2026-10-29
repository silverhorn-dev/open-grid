// Speicher fuer das Admin-Panel (server/admin.js, Board T25): Passkeys der Betreiber und Kennzahlen,
// die das Panel aus der Datenbank liest. Keine Nutzerinhalte.
export function createAdminStore(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS admin_passkeys (
            id TEXT PRIMARY KEY,
            public_key BLOB NOT NULL,
            counter INTEGER NOT NULL DEFAULT 0,
            transports TEXT,
            name TEXT,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER
        );

        -- Meldungen aus der App (server/reports.js): nur IDs, Trefferguete und Notiz, nie ein Bild.
        CREATE TABLE IF NOT EXISTS reports (
            id TEXT PRIMARY KEY,
            reporter_id TEXT NOT NULL,
            reported_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            matches INTEGER,
            note TEXT,
            created_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            resolved_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS reports_status ON reports (status, created_at);

        -- Live-Konfiguration aus dem Panel (server/live-config.js); gewinnt ueber die Umgebungsvariablen.
        CREATE TABLE IF NOT EXISTS admin_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);
    const statements = {
        list: database.prepare('SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM admin_passkeys ORDER BY created_at'),
        find: database.prepare('SELECT id, public_key AS publicKey, counter, transports FROM admin_passkeys WHERE id = ?'),
        count: database.prepare('SELECT COUNT(*) AS count FROM admin_passkeys'),
        insert: database.prepare('INSERT INTO admin_passkeys (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
        touch: database.prepare('UPDATE admin_passkeys SET counter = ?, last_used_at = ? WHERE id = ?'),
        remove: database.prepare('DELETE FROM admin_passkeys WHERE id = ?'),
        listSettings: database.prepare('SELECT key, value, updated_at AS updatedAt FROM admin_settings'),
        upsertSetting: database.prepare('INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'),
        deleteSetting: database.prepare('DELETE FROM admin_settings WHERE key = ?'),
        insertReport: database.prepare('INSERT INTO reports (id, reporter_id, reported_id, kind, matches, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
        listReports: database.prepare(`
            SELECT r.id, r.reporter_id AS reporterId, r.reported_id AS reportedId, r.kind, r.matches, r.note,
                   r.created_at AS createdAt, r.status, r.resolved_at AS resolvedAt,
                   (SELECT COUNT(*) FROM reports other WHERE other.reported_id = r.reported_id) AS reportsAboutPeer,
                   (SELECT COUNT(DISTINCT other.reporter_id) FROM reports other WHERE other.reported_id = r.reported_id) AS reportersAboutPeer
            FROM reports r WHERE (? = 'all' OR r.status = ?) ORDER BY r.created_at DESC LIMIT 200
        `),
        findReport: database.prepare('SELECT id, reported_id AS reportedId, status FROM reports WHERE id = ?'),
        resolveReport: database.prepare('UPDATE reports SET status = ?, resolved_at = ? WHERE id = ?'),
        resolveReportsAbout: database.prepare("UPDATE reports SET status = ?, resolved_at = ? WHERE reported_id = ? AND status = 'open'"),
        openReports: database.prepare("SELECT COUNT(*) AS count FROM reports WHERE status = 'open'"),
        duplicateReport: database.prepare("SELECT 1 FROM reports WHERE reporter_id = ? AND reported_id = ? AND status = 'open'"),
        queueTotals: database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(ciphertext_payload)), 0) AS bytes FROM queued_messages WHERE expires_at > ?'),
        peerTotals: database.prepare('SELECT COUNT(*) AS count FROM peers'),
        pushTotals: database.prepare('SELECT COUNT(*) AS count FROM push_subscriptions')
    };
    return {
        countPasskeys: () => statements.count.get().count,
        listPasskeys: () => statements.list.all(),
        findPasskey(id) {
            const row = statements.find.get(id);
            return row ? { ...row, publicKey: new Uint8Array(row.publicKey), transports: row.transports ? JSON.parse(row.transports) : [] } : null;
        },
        addPasskey({ id, publicKey, counter, transports, name }, now = Date.now()) {
            statements.insert.run(id, Buffer.from(publicKey), counter || 0, JSON.stringify(transports || []), name || null, now);
        },
        touchPasskey: (id, counter, now = Date.now()) => statements.touch.run(counter, now, id),
        removePasskey: id => statements.remove.run(id).changes > 0,
        settings: () => Object.fromEntries(statements.listSettings.all().map(row => [row.key, { value: JSON.parse(row.value), updatedAt: row.updatedAt }])),
        saveSetting: (key, value, now = Date.now()) => statements.upsertSetting.run(key, JSON.stringify(value), now),
        deleteSetting: key => statements.deleteSetting.run(key).changes > 0,
        addReport: ({ id, reporterId, reportedId, kind, matches, note }, now = Date.now()) => statements.insertReport.run(id, reporterId, reportedId, kind, matches ?? null, note ?? null, now),
        hasOpenReport: (reporterId, reportedId) => Boolean(statements.duplicateReport.get(reporterId, reportedId)),
        listReports: (status = 'open') => statements.listReports.all(status, status),
        findReport: id => statements.findReport.get(id) || null,
        // Sperren erledigt alle offenen Meldungen zu diesem Peer; "erledigt" nur die eine.
        resolveReport(id, status, now = Date.now()) {
            const report = statements.findReport.get(id);
            if (!report) return false;
            if (status === 'banned') statements.resolveReportsAbout.run(status, now, report.reportedId);
            else statements.resolveReport.run(status, now, id);
            return true;
        },
        openReportCount: () => statements.openReports.get().count,
        queueTotals: (now = Date.now()) => statements.queueTotals.get(now),
        peerCount: () => statements.peerTotals.get().count,
        pushCount: () => statements.pushTotals.get().count
    };
}
