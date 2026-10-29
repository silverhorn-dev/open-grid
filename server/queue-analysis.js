// ================= ZWISCHENSPEICHER ANALYSIEREN (Admin-Panel, Board T25) =================
// Nur Metadaten: Empfaenger, Absender, Groesse, Ablauf und die Erstellzeit (steckt in der msgId
// `msg_<zeit>_<uuid>`). Inhalt und Art der Nachricht sind Ende-zu-Ende verschluesselt und werden bewusst
// nicht erfasst (Nutzer 2026-10-29).
const AGE_BUCKETS = [
    ['lt1h', 60 * 60 * 1000],
    ['1to6h', 6 * 60 * 60 * 1000],
    ['6to24h', 24 * 60 * 60 * 1000],
    ['gt24h', Infinity]
];
const TOP = 15;

export function createdAtOf(msgId) {
    const match = /^msg_(\d{10,})_/.exec(String(msgId));
    return match ? Number(match[1]) : null;
}

export function analyzeQueue(rows, { now = Date.now(), registered = new Set(), isOnline = () => false } = {}) {
    const result = {
        total: rows.length,
        bytes: 0,
        expired: 0,
        oldestAt: null,
        byAge: Object.fromEntries(AGE_BUCKETS.map(([name]) => [name, 0])),
        recipients: [],
        pairs: [],
        recipientCount: 0,
        recipientsOnline: 0,
        recipientsUnknown: 0
    };
    const recipients = new Map();
    const pairs = new Map();
    for (const row of rows) {
        result.bytes += row.bytes;
        if (row.expiresAt <= now) result.expired += 1;
        const createdAt = createdAtOf(row.msgId);
        if (createdAt) {
            result.oldestAt = Math.min(result.oldestAt ?? createdAt, createdAt);
            const age = now - createdAt;
            result.byAge[AGE_BUCKETS.find(([, limit]) => age < limit)[0]] += 1;
        }
        const recipient = recipients.get(row.recipientId) || { recipientId: row.recipientId, count: 0, bytes: 0, oldestAt: null };
        recipient.count += 1;
        recipient.bytes += row.bytes;
        if (createdAt) recipient.oldestAt = Math.min(recipient.oldestAt ?? createdAt, createdAt);
        recipients.set(row.recipientId, recipient);
        const pairKey = `${row.senderId}\u0000${row.recipientId}`;
        const pair = pairs.get(pairKey) || { senderId: row.senderId, recipientId: row.recipientId, count: 0 };
        pair.count += 1;
        pairs.set(pairKey, pair);
    }
    const all = [...recipients.values()].map(entry => ({ ...entry, online: isOnline(entry.recipientId), registered: registered.has(entry.recipientId) }));
    result.recipientCount = all.length;
    result.recipientsOnline = all.filter(entry => entry.online).length;
    // Unbekannt = keine Zugangsdaten mehr (Profil geloescht oder lange nicht da): holt nie ab.
    result.recipientsUnknown = all.filter(entry => !entry.registered).length;
    result.recipients = all.sort((left, right) => right.count - left.count).slice(0, TOP);
    result.pairs = [...pairs.values()].sort((left, right) => right.count - left.count).slice(0, TOP);
    return result;
}
