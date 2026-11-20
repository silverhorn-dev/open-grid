// ================= STICKER: ROUTER (Board T39) =================
// S2 Ausschneiden: U^2-Net-p (xuebinqin/U-2-Net, Apache-2.0; ONNX aus rembg, MIT) rechnet im Browser
// (client/app/sticker-worker.js, onnxruntime-web WASM); der Router liefert Modell und Laufzeit nur aus.
// Modell: STICKER_MODEL_DIR (Standard data/sticker-models, sonst models/stickers im Image) mit u2netp.onnx.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { packageRoot, packageVersion } from './nudity-model.js';

export const CUTOUT_MODEL_FILE = 'u2netp.onnx';

export function findCutoutModel(directories) {
    return directories.filter(Boolean).map(directory => join(directory, CUTOUT_MODEL_FILE)).find(path => existsSync(path)) || null;
}

const immutable = reply => reply.header('cache-control', 'public, max-age=31536000, immutable');

// Laufzeit (onnxruntime-web aus node_modules) + Modell unter /vendor/stickers/<ort-version>/; null ohne beides.
export async function registerCutoutAssets(app, modelPath) {
    const require = createRequire(import.meta.url);
    const ortRoot = packageRoot(require, 'onnxruntime-web');
    if (!ortRoot || !modelPath) return null;
    const base = `/vendor/stickers/${await packageVersion(ortRoot)}/`;
    const files = {
        'ort.wasm.min.js': 'text/javascript; charset=utf-8',
        'ort-wasm-simd-threaded.mjs': 'text/javascript; charset=utf-8',
        'ort-wasm-simd-threaded.wasm': 'application/wasm'
    };
    for (const [file, type] of Object.entries(files)) {
        app.get(`${base}${file}`, async (_request, reply) => {
            immutable(reply).type(type);
            return readFile(join(ortRoot, 'dist', file));
        });
    }
    app.get(`${base}${CUTOUT_MODEL_FILE}`, async (_request, reply) => {
        immutable(reply).type('application/octet-stream');
        return readFile(modelPath);
    });
    return { library: `${base}ort.wasm.min.js`, runtimeUrl: base, modelUrl: `${base}${CUTOUT_MODEL_FILE}`, sizeMb: 4.6 };
}

// ================= S3: PAKETE VOM ROUTER =================
// Der Betreiber laedt im Admin-Panel Sticker-Pakete hoch (PNG/WebP mit Transparenz, je hoechstens 60.000 Zeichen als
// Data-URL, die Umwandlung macht das Admin-Panel). Gespeichert in SQLite (kein Dateisystem, keine fremden Dienste).
// Ein Paket kann 18+ sein (dann jeder Sticker darin); die App blendet solche Pakete fuer unter 18 aus.
export const STICKER_MAX_LENGTH = 60000;
export const STICKERS_PER_PACK = 120;
export const STICKER_PACKS_MAX = 50;
const STICKER_DATA = /^data:image\/(?:png|webp);base64,[A-Za-z0-9+/=]+$/;

