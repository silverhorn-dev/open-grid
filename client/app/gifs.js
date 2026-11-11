// ================= GIFS (Board T34) =================
// GIFs liegen auf fremden https-Servern. Im Chat geht nur die URL (E2E verschluesselt), jeder Client laedt
// das GIF selbst; der Router ist kein Medienserver. Quellen erlaubt der Router (`/api/config` gifs.sources):
// - 'library': Bibliothek des Routers (nur URLs, server/gifs.js), Vorschlaege mit Freigabe im Admin-Panel,
// - 'url': beliebige eingefuegte GIF-URLs ("extern"),
// - 'provider': Anbieter-Suche (Klipy). Nach dessen Regeln laufen Suche und Medien direkt vom Client (nie ueber
//   Router oder Proxy), Medien werden nicht gecacht, Ergebnisse in eigenem Reiter und unveraendert, Suchfeld
//   "Search KLIPY".
// Proxy (Router `gifs.proxy`, standardmaessig aus): Bibliotheks- und Link-GIFs laden dann ueber /api/gif-proxy.
// Beim Nutzer standardmaessig aus (`keys`/`gif-settings`, Router-Standard `CLIENT_DEFAULTS.gifs`/`gifsExternal`):
// ohne Freigabe zeigt eine empfangene Nachricht nur eine verschwommene Flaeche mit "GIF-Integration aktivieren?",
// geladen wird erst nach Bestaetigung (der fremde Server sieht sonst die IP).
// Lokaler Cache: der Service Worker legt geladene GIF-Bilder in Cache Storage `opengrid-gifs` (sw.js); hier
// steht, welche URLs bleiben (gesendet/empfangen nach `gifKeepDays`, Favoriten immer), der Rest wird geraeumt.
const GIF_SETTINGS_RECORD_ID = 'gif-settings';
const GIF_INDEX_RECORD_ID = 'gif-cache';
const GIF_FAVORITES_RECORD_ID = 'gif-favorites';
const GIF_RECENT_RECORD_ID = 'gif-recent';
const GIF_CACHE_NAME = 'opengrid-gifs';
const GIF_RECENT_MAX = 40;
const GIF_FAVORITES_MAX = 500;
const GIF_KEEP_OPTIONS = [0, 90, 30, 7];
const GIF_DAY_MS = 24 * 60 * 60 * 1000;

const gifState = { settings: {}, favorites: [], recent: [], index: {}, loaded: false };

