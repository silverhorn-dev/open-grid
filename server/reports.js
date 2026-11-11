import { randomUUID } from 'node:crypto';

// ================= MELDUNGEN (Admin-Panel Phase 3, Board T25) =================
// Wer ein weitergegebenes Bild mit Spur-Wasserzeichen findet, prueft es in der App (watermark.js); bei
// einem Treffer kann er den Peer melden. An den Router gehen nur die Peer-ID des Empfaengers, die
// Trefferguete (Bits von 32) und eine optionale Notiz, nie das Bild (Regel 1). Der Router kann den Treffer
// nicht nachpruefen; das Panel zeigt das und wie viele verschiedene Peers denselben Peer gemeldet haben.
// Manuelle Meldung eines Nutzers (kind 'user'): mit Pflicht-Grund, bei 'other' mit Notiz. Ab USER_REPORT_HIDE
// verschiedenen Meldern wird der Peer im Grid ausgeblendet (wie "unsichtbar"), bis der Admin entscheidet;
// bestehende Chats laufen weiter. Der Router sieht nur IDs, Grund und Notiz, nie Chat-Inhalte.
const REPORT_KINDS = ['leak', 'user'];
export const USER_REPORT_REASONS = ['spam', 'harassment', 'sexual', 'sextortion', 'minor', 'scam', 'hate', 'violence', 'impersonation', 'other'];
// Dringend (T37): verlangt Nacktbilder bzw. erpresst damit. Blendet schon ab der Haelfte der Meldungen aus
// (aufgerundet, mindestens 2, damit eine einzelne boeswillige Meldung nicht reicht).
export const URGENT_REPORT_REASONS = ['sextortion'];

export function urgentHideThreshold(limit) {
    return limit > 0 ? Math.max(2, Math.ceil(limit / 2)) : 0;
}
const MAX_NOTE_LENGTH = 500;

export function parseUserReportHide(value) {
    const count = Math.floor(Number(value ?? 3));
    if (!Number.isFinite(count) || count < 0 || count > 100) throw new Error('USER_REPORT_HIDE must be 0-100 (0 = never hide)');
    return count;
}

// Fuer das automatische Ausblenden zaehlen nur Melder, deren Konto mindestens so alt ist (Schutz vor
// Wegwerf-Konten; ein Konto kostet nur einen Schluessel). Gespeichert wird jede Meldung.
export const REPORTER_MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;

export function registerReportRoutes(app, { store, allowRequest, requirePeerAuth, isString, log, hideAfter = () => 3, onHidden = () => {}, minAccountAgeMs = REPORTER_MIN_ACCOUNT_AGE_MS, now = Date.now }) {
    app.post('/api/reports', async (request, reply) => {
        const { peerId, reportedPeerId, kind = 'leak', matches, note, reason } = request.body || {};
        if (!isString(peerId, 200) || !isString(reportedPeerId, 200) || !REPORT_KINDS.includes(kind)) {
            return reply.code(400).send({ error: 'Invalid report' });
        }
        if (!requirePeerAuth(request, reply, peerId)) return reply;
        if (!allowRequest('reports', peerId, reply)) return reply;
        if (peerId === reportedPeerId) return reply.code(400).send({ error: 'Cannot report yourself' });
        const cleanNote = typeof note === 'string' ? note.trim().slice(0, MAX_NOTE_LENGTH) || null : null;
        let bits = null;
        if (kind === 'leak') {
            bits = Number(matches);
            if (!Number.isInteger(bits) || bits < 0 || bits > 32) return reply.code(400).send({ error: 'Invalid matches' });
        } else {
            if (!USER_REPORT_REASONS.includes(reason)) return reply.code(400).send({ error: 'A reason is required' });
            if (reason === 'other' && (!cleanNote || cleanNote.length < 3)) return reply.code(400).send({ error: 'Please describe the reason' });
        }
        // Dieselbe offene Meldung nicht doppelt.
        if (store.admin.hasOpenReport(peerId, reportedPeerId)) return { ok: true, duplicate: true };
        store.admin.addReport({
            id: randomUUID(),
            reporterId: peerId,
            reportedId: reportedPeerId,
            kind,
            reason: kind === 'user' ? reason : null,
            matches: bits,
            note: cleanNote
        });
        log.info('New report for the admin panel.');
        const limit = hideAfter();
        const reached = () => store.admin.openReporterCount(reportedPeerId, minAccountAgeMs, now()) >= limit
            || URGENT_REPORT_REASONS.some(urgent => limit > 0 && store.admin.openReporterCountFor(reportedPeerId, urgent, minAccountAgeMs, now()) >= Math.min(limit, urgentHideThreshold(limit)));
        if (kind === 'user' && limit > 0 && reached() && store.admin.hidePeer(reportedPeerId)) {
            log.info('A reported peer was hidden from the grid until the admin decides.');
            onHidden(reportedPeerId);
        }
        return { ok: true };
    });
}
