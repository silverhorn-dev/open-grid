// ================= GIFS (Board T34) =================
// Der Router ist kein Medienserver: er speichert keine GIF-Dateien und laedt nichts nach. Er
// - sagt den Clients, welche GIF-Quellen erlaubt sind (GIF_SOURCES: off | library | url | provider | Liste | any,
//   Standard any; 'provider' nur mit GIF_PROVIDER + Schluessel),
// - fuehrt eine Bibliothek aus GIF-URLs (nur URL, Titel, Masse), in die Nutzer externe GIFs vorschlagen;
//   mit GIF_LIBRARY_REVIEW (Standard an) erscheinen sie erst nach Freigabe im Admin-Panel.
// Im Chat geht nur die URL (E2E verschluesselt); die Clients laden das GIF selbst und halten es lokal.
// Anbieter (GIF_PROVIDER=klipy): Suche und Medien laufen nach dessen Regeln direkt vom Client (kein Router,
// kein Proxy, kein Cache), der Router gibt nur den App-Schluessel weiter.
// Melden: GIF_REPORT_HIDE Meldungen verschiedener Peers blenden ein Bibliotheks-GIF aus, bis der Admin entscheidet.

export const GIF_SOURCE_KINDS = ['library', 'url', 'provider'];
export const GIF_PROVIDERS = ['klipy'];
const PROVIDER_FILTERS = ['off', 'low', 'medium', 'high'];
const REPORTS_TO_HIDE = 3;
const MAX_URL_LENGTH = 1000;
const MAX_TITLE_LENGTH = 60;
const SUGGESTIONS_PER_DAY = 30;
const PAGE_SIZE = 40;

export function parseGifSources(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text || text === 'off' || text === 'none') return [];
    if (text === 'any' || text === 'all') return [...GIF_SOURCE_KINDS];
    const kinds = text.split(',').map(entry => entry.trim()).filter(Boolean);
    const unknown = kinds.filter(kind => !GIF_SOURCE_KINDS.includes(kind));
    if (unknown.length) throw new Error(`GIF_SOURCES: unknown source ${unknown.join(', ')} (off, library, url, provider, any)`);
    return GIF_SOURCE_KINDS.filter(kind => kinds.includes(kind));
}

// Anbieter fuer die GIF-Suche: { name, key, contentFilter } oder null (aus bzw. ohne Schluessel).
export function parseGifProvider({ name, key, contentFilter } = {}) {
    const provider = String(name ?? 'off').trim().toLowerCase();
    if (!provider || provider === 'off' || provider === 'none') return null;
    if (!GIF_PROVIDERS.includes(provider)) throw new Error(`GIF_PROVIDER: unknown provider ${provider} (off, ${GIF_PROVIDERS.join(', ')})`);
    const appKey = String(key ?? '').trim();
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(appKey)) return null;
    const filter = String(contentFilter ?? 'high').trim().toLowerCase();
    if (!PROVIDER_FILTERS.includes(filter)) throw new Error(`GIF_PROVIDER_FILTER must be one of ${PROVIDER_FILTERS.join(', ')}`);
    return { name: provider, key: appKey, contentFilter: filter };
}

// Medien eines Anbieters (z. B. static.klipy.com): nie in die Bibliothek, nie ueber den Proxy, nie gecacht.
export function isProviderMediaUrl(value) {
    try {
        return /(^|\.)klipy\.com$/i.test(new URL(value).hostname);
    } catch {
        return false;
    }
}

export function parseGifReview(value) {
    return !['0', 'false', 'off', 'no'].includes(String(value ?? 'true').trim().toLowerCase());
}

// Nur oeffentliche https-Adressen mit Hostnamen: keine IP-Adressen, kein localhost/LAN-Namen, keine
// Zugangsdaten, nur Port 443. Gleiche Regel im Client (client/app/gifs.js, gifUrlAllowed).
export function checkGifUrl(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_URL_LENGTH) return null;
    let url;
    try {
        url = new URL(value.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    const host = url.hostname.toLowerCase();
    if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    if (/(^|\.)(localhost|local|internal|lan|home|intranet|corp|test|invalid|example)$/.test(host)) return null;
    url.hash = '';
    return url.href;
}

function cleanTitle(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH) : '';
}

function cleanDimension(value) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) && number > 0 && number <= 4096 ? number : null;
}