// ----- Reine Hilfen (test/gifs.test.js) -----
// Gleiche Regel wie checkGifUrl in server/gifs.js: nur https mit Hostnamen, keine IPs/LAN-Namen/Zugangsdaten.
function gifUrlAllowed(value) {
    if (typeof value !== 'string' || !value || value.length > 1000) return null;
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

function isGifVideoUrl(url) {
    try {
        return /\.(mp4|webm)$/i.test(new URL(url).pathname);
    } catch {
        return false;
    }
}

// Sieht ein eingefuegter Link wie ein GIF aus? Endung (gif, webp, mp4, webm) oder bekannte GIF-Dienste.
// Auch normale Bild-Links (png, jpg, avif), wie sie z. B. Discord-Anhaenge oft haben.
function looksLikeGifUrl(value) {
    const url = gifUrlAllowed(value);
    if (!url) return false;
    const { hostname, pathname } = new URL(url);
    return /\.(gif|gifv|webp|mp4|webm|png|jpe?g|avif)$/i.test(pathname) || /(^|\.)(giphy\.com|tenor\.com|klipy\.com)$/i.test(hostname);
}

// Discord-Anhaenge sind signiert und laufen ab (`ex` = Ablauf als Hex-Sekunden); danach antwortet Discord mit 404.
function discordLinkExpired(value, now = Date.now()) {
    try {
        const url = new URL(value);
        if (!/(^|\.)(discordapp\.(com|net)|discord\.com)$/i.test(url.hostname)) return false;
        const expires = parseInt(url.searchParams.get('ex') || '', 16);
        return Number.isFinite(expires) && expires * 1000 < now;
    } catch {
        return false;
    }
}

function isValidGifInfo(gif) {
    return Boolean(gif) && typeof gif === 'object' && Boolean(gifUrlAllowed(gif.url)) && gifUrlAllowed(gif.url) === gif.url
        && ['library', 'url', 'provider'].includes(gif.source)
        && (gif.w === undefined || (Number.isInteger(gif.w) && gif.w > 0 && gif.w <= 4096))
        && (gif.h === undefined || (Number.isInteger(gif.h) && gif.h > 0 && gif.h <= 4096));
}

// Was eine GIF-Nachricht zeigt: 'show', 'enable' (Integration aus), 'external' (externe URLs aus), 'off' (Router).
function gifDisplayState(gif, { mine = false, sources = [], enabled = false, external = false } = {}) {
    if (!isValidGifInfo(gif) || !sources.length) return 'off';
    if ((gif.source === 'url' || gif.source === 'provider') && !sources.includes(gif.source)) return 'off';
    if (mine) return 'show';
    if (!enabled) return 'enable';
    if (gif.source === 'url' && !external) return 'external';
    return 'show';
}

// Welche gecachten URLs bleiben: Favoriten immer, sonst nach Alter (0 = so lange wie moeglich).
function gifKeepUrl(url, { index = {}, favorites = new Set(), keepDays = 0, now = Date.now() } = {}) {
    if (favorites.has(url)) return true;
    const entry = index[url];
    if (!entry) return false;
    return !keepDays || now - entry.at < keepDays * GIF_DAY_MS;
}

// Anbieter-Medien (Klipy): nie Proxy, nie Cache (Regeln des Anbieters). Gleiche Regel in server/gifs.js und sw.js.
function isProviderMediaUrl(url) {
    try {
        return /(^|\.)klipy\.com$/i.test(new URL(url).hostname);
    } catch {
        return false;
    }
}

// Ein Anbieter-Ergebnis -> GIF-Info (kleine Variante; Reihenfolge der Formate: webp, gif, mp4). Werbung: null.
function providerGifInfo(item) {
    if (!item || item.type === 'ad') return null;
    for (const size of ['sm', 'md', 'xs']) {
        for (const format of ['webp', 'gif', 'mp4']) {
            const file = item.file?.[size]?.[format];
            const url = gifUrlAllowed(file?.url);
            if (!url || !isProviderMediaUrl(url)) continue;
            const dimension = value => (Number.isInteger(value) && value > 0 && value <= 4096 ? value : undefined);
            const info = { url, source: 'provider', w: dimension(file.width), h: dimension(file.height) };
            if (info.w === undefined) delete info.w;
            if (info.h === undefined) delete info.h;
            if (typeof item.title === 'string' && item.title) info.title = item.title.slice(0, 60);
            return info;
        }
    }
    return null;
}

// Bild-URL: ueber den Proxy des Routers, wenn er an ist (nie fuer Anbieter-Medien), sonst direkt.
function gifProxySrc(url, { proxy = false, token = null } = {}) {
    if (!proxy || !token || isProviderMediaUrl(url)) return url;
    return `/api/gif-proxy?url=${encodeURIComponent(url)}&t=${encodeURIComponent(token)}`;
}

// ----- Einstellungen -----
function gifSources() {
    return Array.isArray(state.appConfig?.gifs?.sources) ? state.appConfig.gifs.sources : [];
}

function gifComposeAvailable() {
    return gifSources().length > 0;
}

function gifSetting(key) {
    const stored = gifState.settings[key];
    if (key === 'keepDays') return GIF_KEEP_OPTIONS.includes(stored) ? stored : clientDefault('gifKeepDays', 0);
    if (typeof stored === 'boolean') return stored;
    return clientDefault(key === 'enabled' ? 'gifs' : 'gifsExternal', false) === true;
}

async function loadGifState() {
    const [settings, favorites, recent, index] = await Promise.all([GIF_SETTINGS_RECORD_ID, GIF_FAVORITES_RECORD_ID, GIF_RECENT_RECORD_ID, GIF_INDEX_RECORD_ID]
        .map(id => databaseRequest('keys', 'readonly', store => store.get(id)).catch(() => null)));
    gifState.settings = settings || {};
    gifState.favorites = Array.isArray(favorites?.items) ? favorites.items.filter(isValidGifInfo) : [];
    gifState.recent = Array.isArray(recent?.items) ? recent.items.filter(isValidGifInfo) : [];
    gifState.index = index?.entries && typeof index.entries === 'object' ? index.entries : {};
    gifState.loaded = true;
    if (state.appConfig?.gifs?.proxy) await refreshGifProxyToken().catch(() => null);
    renderGifSettings();
    cleanupGifCache().catch(logBackgroundError('loadGifState'));
}

function renderGifSettings() {
    const card = document.getElementById('gif-settings-card');
    if (card) card.classList.toggle('hidden', !gifComposeAvailable());
    const enabled = document.getElementById('gif-enabled-toggle');
    if (enabled) enabled.checked = gifSetting('enabled');
    const external = document.getElementById('gif-external-toggle');
    if (external) {
        external.checked = gifSetting('external');
        external.closest('.setting-row')?.classList.toggle('hidden', !gifSources().includes('url'));
    }
    const keep = document.getElementById('gif-keep-select');
    if (keep) keep.value = String(gifSetting('keepDays'));
}

async function refreshGifProxyToken() {
    const response = await fetch(`${API_BASE}/api/gif-proxy/token`, { headers: peerAuthHeaders({ 'X-Peer-Id': state.myProfile.id }) });
    const data = response.ok ? await response.json().catch(() => null) : null;
    gifState.proxyToken = typeof data?.token === 'string' ? data.token : null;
    return gifState.proxyToken;
}

function gifMediaSrc(url) {
    return gifProxySrc(url, { proxy: Boolean(state.appConfig?.gifs?.proxy), token: gifState.proxyToken });
}

async function updateGifSetting(key, value) {
    if (key === 'keepDays') value = Number(value);
    else value = Boolean(value);
    gifState.settings = { ...gifState.settings, [key]: value };
    // Externe URLs gehen nur mit eingeschalteter Integration.
    if (key === 'external' && value) gifState.settings.enabled = true;
    if (key === 'enabled' && !value) gifState.settings.external = false;
    await putDatabaseRecord('keys', { id: GIF_SETTINGS_RECORD_ID, ...gifState.settings })
        .catch(error => logDebug(`Could not store GIF settings: ${error.message}`));
    renderGifSettings();
    if (key === 'keepDays') cleanupGifCache().catch(logBackgroundError('updateGifSetting'));
    if (state.activeChatPeerId) renderChatHistory();
}

// Tipp auf die verschwommene Flaeche: Systemdialog, dann einschalten.
async function enableGifsFromPrompt(kind) {
    const external = kind === 'external';
    if (!window.confirm((external ? t('gifs.confirmExternal') : t('gifs.confirmEnable')))) return false;
    await updateGifSetting(external ? 'external' : 'enabled', true);
    return true;
}

// ----- Merken: zuletzt benutzt, Favoriten, Cache-Index -----
async function saveGifList(id, items) {
    await putDatabaseRecord('keys', { id, items }).catch(error => logDebug(`Could not store GIF list: ${error.message}`));
}

function gifListEntry(gif) {
    return { url: gif.url, source: gif.source, ...(gif.w ? { w: gif.w } : {}), ...(gif.h ? { h: gif.h } : {}), ...(gif.title ? { title: String(gif.title).slice(0, 60) } : {}) };
}

async function rememberRecentGif(gif) {
    gifState.recent = [gifListEntry(gif), ...gifState.recent.filter(item => item.url !== gif.url)].slice(0, GIF_RECENT_MAX);
    await saveGifList(GIF_RECENT_RECORD_ID, gifState.recent);
}

function isFavoriteGif(url) {
    return gifState.favorites.some(item => item.url === url);
}

async function toggleFavoriteGif(gif) {
    const favorite = !isFavoriteGif(gif.url);
    gifState.favorites = favorite
        ? [gifListEntry(gif), ...gifState.favorites].slice(0, GIF_FAVORITES_MAX)
        : gifState.favorites.filter(item => item.url !== gif.url);
    await saveGifList(GIF_FAVORITES_RECORD_ID, gifState.favorites);
    if (favorite) await markGifCached(gif.url, 'favorite');
    showToast((favorite ? t('gifs.favoriteAdded') : t('gifs.favoriteRemoved')), 'info');
    return favorite;
}

async function markGifCached(url, kind) {
    // Anbieter-Medien werden nicht gecacht (Regeln des Anbieters); Favoriten merken nur die URL.
    if (isProviderMediaUrl(url)) return;
    const previous = gifState.index[url];
    gifState.index[url] = { at: Date.now(), kind: previous?.kind === 'favorite' ? 'favorite' : kind };
    await putDatabaseRecord('keys', { id: GIF_INDEX_RECORD_ID, entries: gifState.index }).catch(() => {});
}

// Raeumt Cache Storage nach den Regeln oben (auch Vorschaubilder aus der Bibliothek, die nie gesendet wurden).
async function cleanupGifCache() {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(GIF_CACHE_NAME);
    const favorites = new Set(gifState.favorites.map(item => item.url));
    const keepDays = gifSetting('keepDays');
    const now = Date.now();
    for (const request of await cache.keys()) {
        if (!gifKeepUrl(request.url, { index: gifState.index, favorites, keepDays, now })) await cache.delete(request);
    }
    let changed = false;
    for (const url of Object.keys(gifState.index)) {
        if (!gifKeepUrl(url, { index: gifState.index, favorites, keepDays, now })) {
            delete gifState.index[url];
            changed = true;
        }
    }
    if (changed) await putDatabaseRecord('keys', { id: GIF_INDEX_RECORD_ID, entries: gifState.index }).catch(() => {});
}

// ----- Anzeige -----
function createGifMedia(gif, className) {
    const video = isGifVideoUrl(gif.url);
    const media = document.createElement(video ? 'video' : 'img');
    media.className = className;
    media.referrerPolicy = 'no-referrer';
    if (video) {
        Object.assign(media, { autoplay: true, loop: true, muted: true, playsInline: true });
        media.setAttribute('muted', '');
    } else {
        media.loading = 'lazy';
        media.decoding = 'async';
        media.alt = gif.title || 'GIF';
    }
    media.dataset.gifUrl = gif.url;
    media.src = gifMediaSrc(gif.url);
    // Proxy-Token abgelaufen (Neustart des Routers, neuer Tag): einmal neu holen und nochmal laden.
    if (media.src.includes('/api/gif-proxy')) {
        media.addEventListener('error', async () => {
            if (media.dataset.retried) return;
            media.dataset.retried = '1';
            await refreshGifProxyToken().catch(() => null);
            media.src = gifMediaSrc(gif.url);
        });
    }
    return media;
}

// Bibliotheks-GIF melden (der Router blendet es nach mehreren Meldungen aus, der Admin entscheidet).
function gifReportButton(gif) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gif-report';
    button.dataset.gifReport = gif.url;
    button.setAttribute('aria-label', t('gifs.report'));
    button.innerHTML = '<i class="fa-regular fa-flag"></i>';
    button.onclick = event => {
        event.stopPropagation();
        reportLibraryGif(gif, button).catch(logBackgroundError('gifReportButton'));
    };
    return button;
}

