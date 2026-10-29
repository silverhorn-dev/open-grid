import { randomUUID } from 'node:crypto';

// ================= MELDUNGEN (Admin-Panel Phase 3, Board T25) =================
// Wer ein weitergegebenes Bild mit Spur-Wasserzeichen findet, prueft es in der App (watermark.js); bei
// einem Treffer kann er den Peer melden. An den Router gehen nur die Peer-ID des Empfaengers, die
// Trefferguete (Bits von 32) und eine optionale Notiz, nie das Bild (Regel 1). Der Router kann den Treffer
// nicht nachpruefen; das Panel zeigt das und wie viele verschiedene Peers denselben Peer gemeldet haben.
const REPORT_KINDS = ['leak'];
const MAX_NOTE_LENGTH = 500;

export function registerReportRoutes(app, { store, allowRequest, requirePeerAuth, isString, log }) {
    app.post('/api/reports', async (request, reply) => {
        const { peerId, reportedPeerId, kind = 'leak', matches, note } = request.body || {};
        if (!isString(peerId, 200) || !isString(reportedPeerId, 200) || !REPORT_KINDS.includes(kind)) {
            return reply.code(400).send({ error: 'Invalid report' });
        }
        if (!requirePeerAuth(request, reply, peerId)) return reply;
        if (!allowRequest('reports', peerId, reply)) return reply;
        if (peerId === reportedPeerId) return reply.code(400).send({ error: 'Cannot report yourself' });
        const bits = Number(matches);
        if (!Number.isInteger(bits) || bits < 0 || bits > 32) return reply.code(400).send({ error: 'Invalid matches' });
        // Dieselbe offene Meldung nicht doppelt.
        if (store.admin.hasOpenReport(peerId, reportedPeerId)) return { ok: true, duplicate: true };
        store.admin.addReport({
            id: randomUUID(),
            reporterId: peerId,
            reportedId: reportedPeerId,
            kind,
            matches: bits,
            note: typeof note === 'string' ? note.trim().slice(0, MAX_NOTE_LENGTH) || null : null
        });
        log.info('New report for the admin panel.');
        return { ok: true };
    });
}
