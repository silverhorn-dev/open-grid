// ================= GIFS (Board T34) =================
// GIFs liegen auf fremden https-Servern. Im Chat geht nur die URL (E2E verschluesselt), jeder Client laedt
// das GIF selbst; der Router ist kein Medienserver. Quellen erlaubt der Router (`/api/config` gifs.sources):
// - 'library': Bibliothek des Routers (nur URLs, server/gifs.js), Vorschlaege mit Freigabe im Admin-Panel,
// - 'url': beliebige eingefuegte GIF-URLs ("extern").
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

function isValidGifInfo(gif) {
    return Boolean(gif) && typeof gif === 'object' && Boolean(gifUrlAllowed(gif.url)) && gifUrlAllowed(gif.url) === gif.url
        && ['library', 'url'].includes(gif.source)
        && (gif.w === undefined || (Number.isInteger(gif.w) && gif.w > 0 && gif.w <= 4096))
        && (gif.h === undefined || (Number.isInteger(gif.h) && gif.h > 0 && gif.h <= 4096));
}

// Was eine GIF-Nachricht zeigt: 'show', 'enable' (Integration aus), 'external' (externe URLs aus), 'off' (Router).
function gifDisplayState(gif, { mine = false, sources = [], enabled = false, external = false } = {}) {
    if (!isValidGifInfo(gif) || !sources.length) return 'off';
    if (gif.source === 'url' && !sources.includes('url')) return 'off';
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
    media.src = gif.url;
    return media;
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
        media.addEventListener('error', () => box.classList.add('gif-broken'), { once: true });
        const star = document.createElement('button');
        star.type = 'button';
        star.className = 'gif-favorite';
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
        gifSources().includes('library') && 'library',
        'favorites',
        'recent',
        gifSources().includes('url') && 'link'
    ].filter(Boolean);
    const labels = { library: t('gifs.tabLibrary'), favorites: t('gifs.tabFavorites'), recent: t('gifs.tabRecent'), link: t('gifs.tabLink') };
    const show = tab => {
        tabs.querySelectorAll('button').forEach(button => {
            const active = button.dataset.gifTab === tab;
            button.setAttribute('aria-selected', String(active));
            button.className = `shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${active ? 'bg-brand-600 border-brand-500 text-white' : 'border-slate-700 text-slate-300'}`;
        });
        body.replaceChildren();
        if (tab === 'library') renderGifLibraryTab(body);
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
    return tile;
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
        media.addEventListener('error', () => showError(t('gifs.linkNotLoading')), { once: true });
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
    const info = { url: gif.url, source: gif.source === 'library' ? 'library' : 'url', ...(gif.w ? { w: gif.w } : {}), ...(gif.h ? { h: gif.h } : {}) };
    if (!isValidGifInfo(info)) return false;
    closeMediaModal();
    const sent = await sendChatMessage(null, '', null, null, { gif: info });
    if (sent === false) return false;
    await rememberRecentGif({ ...info, title: gif.title });
    await markGifCached(info.url, 'sent');
    return true;
}