async function reportLibraryGif(gif, button = null) {
    // Im Vollbild liegt der Dialog sonst dahinter.
    if (gifState.viewer) closeGifViewer();
    const choice = await openReportDialog({ title: t('gifs.report'), intro: t('gifs.reportConfirm'), reasons: GIF_REPORT_REASONS });
    if (!choice) return false;
    const response = await fetch(`${API_BASE}/api/gifs/report`, {
        method: 'POST',
        headers: peerAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ peerId: state.myProfile.id, url: gif.url, reason: choice.reason })
    }).catch(() => null);
    showToast(response?.ok ? t('gifs.reported') : t('gifs.reportFailed'), response?.ok ? 'info' : 'error');
    if (response?.ok && button) button.disabled = true;
    return Boolean(response?.ok);
}

function gifBox(gif) {
    const box = document.createElement('div');
    box.className = 'gif-box';
    const ratio = gif.w && gif.h ? gif.w / gif.h : 1;
    box.style.aspectRatio = String(Math.min(3, Math.max(0.33, ratio)));
    return box;
}

function renderGifMessage(bubble, message, isMine) {
    const gif = message.gif;
    const display = gifDisplayState(gif, { mine: isMine, sources: gifSources(), enabled: gifSetting('enabled'), external: gifSetting('external') });
    bubble.classList.add('gif-bubble');
    if (display === 'off') {
        const note = document.createElement('div');
        note.className = 'text-xs opacity-75 italic';
        note.textContent = t('gifs.unavailable');
        bubble.appendChild(note);
        return;
    }
    const box = gifBox(gif);
    if (display === 'show') {
        const media = createGifMedia(gif, 'gif-media');
        const remember = () => markGifCached(gif.url, isMine ? 'sent' : 'received').catch(() => {});
        media.addEventListener(media.tagName === 'VIDEO' ? 'loadeddata' : 'load', remember, { once: true });
        media.addEventListener('error', () => {
            box.classList.add('gif-broken');
            // Abgelaufener Discord-Link: sagen, warum nichts kommt.
            if (discordLinkExpired(gif.url)) box.title = t('gifs.linkExpired');
        }, { once: true });
        media.classList.add('cursor-zoom-in');
        media.onclick = event => {
            event.stopPropagation();
            openGifViewer(gif, { mine: isMine });
        };
        const star = document.createElement('button');
        star.type = 'button';
        // Oben liegt die Aktionsleiste der Nachricht: Stern unten, bei eigenen Nachrichten links.
        star.className = `gif-favorite ${isMine ? 'is-left' : ''}`;
        star.dataset.gifFavorite = gif.url;
        const favorite = isFavoriteGif(gif.url);
        star.setAttribute('aria-pressed', String(favorite));
        star.setAttribute('aria-label', (favorite ? t('gifs.unfavorite') : t('gifs.favorite')));
        star.innerHTML = `<i class="fa-${favorite ? 'solid' : 'regular'} fa-star"></i>`;
        star.onclick = async event => {
            event.stopPropagation();
            const now = await toggleFavoriteGif(gif);
            star.setAttribute('aria-pressed', String(now));
            star.innerHTML = `<i class="fa-${now ? 'solid' : 'regular'} fa-star"></i>`;
        };
        box.append(media, star);
        if (gif.source === 'library' && !isMine) box.appendChild(gifReportButton(gif));
        // Pflicht-Scan 'minor-chats' (nudity.js) gilt auch fuer GIFs.
        if (message.nudityScan && !isMine && typeof markForcedNudityScan === 'function') markForcedNudityScan(gif.url);
        if (!isMine) guardGifNudity(box, gif);
    } else {
        // Nichts laden: nur eine verschwommene Flaeche, der Server des GIFs erfaehrt nichts.
        box.classList.add('gif-blocked');
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.gifEnable = display;
        button.className = 'gif-enable';
        button.innerHTML = '<i class="fa-solid fa-film"></i>';
        const label = document.createElement('span');
        label.textContent = (display === 'external' ? t('gifs.enableExternalPrompt') : t('gifs.enablePrompt'));
        button.appendChild(label);
        button.onclick = event => {
            event.stopPropagation();
            enableGifsFromPrompt(display).catch(logBackgroundError('renderGifMessage'));
        };
        box.appendChild(button);
    }
    bubble.appendChild(box);
    if (message.text) {
        const caption = document.createElement('div');
        caption.className = 'opacity-90 mt-1';
        caption.textContent = message.text;
        bubble.appendChild(caption);
    }
}