export function createStickerStore(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS sticker_packs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            adult INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sticker_items (
            pack_id TEXT NOT NULL,
            id TEXT NOT NULL,
            data TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (pack_id, id)
        );
    `);
    const statements = {
        packs: database.prepare(`SELECT p.id, p.name, p.adult, p.created_at AS createdAt, COUNT(i.id) AS count
            FROM sticker_packs p LEFT JOIN sticker_items i ON i.pack_id = p.id GROUP BY p.id ORDER BY p.created_at`),
        pack: database.prepare('SELECT id, name, adult FROM sticker_packs WHERE id = ?'),
        items: database.prepare('SELECT id, data, sha256, width AS w, height AS h FROM sticker_items WHERE pack_id = ? ORDER BY position'),
        insertPack: database.prepare('INSERT INTO sticker_packs (id, name, adult, created_at) VALUES (?, ?, ?, ?)'),
        insertItem: database.prepare('INSERT OR IGNORE INTO sticker_items (pack_id, id, data, sha256, width, height, position) VALUES (?, ?, ?, ?, ?, ?, ?)'),
        deletePack: database.prepare('DELETE FROM sticker_packs WHERE id = ?'),
        deleteItems: database.prepare('DELETE FROM sticker_items WHERE pack_id = ?'),
        deleteItem: database.prepare('DELETE FROM sticker_items WHERE pack_id = ? AND id = ?'),
        countPacks: database.prepare('SELECT COUNT(*) AS count FROM sticker_packs')
    };
    return {
        listPacks: () => statements.packs.all().map(pack => ({ ...pack, adult: pack.adult === 1 })),
        getPack(id) {
            const pack = statements.pack.get(id);
            return pack ? { id: pack.id, name: pack.name, adult: pack.adult === 1, stickers: statements.items.all(id) } : null;
        },
        createPack({ id, name, adult, items, now }) {
            database.exec('BEGIN');
            try {
                statements.insertPack.run(id, name, adult ? 1 : 0, now);
                items.forEach((item, position) => statements.insertItem.run(id, item.id, item.data, item.sha256, item.w, item.h, position));
                database.exec('COMMIT');
            } catch (error) {
                database.exec('ROLLBACK');
                throw error;
            }
        },
        deletePack(id) {
            statements.deleteItems.run(id);
            return statements.deletePack.run(id).changes > 0;
        },
        deleteSticker: (packId, id) => statements.deleteItem.run(packId, id).changes > 0,
        count: () => statements.countPacks.get().count
    };
}

const stickerSha = data => createHash('sha256').update(data).digest('base64');
const stickerId = sha256 => `stk_${sha256.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;

// Eingabe aus dem Admin-Panel pruefen; null = ungueltig.
export function cleanStickerItem(item) {
    const size = value => Number.isInteger(value) && value > 0 && value <= 1024;
    if (!item || typeof item.data !== 'string' || item.data.length > STICKER_MAX_LENGTH || !STICKER_DATA.test(item.data) || !size(item.w) || !size(item.h)) return null;
    const sha256 = stickerSha(item.data);
    return { id: stickerId(sha256), data: item.data, sha256, w: item.w, h: item.h };
}

export function registerStickerRoutes(app, { stickers, allowRequest }) {
    // Liste fuer die App (ohne Bilddaten).
    app.get('/api/stickers', async (request, reply) => {
        if (!allowRequest('gifs', request.ip, reply)) return reply;
        reply.header('cache-control', 'no-store');
        return { packs: stickers.listPacks().map(({ id, name, adult, count }) => ({ id, name, adult, count })) };
    });
    // Ein Paket mit Bildern; Data-URLs, damit der Sticker so in die Nachricht geht.
    app.get('/api/stickers/:packId', async (request, reply) => {
        if (!allowRequest('gifs', request.ip, reply)) return reply;
        const pack = typeof request.params.packId === 'string' && request.params.packId.length <= 64 ? stickers.getPack(request.params.packId) : null;
        if (!pack) return reply.code(404).send({ error: 'Not found' });
        reply.header('cache-control', 'private, max-age=300');
        return { ...pack, stickers: pack.stickers.map(sticker => ({ ...sticker, ...(pack.adult ? { adult: true } : {}) })) };
    });
}

export function registerStickerAdminRoutes(app, { stickers, requireAdmin, now = Date.now, log }) {
    app.get('/api/admin/stickers', async (request, reply) => {
        if (!requireAdmin(request, reply)) return reply;
        return { packs: stickers.listPacks() };
    });
    app.post('/api/admin/stickers', { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
        if (!requireAdmin(request, reply, { change: true })) return reply;
        const { name, adult, items } = request.body || {};
        const cleanName = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
        if (!cleanName || !Array.isArray(items) || !items.length || items.length > STICKERS_PER_PACK) return reply.code(400).send({ error: 'Invalid pack' });
        if (stickers.count() >= STICKER_PACKS_MAX) return reply.code(400).send({ error: 'Too many packs' });
        const cleaned = items.map(cleanStickerItem);
        if (cleaned.some(item => !item)) return reply.code(400).send({ error: 'Invalid sticker' });
        const id = `pack_${randomUUID().slice(0, 12)}`;
        stickers.createPack({ id, name: cleanName, adult: adult === true, items: cleaned, now: now() });
        log.info(`Admin panel: sticker pack "${cleanName}" with ${cleaned.length} sticker(s) added.`);
        return { ok: true, id };
    });
    app.delete('/api/admin/stickers/:packId', async (request, reply) => {
        if (!requireAdmin(request, reply, { change: true })) return reply;
        const removed = stickers.deletePack(String(request.params.packId || ''));
        if (removed) log.info('Admin panel: sticker pack removed.');
        return { ok: removed };
    });
}
