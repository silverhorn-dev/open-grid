// Android-App (documentation/ANDROID-APP.md): APK-Download vom Router, Signatur-Fingerabdruecke und
// Digital Asset Links (/.well-known/assetlinks.json), damit Android die App dem Router zuordnet.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

export const ANDROID_APP_PACKAGE = 'org.opengrid.app';
// Fingerabdruecke (SHA-256 des Signatur-Zertifikats) der vom Projekt signierten APKs. Leer, bis es
// einen Release-Schluessel gibt; Betreiber tragen eigene Schluessel ueber ANDROID_APP_SIGNERS ein.
export const PROJECT_APP_SIGNERS = Object.freeze([]);
export const MAX_APP_SIGNERS = 20;
const METADATA_TTL_MS = 60 * 1000;

// "ab:cd:..." oder 64 Hex-Zeichen -> "AB:CD:..." (Schreibweise von assetlinks.json und apksigner).
export function normalizeSignerFingerprint(value) {
    const hex = String(value ?? '').trim().replace(/[\s:]/g, '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(hex)) return null;
    return hex.match(/.{2}/g).join(':');
}

// JSON-Liste oder Komma-Text; leer = keine eigenen Schluessel. Ungueltige Eintraege sind ein Fehler.
export function parseAppSigners(value) {
    if (value === null || value === undefined) return [];
    let entries = value;
    if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return [];
        if (text.startsWith('[') || text.startsWith('{')) {
            try {
                entries = JSON.parse(text);
            } catch {
                throw new Error('ANDROID_APP_SIGNERS must be a JSON list or comma separated');
            }
        } else {
            entries = text.split(',');
        }
    }
    if (!Array.isArray(entries)) throw new Error('ANDROID_APP_SIGNERS must be a list');
    const signers = [];
    for (const entry of entries) {
        if (String(entry ?? '').trim() === '') continue;
        const fingerprint = normalizeSignerFingerprint(entry);
        if (!fingerprint) throw new Error(`ANDROID_APP_SIGNERS: invalid SHA-256 fingerprint "${String(entry).slice(0, 80)}"`);
        if (!signers.includes(fingerprint)) signers.push(fingerprint);
    }
    if (signers.length > MAX_APP_SIGNERS) throw new Error(`ANDROID_APP_SIGNERS: at most ${MAX_APP_SIGNERS} entries`);
    return signers;
}

// Projekt-Schluessel zuerst, danach die des Betreibers, ohne Doppelte.
export function effectiveAppSigners(configured) {
    return [...new Set([...PROJECT_APP_SIGNERS, ...configured])];
}

// Ohne Schluessel keine Datei: eine leere Zuordnung waere nur verwirrend.
export function buildAssetLinks(signers, packageName = ANDROID_APP_PACKAGE) {
    if (!signers.length) return null;
    return [{
        relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
        target: { namespace: 'android_app', package_name: packageName, sha256_cert_fingerprints: signers }
    }];
}

// APK + optionale Begleitdatei `<apk>.json` ({ versionCode, versionName }), vom Build geschrieben.
// Fehlt die Begleitdatei, gibt es nur Groesse und Pruefsumme; fehlt das APK, ist `available` false.
export function createApkSource(apkPath, { now = Date.now } = {}) {
    let cached = null;
    let cachedAt = 0;
    async function describe() {
        if (cached && now() - cachedAt < METADATA_TTL_MS) return cached;
        cachedAt = now();
        try {
            const info = await stat(apkPath);
            if (!info.isFile()) throw new Error('not a file');
            if (cached?.available && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
            const sha256 = createHash('sha256').update(await readFile(apkPath)).digest('hex');
            const meta = await readFile(`${apkPath}.json`, 'utf8').then(JSON.parse).catch(() => ({}));
            const versionCode = Number.isSafeInteger(meta.versionCode) && meta.versionCode > 0 ? meta.versionCode : null;
            const versionName = typeof meta.versionName === 'string' ? meta.versionName.slice(0, 40) : null;
            cached = { available: true, size: info.size, mtimeMs: info.mtimeMs, sha256, versionCode, versionName };
        } catch {
            cached = { available: false };
        }
        return cached;
    }
    return {
        describe,
        // Fuer /api/config: nur, was die App fuer den Update-Vergleich braucht.
        async publicInfo() {
            const info = await describe();
            if (!info.available) return { available: false };
            return { available: true, url: '/app/opengrid.apk', versionCode: info.versionCode, versionName: info.versionName, sha256: info.sha256, size: info.size };
        },
        stream: () => createReadStream(apkPath)
    };
}

export function registerAndroidAppRoutes(app, { apkSource, signers }) {
    app.get('/app/opengrid.apk', async (_request, reply) => {
        const info = await apkSource.describe();
        if (!info.available) return reply.code(404).send({ error: 'Not found' });
        return reply
            .type('application/vnd.android.package-archive')
            .header('Content-Disposition', 'attachment; filename="opengrid.apk"')
            .header('Content-Length', String(info.size))
            .header('Cache-Control', 'no-cache')
            .header('ETag', `"${info.sha256}"`)
            .send(apkSource.stream());
    });
    app.get('/.well-known/assetlinks.json', async (_request, reply) => {
        const links = buildAssetLinks(signers());
        if (!links) return reply.code(404).send({ error: 'Not found' });
        return reply.type('application/json; charset=utf-8').header('Cache-Control', 'no-cache').send(links);
    });
}