// ----- Nacktbild-Filter fuer GIFs (nudity.js) -----
// Fremde GIF-Bilder lassen sich nur pruefen, wenn ihr Server CORS erlaubt (oder ueber den Proxy, dann
// same-origin). Bis das Ergebnis da ist, bleibt das GIF unscharf; laesst es sich nicht pruefen, bleibt es
// unscharf mit "nicht geprueft" (wie bei Bildern: lieber unscharf als ungeprueft). Tippen zeigt es.
function loadGifCorsFrame(gif) {
    return new Promise((resolve, reject) => {
        const video = isGifVideoUrl(gif.url);
        const media = document.createElement(video ? 'video' : 'img');
        media.crossOrigin = 'anonymous';
        media.referrerPolicy = 'no-referrer';
        const timer = setTimeout(() => reject(new Error('timeout')), 15000);
        media.addEventListener(video ? 'loadeddata' : 'load', () => {
            clearTimeout(timer);
            resolve(media);
        }, { once: true });
        media.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('not loadable with CORS'));
        }, { once: true });
        if (video) {
            media.muted = true;
            media.preload = 'auto';
        }
        media.src = gifMediaSrc(gif.url);
    });
}

function gifNudityGuardNeeded(gif) {
    return typeof nudityCheckNeeded === 'function' && nudityCheckNeeded(gif.url);
}

// false = scharf, 'nude' oder 'unchecked' = unscharf.
async function checkGifNudity(gif) {
    let bitmap;
    try {
        bitmap = await createImageBitmap(await loadGifCorsFrame(gif));
    } catch {
        return 'unchecked';
    }
    try {
        return await shouldBlurImage(bitmap, gif.url);
    } finally {
        bitmap.close?.();
    }
}

function guardGifNudity(container, gif) {
    if (!gifNudityGuardNeeded(gif)) return;
    container.classList.add('gif-nsfw-pending');
    checkGifNudity(gif).then(result => {
        container.classList.remove('gif-nsfw-pending');
        if (!result) return;
        container.classList.add('gif-nsfw');
        const cover = document.createElement('button');
        cover.type = 'button';
        cover.className = 'gif-nsfw-cover';
        cover.dataset.gifNsfw = result;
        const label = document.createElement('span');
        label.className = 'font-semibold';
        label.textContent = result === 'unchecked' ? t('nudity.notChecked') : t('nudity.mightBeNude');
        const hint = document.createElement('span');
        hint.className = 'text-[11px] opacity-80';
        hint.textContent = t('nudity.tapToView');
        cover.append(label, hint);
        cover.onclick = event => {
            event.stopPropagation();
            markNudityRevealed(gif.url);
            container.classList.remove('gif-nsfw');
            cover.remove();
        };
        container.appendChild(cover);
    }).catch(logBackgroundError('guardGifNudity'));
}

// ----- Grosse Ansicht, Kontextmenue, Medien-Uebersicht -----
// Vollbild wie der Bildbetrachter: Tippen daneben, Escape oder Zurueck schliesst.
function openGifViewer(gif, { mine = false } = {}) {
    const element = document.getElementById('gif-viewer');
    const stage = document.getElementById('gif-viewer-stage');
    if (!element || !stage) return;
    gifState.viewer = { gif, mine };
    const media = createGifMedia(gif, 'gif-viewer-media');
    media.classList.remove('cursor-zoom-in');
    media.draggable = false;
    stage.replaceChildren(media);
    resetGifZoom();
    document.getElementById('gif-viewer-report')?.classList.toggle('hidden', !(gif.source === 'library' && !mine));
    paintViewerGifFavorite();
    initGifViewerGestures();
    if (element.classList.contains('hidden')) {
        element.classList.remove('hidden');
        pushModalEntry('gif-viewer', hideGifViewer);
    }
}