export function createGifStore(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS gif_library (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL DEFAULT '',
            width INTEGER,
            height INTEGER,
            status TEXT NOT NULL,
            suggested_by TEXT,
            created_at INTEGER NOT NULL,
            approved_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS gif_library_status ON gif_library (status, approved_at);
        CREATE INDEX IF NOT EXISTS gif_library_suggester ON gif_library (suggested_by, created_at);
        CREATE TABLE IF NOT EXISTS gif_reports (
            gif_id INTEGER NOT NULL,
            peer_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (gif_id, peer_id),
            FOREIGN KEY (gif_id) REFERENCES gif_library (id) ON DELETE CASCADE
        );
    `);
    const columns = `id, url, title, width, height, status, suggested_by AS suggestedBy, created_at AS createdAt, approved_at AS approvedAt,
        (SELECT COUNT(*) FROM gif_reports WHERE gif_reports.gif_id = gif_library.id) AS reports`;
    const statements = {
        find: database.prepare(`SELECT ${columns} FROM gif_library WHERE id = ?`),
        findUrl: database.prepare(`SELECT ${columns} FROM gif_library WHERE url = ?`),
        insert: database.prepare('INSERT INTO gif_library (url, title, width, height, status, suggested_by, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
        approve: database.prepare("UPDATE gif_library SET status = 'approved', approved_at = COALESCE(approved_at, ?), title = COALESCE(?, title) WHERE id = ?"),
        clearReports: database.prepare('DELETE FROM gif_reports WHERE gif_id = ?'),
        addReport: database.prepare('INSERT OR IGNORE INTO gif_reports (gif_id, peer_id, created_at) VALUES (?, ?, ?)'),
        hide: database.prepare("UPDATE gif_library SET status = 'hidden' WHERE id = ? AND status = 'approved'"),
        remove: database.prepare('DELETE FROM gif_library WHERE id = ?'),
        suggestedSince: database.prepare('SELECT COUNT(*) AS count FROM gif_library WHERE suggested_by = ? AND created_at > ?'),
        listApproved: database.prepare(`SELECT ${columns} FROM gif_library WHERE status = 'approved' AND (? = '' OR title LIKE ? ESCAPE '\\') ORDER BY approved_at DESC, id DESC LIMIT ? OFFSET ?`),
        listStatus: database.prepare(`SELECT ${columns} FROM gif_library WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`),
        listReported: database.prepare(`SELECT ${columns} FROM gif_library WHERE id IN (SELECT gif_id FROM gif_reports) ORDER BY reports DESC, id DESC LIMIT ? OFFSET ?`),
        countReported: database.prepare('SELECT COUNT(DISTINCT gif_id) AS count FROM gif_reports'),
        countStatus: database.prepare('SELECT COUNT(*) AS count FROM gif_library WHERE status = ?')
    };
    return {
        list({ query = '', limit = PAGE_SIZE, offset = 0 } = {}) {
            const text = String(query || '').trim().slice(0, MAX_TITLE_LENGTH);
            const pattern = `%${text.replace(/[\\%_]/g, character => `\\${character}`)}%`;
            return statements.listApproved.all(text, pattern, limit, offset);
        },
        listByStatus(status, { limit = 200, offset = 0 } = {}) {
            return status === 'reported' ? statements.listReported.all(limit, offset) : statements.listStatus.all(status, limit, offset);
        },
        count(status) {
            return Number((status === 'reported' ? statements.countReported.get() : statements.countStatus.get(status)).count);
        },
        find(id) {
            return statements.find.get(Number(id)) || null;
        },
        findUrl(url) {
            return statements.findUrl.get(url) || null;
        },
        add({ url, title, width, height, suggestedBy, approved, now }) {
            const result = statements.insert.run(url, title, width, height, approved ? 'approved' : 'pending', suggestedBy, now, approved ? now : null);
            return statements.find.get(Number(result.lastInsertRowid));
        },
        // Freigeben (auch nach Meldungen: die Meldungen sind damit erledigt).
        approve(id, title, now) {
            statements.clearReports.run(Number(id));
            return Number(statements.approve.run(now, title ?? null, Number(id)).changes) > 0;
        },
        // Meldung eines Peers (einmal je GIF); ab REPORTS_TO_HIDE ausgeblendet. Liefert die Anzahl.
        report(id, peerId, now, hideAt = REPORTS_TO_HIDE) {
            statements.addReport.run(Number(id), peerId, now);
            const count = Number(statements.find.get(Number(id))?.reports || 0);
            if (count >= hideAt) statements.hide.run(Number(id));
            return count;
        },
        remove(id) {
            return Number(statements.remove.run(Number(id)).changes) > 0;
        },
        suggestedSince(peerId, since) {
            return Number(statements.suggestedSince.get(peerId, since).count);
        }
    };
}

const publicGif = gif => ({ id: gif.id, url: gif.url, title: gif.title, width: gif.width, height: gif.height });
const MAX_REPORTS_PER_DAY = 20;

export function registerGifRoutes(app, { gifs, settings, allowRequest, requirePeerAuth, isString, now = Date.now, log }) {
    const libraryOn = () => settings().sources.includes('library');

    // Freigegebene GIFs, optional nach Titel gefiltert; nur fuer angemeldete Peers.
    app.get('/api/gifs', async (request, reply) => {
        if (!libraryOn()) return reply.code(404).send({ error: 'GIF library is disabled' });
        const peerId = request.headers['x-peer-id'];
        if (!isString(peerId, 200)) return reply.code(400).send({ error: 'Missing peer id' });
        if (!allowRequest('gifs', peerId, reply)) return;
        if (!requirePeerAuth(request, reply, peerId)) return;
        const offset = Math.max(0, Math.min(100000, Math.floor(Number(request.query?.offset) || 0)));
        const list = gifs.list({ query: request.query?.q, limit: PAGE_SIZE + 1, offset });
        return {
            gifs: list.slice(0, PAGE_SIZE).map(publicGif),
            next: list.length > PAGE_SIZE ? offset + PAGE_SIZE : null
        };
    });

    // Externes GIF vorschlagen (bzw. direkt aufnehmen, wenn GIF_LIBRARY_REVIEW aus ist).
    app.post('/api/gifs', async (request, reply) => {
        if (!libraryOn()) return reply.code(404).send({ error: 'GIF library is disabled' });
        const { peerId, url, title, width, height } = request.body || {};
        if (!isString(peerId, 200)) return reply.code(400).send({ error: 'Invalid peerId' });
        if (!allowRequest('gifs', peerId, reply)) return;
        if (!requirePeerAuth(request, reply, peerId)) return;
        const checked = checkGifUrl(url);
        if (!checked) return reply.code(400).send({ error: 'Invalid GIF URL' });
        // Anbieter-Inhalte bleiben getrennt (Regeln des Anbieters).
        if (isProviderMediaUrl(checked)) return reply.code(400).send({ error: 'Provider GIFs cannot be added to the library' });
        const existing = gifs.findUrl(checked);
        if (existing) return { status: existing.status, gif: publicGif(existing) };
        const current = now();
        if (gifs.suggestedSince(peerId, current - 24 * 60 * 60 * 1000) >= SUGGESTIONS_PER_DAY) {
            return reply.code(429).send({ error: 'Too many suggestions today' });
        }
        const approved = !settings().review;
        const gif = gifs.add({ url: checked, title: cleanTitle(title), width: cleanDimension(width), height: cleanDimension(height), suggestedBy: peerId, approved, now: current });
        log?.info?.(`GIF library: ${approved ? 'added' : 'suggested'} #${gif.id}.`);
        return reply.code(201).send({ status: gif.status, gif: publicGif(gif) });
    });

    // Bibliotheks-GIF melden (per URL, die Nachricht kennt nur sie). Ab mehreren Meldungen ausgeblendet.
    const reportsToday = new Map();
    app.post('/api/gifs/report', async (request, reply) => {
        if (!libraryOn()) return reply.code(404).send({ error: 'GIF library is disabled' });
        const { peerId, url } = request.body || {};
        if (!isString(peerId, 200)) return reply.code(400).send({ error: 'Invalid peerId' });
        if (!allowRequest('gifs', peerId, reply)) return;
        if (!requirePeerAuth(request, reply, peerId)) return;
        const checked = checkGifUrl(url);
        const gif = checked ? gifs.findUrl(checked) : null;
        if (!gif) return reply.code(404).send({ error: 'Unknown GIF' });
        const day = Math.floor(now() / (24 * 60 * 60 * 1000));
        const key = `${day}:${peerId}`;
        if ((reportsToday.get(key) || 0) >= MAX_REPORTS_PER_DAY) return reply.code(429).send({ error: 'Too many reports today' });
        reportsToday.set(key, (reportsToday.get(key) || 0) + 1);
        if (reportsToday.size > 10000) reportsToday.clear();
        gifs.report(gif.id, peerId, now(), settings().reportsToHide);
        log?.info?.(`GIF library: #${gif.id} reported.`);
        return { ok: true };
    });
}

