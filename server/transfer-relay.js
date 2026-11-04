// ================= UMZUGS-RELAY (Board T31, Phase 2) =================
// Die alte Kopie laedt ihr Umzugs-Buendel hoch, verschluesselt mit einem Schluessel, den der Router nie sieht
// (er steht nur im Code bzw. im URL-Fragment). Der Router haelt das Chiffrat auf der Platte (nicht im RAM),
// hoechstens TRANSFER_TTL_MS lang und gibt es genau einmal heraus; danach ist es weg.
// Sichtbar fuer den Router: zufaellige Transfer-ID, Groesse, Zeitpunkt von Upload und Abholung.
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const TRANSFER_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_MB = 50;
// Alle offenen Transfers zusammen (Platte), damit ein Router nicht vollaeuft.
const TOTAL_LIMIT_FACTOR = 4;
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function parseTransferMaxBytes(value) {
    const megabytes = Number(value);
    const clamped = Number.isFinite(megabytes) && megabytes > 0 ? Math.min(megabytes, 500) : DEFAULT_MAX_MB;
    return Math.round(clamped * 1024 * 1024);
}

export async function registerTransferRelay(app, { dataDirectory, allowRequest, requirePeerAuth, isString, maxBytes, now = Date.now, log }) {
    const directory = join(dataDirectory, 'transfers');
    await mkdir(directory, { recursive: true });
    // id -> { ownerId, size, expiresAt }; Inhalt nur als Datei.
    const open = new Map();
    // Reste eines frueheren Laufs (Neustart) sind ohne Metadaten wertlos.
    for (const name of await readdir(directory).catch(() => [])) await rm(join(directory, name), { force: true });

    const fileOf = id => join(directory, id);
    async function remove(id) {
        open.delete(id);
        await rm(fileOf(id), { force: true });
    }
    async function purgeExpired() {
        const current = now();
        for (const [id, entry] of open) if (entry.expiresAt <= current) await remove(id);
    }
    const timer = setInterval(() => purgeExpired().catch(error => log.warn(`Transfer cleanup failed: ${error.message}`)), 60 * 1000);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));

    // Rohes Chiffrat, kein JSON-Parsing grosser Koerper.
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: maxBytes }, (_request, body, done) => done(null, body));

    app.post('/api/transfer', { bodyLimit: maxBytes }, async (request, reply) => {
        const ownerId = request.headers['x-peer-id'];
        if (!isString(ownerId, 200)) return reply.code(400).send({ error: 'Missing peer id' });
        if (!allowRequest('transfer', ownerId, reply)) return;
        if (!requirePeerAuth(request, reply, ownerId)) return;
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'Missing payload' });
        await purgeExpired();
        // Je Peer nur ein offener Transfer: ein neuer ersetzt den alten.
        for (const [id, entry] of open) if (entry.ownerId === ownerId) await remove(id);
        const total = [...open.values()].reduce((sum, entry) => sum + entry.size, 0);
        if (total + body.length > maxBytes * TOTAL_LIMIT_FACTOR) return reply.code(507).send({ error: 'Transfer storage is full' });
        const id = randomBytes(16).toString('base64url');
        await writeFile(fileOf(id), body);
        const expiresAt = now() + TRANSFER_TTL_MS;
        open.set(id, { ownerId, size: body.length, expiresAt });
        return reply.code(201).send({ id, expiresAt });
    });

    // Abholen ohne Anmeldung (das neue Geraet hat noch keine); die ID ist 128 Bit zufaellig.
    app.get('/api/transfer/:id', async (request, reply) => {
        if (!allowRequest('transfer', request.ip, reply)) return;
        const { id } = request.params;
        if (!TRANSFER_ID_PATTERN.test(id)) return reply.code(404).send({ error: 'Unknown transfer' });
        const entry = open.get(id);
        if (!entry || entry.expiresAt <= now()) {
            if (entry) await remove(id);
            return reply.code(404).send({ error: 'Unknown transfer' });
        }
        // Genau einmal: sofort aus der Liste, die Datei nach dem Senden loeschen.
        open.delete(id);
        const size = (await stat(fileOf(id)).catch(() => null))?.size;
        if (!size) return reply.code(404).send({ error: 'Unknown transfer' });
        const stream = createReadStream(fileOf(id));
        stream.on('close', () => rm(fileOf(id), { force: true }).catch(() => {}));
        return reply.header('Cache-Control', 'no-store').type('application/octet-stream').header('Content-Length', String(size)).send(stream);
    });

    // Absender bricht ab (oder raeumt nach erfolgreichem Umzug auf).
    app.delete('/api/transfer/:id', async (request, reply) => {
        const ownerId = request.headers['x-peer-id'];
        if (!isString(ownerId, 200)) return reply.code(400).send({ error: 'Missing peer id' });
        if (!requirePeerAuth(request, reply, ownerId)) return;
        const entry = open.get(request.params.id);
        if (entry?.ownerId === ownerId) await remove(request.params.id);
        return reply.code(204).send();
    });

    return { openTransfers: () => open.size, purgeExpired };
}