// Zoom wie im Bildbetrachter: zwei Finger, Doppeltipp, Mausrad; vergroessert verschieben; ungezoomt nach
// unten wischen oder neben das GIF tippen schliesst.
const GIF_ZOOM_MAX = 5;
const GIF_ZOOM_DOUBLE_TAP = 2.5;
const GIF_CLOSE_DRAG = 110;
const gifZoom = { scale: 1, x: 0, y: 0, closeOffset: 0, pointers: new Map(), gesture: null, lastTap: 0 };

function resetGifZoom() {
    Object.assign(gifZoom, { scale: 1, x: 0, y: 0, closeOffset: 0, gesture: null });
    gifZoom.pointers.clear();
    applyGifZoom();
}

function clampGifZoom() {
    const stage = document.getElementById('gif-viewer-stage');
    const media = stage?.querySelector('.gif-viewer-media');
    if (!media) return;
    gifZoom.scale = Math.min(GIF_ZOOM_MAX, Math.max(1, gifZoom.scale));
    // Nicht weiter verschieben, als das vergroesserte GIF ueber den Rand ragt.
    const maxX = Math.max(0, (media.clientWidth * gifZoom.scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (media.clientHeight * gifZoom.scale - stage.clientHeight) / 2);
    gifZoom.x = Math.min(maxX, Math.max(-maxX, gifZoom.x));
    gifZoom.y = Math.min(maxY, Math.max(-maxY, gifZoom.y));
    if (gifZoom.scale === 1) {
        gifZoom.x = 0;
        gifZoom.y = 0;
    }
}

function applyGifZoom() {
    const media = document.querySelector('#gif-viewer-stage .gif-viewer-media');
    if (!media) return;
    media.style.transform = `translate(${gifZoom.x}px, ${gifZoom.y + gifZoom.closeOffset}px) scale(${gifZoom.scale})`;
    const viewer = document.getElementById('gif-viewer');
    if (viewer) viewer.style.backgroundColor = `rgba(0, 0, 0, ${Math.max(0.3, 1 - Math.abs(gifZoom.closeOffset) / 400)})`;
}

function zoomGifAt(scale, clientX, clientY) {
    const stage = document.getElementById('gif-viewer-stage');
    const rect = stage.getBoundingClientRect();
    const next = Math.min(GIF_ZOOM_MAX, Math.max(1, scale));
    // Der Punkt unter dem Finger/der Maus bleibt stehen.
    const offsetX = clientX - rect.left - rect.width / 2;
    const offsetY = clientY - rect.top - rect.height / 2;
    const ratio = next / gifZoom.scale;
    gifZoom.x = offsetX - (offsetX - gifZoom.x) * ratio;
    gifZoom.y = offsetY - (offsetY - gifZoom.y) * ratio;
    gifZoom.scale = next;
    clampGifZoom();
    applyGifZoom();
}

function initGifViewerGestures() {
    const stage = document.getElementById('gif-viewer-stage');
    if (!stage || stage.dataset.gestures) return;
    stage.dataset.gestures = 'true';
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    stage.addEventListener('pointerdown', event => {
        stage.setPointerCapture?.(event.pointerId);
        gifZoom.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const points = [...gifZoom.pointers.values()];
        if (points.length === 2) {
            gifZoom.gesture = { type: 'pinch', distance: distance(points[0], points[1]), scale: gifZoom.scale, mid: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } };
        } else if (points.length === 1) {
            gifZoom.gesture = { type: 'drag', start: { x: event.clientX, y: event.clientY }, origin: { x: gifZoom.x, y: gifZoom.y }, at: Date.now(), moved: false, onMedia: event.target.classList?.contains('gif-viewer-media') };
        }
    });
    stage.addEventListener('pointermove', event => {
        if (!gifZoom.pointers.has(event.pointerId)) return;
        gifZoom.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const gesture = gifZoom.gesture;
        const points = [...gifZoom.pointers.values()];
        if (gesture?.type === 'pinch' && points.length >= 2) {
            const mid = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
            zoomGifAt(gesture.scale * distance(points[0], points[1]) / (gesture.distance || 1), mid.x, mid.y);
            gifZoom.x += mid.x - gesture.mid.x;
            gifZoom.y += mid.y - gesture.mid.y;
            gesture.mid = mid;
            clampGifZoom();
            applyGifZoom();
        } else if (gesture?.type === 'drag') {
            const dx = event.clientX - gesture.start.x;
            const dy = event.clientY - gesture.start.y;
            if (Math.hypot(dx, dy) > 6) gesture.moved = true;
            if (gifZoom.scale > 1) {
                gifZoom.x = gesture.origin.x + dx;
                gifZoom.y = gesture.origin.y + dy;
                clampGifZoom();
            } else {
                gifZoom.closeOffset = dy;
            }
            applyGifZoom();
        }
    });
    const end = event => {
        if (!gifZoom.pointers.has(event.pointerId)) return;
        gifZoom.pointers.delete(event.pointerId);
        const gesture = gifZoom.gesture;
        if (gifZoom.pointers.size) {
            // Von zwei auf einen Finger: ab hier weiter verschieben.
            const [point] = gifZoom.pointers.values();
            gifZoom.gesture = { type: 'drag', start: point, origin: { x: gifZoom.x, y: gifZoom.y }, at: Date.now(), moved: true };
            return;
        }
        gifZoom.gesture = null;
        if (gesture?.type !== 'drag') return;
        if (Math.abs(gifZoom.closeOffset) > GIF_CLOSE_DRAG) {
            closeGifViewer();
            return;
        }
        gifZoom.closeOffset = 0;
        applyGifZoom();
        if (gesture.moved || event.type === 'pointercancel') return;
        const now = Date.now();
        if (now - gifZoom.lastTap < 300) {
            gifZoom.lastTap = 0;
            zoomGifAt(gifZoom.scale > 1 ? 1 : GIF_ZOOM_DOUBLE_TAP, event.clientX, event.clientY);
            return;
        }
        gifZoom.lastTap = now;
        // Ein Tipp neben das GIF (ungezoomt) schliesst; auf dem GIF wartet er auf einen moeglichen Doppeltipp.
        if (!gesture.onMedia && gifZoom.scale === 1) closeGifViewer();
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('wheel', event => {
        event.preventDefault();
        zoomGifAt(gifZoom.scale * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
    }, { passive: false });
}

function hideGifViewer() {
    document.getElementById('gif-viewer')?.classList.add('hidden');
    document.getElementById('gif-viewer-stage')?.replaceChildren();
    gifState.viewer = null;
    resetGifZoom();
}

function closeGifViewer() {
    if (document.getElementById('gif-viewer')?.classList.contains('hidden')) return;
    dismissModalEntry('gif-viewer', hideGifViewer);
}

function paintViewerGifFavorite() {
    const button = document.getElementById('gif-viewer-favorite');
    const gif = gifState.viewer?.gif;
    if (!button || !gif) return;
    const favorite = isFavoriteGif(gif.url);
    button.setAttribute('aria-pressed', String(favorite));
    button.setAttribute('aria-label', favorite ? t('gifs.unfavorite') : t('gifs.favorite'));
    button.innerHTML = `<i class="fa-${favorite ? 'solid text-amber-400' : 'regular'} fa-star"></i>`;
}

async function toggleViewerGifFavorite() {
    if (!gifState.viewer) return;
    await toggleFavoriteGif(gifState.viewer.gif);
    paintViewerGifFavorite();
}

function copyViewerGifUrl() {
    if (gifState.viewer) return copyGifUrl(gifState.viewer.gif);
}

function reportViewerGif() {
    if (gifState.viewer) return reportLibraryGif(gifState.viewer.gif, document.getElementById('gif-viewer-report'));
}

document.addEventListener?.('keydown', event => {
    if (event.key === 'Escape') closeGifViewer();
});

async function copyGifUrl(gif) {
    if (await copyTextToClipboard(gif.url)) showToast(t('gifs.urlCopied'), 'success');
    else showToast(t('common.copyingIsNotPossible'), 'error');
}

// Kachel fuer die Medien-Uebersicht des Chats; ohne Freigabe nur verschwommen (nichts laden).
function gifOverviewTile(message) {
    const gif = message.gif;
    const mine = (typeof isOwnNode === 'function' ? isOwnNode(message.senderId) : message.senderId === state.myProfile.id);
    const display = gifDisplayState(gif, { mine, sources: gifSources(), enabled: gifSetting('enabled'), external: gifSetting('external') });
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'gif-tile';
    tile.dataset.gifOverview = gif.url;
    if (display === 'show') {
        tile.appendChild(createGifMedia(gif, 'gif-media'));
        tile.onclick = () => openGifViewer(gif, { mine });
        if (!mine) guardGifNudity(tile, gif);
    } else {
        tile.classList.add('gif-blocked');
        tile.innerHTML = '<span class="gif-enable"><i class="fa-solid fa-film"></i></span>';
        if (display !== 'off') tile.onclick = () => enableGifsFromPrompt(display).then(enabled => enabled && openChatMediaOverview()).catch(logBackgroundError('gifOverviewTile'));
    }
    return tile;
}

// Text aus dem Eingabefeld: ist es nur ein GIF-Link, wird ein GIF daraus (sonst null -> normaler Text).
async function gifFromTypedText(text) {
    const value = String(text || '').trim();
    if (!value || /\s/.test(value) || !looksLikeGifUrl(value)) return null;
    const url = gifUrlAllowed(value);
    const source = isProviderMediaUrl(url) ? 'provider' : 'url';
    if (!gifSources().includes(source)) return null;
    if (!gifSetting('enabled') && !await enableGifsFromPrompt('enable')) return null;
    // Masse messen (laedt das GIF beim Absender, wie die Vorschau im Link-Reiter); klappt es nicht: Text.
    const size = await new Promise(resolve => {
        const video = isGifVideoUrl(url);
        const probe = document.createElement(video ? 'video' : 'img');
        probe.referrerPolicy = 'no-referrer';
        if (video) probe.muted = true;
        const timer = setTimeout(() => resolve(null), 8000);
        probe.addEventListener(video ? 'loadeddata' : 'load', () => {
            clearTimeout(timer);
            resolve({ w: probe.naturalWidth || probe.videoWidth, h: probe.naturalHeight || probe.videoHeight });
        }, { once: true });
        probe.addEventListener('error', () => {
            clearTimeout(timer);
            resolve(null);
        }, { once: true });
        probe.src = gifMediaSrc(url);
    });
    if (!size) return null;
    const clamp = value => (Number.isInteger(value) && value > 0 ? Math.min(4096, value) : undefined);
    const info = { url, source, w: clamp(size.w), h: clamp(size.h) };
    if (info.w === undefined) delete info.w;
    if (info.h === undefined) delete info.h;
    return info;
}

// ----- Auswahl und Senden -----
function composeMediaGif() {
    if (typeof closeComposeMediaMenu === 'function') closeComposeMediaMenu();
    openGifPicker().catch(logBackgroundError('composeMediaGif'));
}

async function openGifPicker() {
    if (!gifComposeAvailable() || !state.activeChatPeerId) return;
    // Vorschaubilder laden fremde Server: erst nach Zustimmung.
    if (!gifSetting('enabled') && !await enableGifsFromPrompt('enable')) return;
    const content = openMediaModal(t('gifs.pickerTitle'));
    const tabs = document.createElement('div');
    tabs.className = 'flex gap-2 overflow-x-auto pb-2';
    tabs.setAttribute('role', 'tablist');
    const body = document.createElement('div');
    body.id = 'gif-picker-body';
    body.className = 'space-y-3';
    const available = [
        gifSources().includes('provider') && state.appConfig?.gifs?.provider && 'provider',
        gifSources().includes('library') && 'library',
        'favorites',
        'recent',
        gifSources().includes('url') && 'link'
    ].filter(Boolean);
    const labels = { provider: 'KLIPY', library: t('gifs.tabLibrary'), favorites: t('gifs.tabFavorites'), recent: t('gifs.tabRecent'), link: t('gifs.tabLink') };
    let currentTab = null;
    const show = tab => {
        currentTab = tab;
        tabs.querySelectorAll('button').forEach(button => {
            const active = button.dataset.gifTab === tab;
            button.setAttribute('aria-selected', String(active));
            button.className = `shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${active ? 'bg-brand-600 border-brand-500 text-white' : 'border-slate-700 text-slate-300'}`;
        });
        body.replaceChildren();
        if (tab === 'provider') renderGifProviderTab(body);
        else if (tab === 'library') renderGifLibraryTab(body);
        else if (tab === 'link') renderGifLinkTab(body);
        else renderGifGrid(body, tab === 'favorites' ? gifState.favorites : gifState.recent, (tab === 'favorites' ? t('gifs.noFavorites') : t('gifs.noRecent')));
    };
    available.forEach(tab => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.gifTab = tab;
        button.setAttribute('role', 'tab');
        button.textContent = labels[tab];
        button.onclick = () => show(tab);
        tabs.appendChild(button);
    });
    content.append(tabs, body);
    show(available[0]);
    // Seitlich wischen wechselt den Reiter (gestures.js).
    if (typeof attachTabStripSwipe === 'function') attachTabStripSwipe(body, { tabs: () => available, current: () => currentTab, select: show, moving: () => body });
}

function renderGifGrid(container, items, emptyText) {
    const grid = document.createElement('div');
    grid.className = 'gif-grid';
    if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'text-sm text-slate-400';
        empty.textContent = emptyText;
        container.appendChild(empty);
        return grid;
    }
    items.forEach(gif => grid.appendChild(gifTile(gif)));
    container.appendChild(grid);
    return grid;
}