// Admin-Panel: Vorschlaege freigeben, Eintraege entfernen (Aufruf aus server/admin.js).
export function registerGifAdminRoutes(app, { gifs, requireAdmin, now = Date.now, log }) {
    app.get('/api/admin/gifs', async (request, reply) => {
        if (!requireAdmin(request, reply)) return reply;
        const status = ['approved', 'reported', 'hidden'].includes(request.query?.status) ? request.query.status : 'pending';
        return { status, gifs: gifs.listByStatus(status), pending: gifs.count('pending'), approved: gifs.count('approved'), reported: gifs.count('reported') };
    });

    app.post('/api/admin/gifs/:id', async (request, reply) => {
        if (!requireAdmin(request, reply, { change: true })) return reply;
        const gif = gifs.find(request.params.id);
        if (!gif) return reply.code(404).send({ error: 'Unknown GIF' });
        const action = request.body?.action;
        if (action === 'approve') {
            gifs.approve(gif.id, typeof request.body?.title === 'string' ? cleanTitle(request.body.title) : null, now());
        } else if (action === 'remove') {
            gifs.remove(gif.id);
        } else {
            return reply.code(400).send({ error: 'Invalid action' });
        }
        log?.info?.(`Admin panel: GIF #${gif.id} ${action === 'approve' ? 'approved' : 'removed'}.`);
        return { ok: true };
    });
}