function gifTile(gif) {
    const tile = document.createElement('div');
    tile.className = 'gif-tile';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.dataset.gifPick = gif.url;
    pick.setAttribute('aria-label', gif.title || 'GIF');
    pick.appendChild(createGifMedia(gif, 'gif-media'));
    pick.onclick = () => sendGif(gif).catch(logBackgroundError('gifTile'));
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'gif-favorite';
    const paint = () => {
        const favorite = isFavoriteGif(gif.url);
        star.setAttribute('aria-pressed', String(favorite));
        star.setAttribute('aria-label', (favorite ? t('gifs.unfavorite') : t('gifs.favorite')));
        star.innerHTML = `<i class="fa-${favorite ? 'solid' : 'regular'} fa-star"></i>`;
    };
    paint();
    star.onclick = async event => {
        event.stopPropagation();
        await toggleFavoriteGif(gif);
        paint();
    };
    tile.append(pick, star);
    if (gif.source === 'library') tile.appendChild(gifReportButton(gif));
    return tile;
}

// Klipy (Regeln: Anfrage direkt vom Client, Suchfeld "Search KLIPY", Ergebnisse unveraendert in eigenem Reiter).
// Keine customer_id und kein Share-Trigger: der Anbieter soll keine Nutzer wiedererkennen.
function renderGifProviderTab(body) {
    const provider = state.appConfig?.gifs?.provider;
    const search = document.createElement('input');
    search.type = 'search';
    search.id = 'gif-provider-search';
    // Pflicht laut Anbieter, darum nicht uebersetzt.
    search.placeholder = 'Search KLIPY';
    search.className = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-base text-slate-100 focus:outline-hidden focus:border-brand-500';
    const results = document.createElement('div');
    const powered = document.createElement('p');
    powered.className = 'text-[11px] text-slate-500 text-right';
    powered.textContent = 'Powered by KLIPY';
    body.append(search, results, powered);
    let timer = null;
    let token = 0;
    const load = async (page = 1) => {
        const current = ++token;
        const query = search.value.trim();
        const params = new URLSearchParams({ page: String(page), per_page: '24', content_filter: provider.contentFilter || 'high' });
        if (query) params.set('q', query);
        const endpoint = query ? 'search' : 'trending';
        const response = await fetch(`https://api.klipy.com/api/v1/${encodeURIComponent(provider.key)}/gifs/${endpoint}?${params}`, {
            credentials: 'omit', referrerPolicy: 'no-referrer'
        }).catch(() => null);
        if (current !== token) return;
        const data = response?.ok ? await response.json().catch(() => null) : null;
        if (page === 1) results.replaceChildren();
        if (!data?.data) {
            const error = document.createElement('p');
            error.className = 'text-sm text-red-300';
            error.textContent = t('gifs.providerError');
            results.appendChild(error);
            return;
        }
        const items = (Array.isArray(data.data.data) ? data.data.data : []).map(providerGifInfo).filter(Boolean);
        const grid = page > 1 && results.querySelector('.gif-grid') ? results.querySelector('.gif-grid') : renderGifGrid(results, items, t('gifs.libraryEmpty'));
        if (page > 1) items.forEach(gif => grid.appendChild(gifTile(gif)));
        results.querySelector('[data-gif-more]')?.remove();
        if (data.data.has_next) {
            const more = document.createElement('button');
            more.type = 'button';
            more.dataset.gifMore = '';
            more.className = 'btn-secondary w-full mt-2';
            more.textContent = t('gifs.loadMore');
            more.onclick = () => load(page + 1).catch(logBackgroundError('renderGifProviderTab'));
            results.appendChild(more);
        }
    };
    search.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => load().catch(logBackgroundError('renderGifProviderTab')), 350);
    };
    load().catch(logBackgroundError('renderGifProviderTab'));
}

function renderGifLibraryTab(body) {
    const search = document.createElement('input');
    search.type = 'search';
    search.id = 'gif-search-input';
    search.placeholder = t('gifs.searchPlaceholder');
    search.className = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-base text-slate-100 focus:outline-hidden focus:border-brand-500';
    const results = document.createElement('div');
    body.append(search, results);
    let timer = null;
    let token = 0;
    const load = async (offset = 0) => {
        const current = ++token;
        const query = search.value.trim();
        const response = await fetch(`${API_BASE}/api/gifs?q=${encodeURIComponent(query)}&offset=${offset}`, {
            headers: peerAuthHeaders({ 'X-Peer-Id': state.myProfile.id })
        }).catch(() => null);
        if (current !== token) return;
        const data = response?.ok ? await response.json().catch(() => null) : null;
        if (!offset) results.replaceChildren();
        if (!data) {
            const error = document.createElement('p');
            error.className = 'text-sm text-red-300';
            error.textContent = t('gifs.libraryError');
            results.appendChild(error);
            return;
        }
        const items = data.gifs.map(gif => ({ url: gif.url, source: 'library', ...(gif.width ? { w: gif.width } : {}), ...(gif.height ? { h: gif.height } : {}), ...(gif.title ? { title: gif.title } : {}) }))
            .filter(isValidGifInfo);
        const grid = offset && results.querySelector('.gif-grid') ? results.querySelector('.gif-grid') : renderGifGrid(results, items, t('gifs.libraryEmpty'));
        if (offset) items.forEach(gif => grid.appendChild(gifTile(gif)));
        results.querySelector('[data-gif-more]')?.remove();
        if (data.next !== null && data.next !== undefined) {
            const more = document.createElement('button');
            more.type = 'button';
            more.dataset.gifMore = '';
            more.className = 'btn-secondary w-full mt-2';
            more.textContent = t('gifs.loadMore');
            more.onclick = () => load(data.next);
            results.appendChild(more);
        }
    };
    search.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => load().catch(logBackgroundError('renderGifLibraryTab')), 300);
    };
    load().catch(logBackgroundError('renderGifLibraryTab'));
}

function renderGifLinkTab(body) {
    const input = document.createElement('input');
    input.type = 'url';
    input.id = 'gif-link-input';
    input.placeholder = t('gifs.linkPlaceholder');
    input.className = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-base text-slate-100 focus:outline-hidden focus:border-brand-500';
    const note = document.createElement('p');
    note.className = 'text-xs text-slate-400';
    note.textContent = t('gifs.linkNote');
    const preview = document.createElement('div');
    preview.id = 'gif-link-preview';
    const error = document.createElement('p');
    error.id = 'gif-link-error';
    error.className = 'hidden text-xs text-red-300';
    const suggestLabel = document.createElement('label');
    suggestLabel.className = 'flex items-center gap-2 text-xs text-slate-300';
    const suggest = document.createElement('input');
    suggest.type = 'checkbox';
    suggest.id = 'gif-link-suggest';
    const suggestText = document.createElement('span');
    suggestText.textContent = (state.appConfig?.gifs?.review === false ? t('gifs.addToLibrary') : t('gifs.suggestToLibrary'));
    suggestLabel.append(suggest, suggestText);
    suggestLabel.classList.toggle('hidden', !gifSources().includes('library'));
    const send = document.createElement('button');
    send.type = 'button';
    send.id = 'gif-link-send';
    send.className = 'w-full rounded-full bg-brand-600 hover:bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40';
    send.textContent = t('gifs.send');
    send.disabled = true;
    let current = null;
    const showError = text => {
        error.textContent = text;
        error.classList.toggle('hidden', !text);
    };
    input.oninput = () => {
        current = null;
        send.disabled = true;
        preview.replaceChildren();
        showError('');
        const url = gifUrlAllowed(input.value);
        if (!input.value.trim()) return;
        if (!url) {
            showError(t('gifs.invalidLink'));
            return;
        }
        const gif = { url, source: 'url' };
        const media = createGifMedia(gif, 'gif-media');
        const box = gifBox(gif);
        box.appendChild(media);
        preview.appendChild(box);
        const ready = () => {
            const w = media.naturalWidth || media.videoWidth;
            const h = media.naturalHeight || media.videoHeight;
            current = { ...gif, ...(w ? { w: Math.min(4096, w) } : {}), ...(h ? { h: Math.min(4096, h) } : {}) };
            send.disabled = false;
        };
        media.addEventListener(media.tagName === 'VIDEO' ? 'loadeddata' : 'load', ready, { once: true });
        media.addEventListener('error', () => showError(discordLinkExpired(url) ? t('gifs.linkExpired') : t('gifs.linkNotLoading')), { once: true });
    };
    send.onclick = async () => {
        if (!current) return;
        const gif = current;
        await sendGif(gif);
        if (suggest.checked) suggestGifToLibrary(gif).catch(logBackgroundError('renderGifLinkTab'));
    };
    body.append(input, note, error, preview, suggestLabel, send);
    setTimeout(() => input.focus(), 50);
}

async function suggestGifToLibrary(gif) {
    const response = await fetch(`${API_BASE}/api/gifs`, {
        method: 'POST',
        headers: peerAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ peerId: state.myProfile.id, url: gif.url, width: gif.w, height: gif.h, title: gif.title })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        showToast(t('gifs.suggestFailed'), 'error');
        return null;
    }
    showToast((data.status === 'approved' ? t('gifs.addedToLibrary') : t('gifs.suggested')), 'info');
    return data.status;
}

async function sendGif(gif) {
    const info = { url: gif.url, source: ['library', 'provider'].includes(gif.source) ? gif.source : 'url', ...(gif.w ? { w: gif.w } : {}), ...(gif.h ? { h: gif.h } : {}) };
    if (!isValidGifInfo(info)) return false;
    closeMediaModal();
    const sent = await sendChatMessage(null, '', null, null, { gif: info });
    if (sent === false) return false;
    await rememberRecentGif({ ...info, title: gif.title });
    await markGifCached(info.url, 'sent');
    return true;
}
