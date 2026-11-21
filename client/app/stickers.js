// ================= STICKER (Board T39, Nutzer 2026-11-20) =================
// Ein Sticker ist ein kleines Bild mit Transparenz (WebP/PNG, hoechstens STICKER_EDGE px). Die Nachricht traegt nur
// einen Verweis (Nutzer 2026-11-21): `ref` = Hash des Ausstellers (Person bzw. Router) + hochzaehlende Nummer bzw.
// Paket und Stelle, dazu `sha256` des Bilds. Der Empfaenger holt das Bild einmal (vom Absender per P2P,
// STICKER_REQUEST/STICKER_RESPONSE, bzw. Paket-Sticker vom Router), prueft die Pruefsumme und behaelt es auf dem
// Geraet; danach kostet derselbe Sticker nichts mehr. Er steht ohne Sprechblase im Chat, ist nicht speicherbar (kein Speichern,
// kein Bildbetrachter, gezeichnet auf Canvas) und laesst sich favorisieren. Quellen: eigene (aus einem Bild
// ausgeschnitten, sticker-editor.js), Favoriten (auch empfangene) und Pakete vom Router (S3).
// FSK 18 (`adult`): nur in Dating-Chats sendbar und nicht an Kontakte unter 18 (laut Profil); beim Empfaenger unscharf
// bis zum Antippen, wer unter 18 ist (Altersnachweis oder eigenes Profil) sieht ihn gar nicht.
// Eigene und favorisierte Sticker liegen verschluesselt im Store `media` (`sticker_<id>`), die Listen in `keys`.
const STICKER_EDGE = 512;
const STICKER_MAX_LENGTH = 60000;
const STICKER_LIST_MAX = 200;
const STICKER_OWN_RECORD_ID = 'stickers-own';
const STICKER_FAVORITES_RECORD_ID = 'stickers-favorites';
const STICKER_SEEN_RECORD_ID = 'stickers-seen';
const STICKER_SEEN_MAX = 500;
const STICKER_COUNTER_RECORD_ID = 'sticker-counter';
const STICKER_REQUEST_RETRY_MS = 30000;
const STICKER_REF_PATTERN = /^[ru][A-Za-z0-9_-]{6,16}-[A-Za-z0-9_.-]{1,80}$/;
const stickerState = { loaded: false, own: [], favorites: [], seen: [], revealed: new Set() };
// Bilddaten der Sitzung (Kennung -> Data-URL) und offene Anfragen (Kennung -> Zeit).
const stickerDataCache = new Map();
const stickerRequests = new Map();

function isSafeStickerData(value) {
    return typeof value === 'string' && value.length <= STICKER_MAX_LENGTH && /^data:image\/(?:png|webp);base64,[a-z0-9+/=]+$/i.test(value);
}

// Kennung aus dem Inhalt: derselbe Sticker hat ueberall dieselbe ID (Favoriten, Doppel).
function stickerIdFor(sha256) {
    return `stk_${String(sha256).replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`;
}

async function loadStickerState() {
    if (stickerState.loaded) return;
    const read = async id => {
        const record = await databaseRequest('keys', 'readonly', store => store.get(id)).catch(() => null);
        return Array.isArray(record?.items) ? record.items.filter(item => typeof item?.id === 'string') : [];
    };
    stickerState.own = await read(STICKER_OWN_RECORD_ID);
    stickerState.favorites = await read(STICKER_FAVORITES_RECORD_ID);
    stickerState.seen = await read(STICKER_SEEN_RECORD_ID);
    stickerState.loaded = true;
}

async function saveStickerList(kind) {
    const id = { own: STICKER_OWN_RECORD_ID, favorites: STICKER_FAVORITES_RECORD_ID, seen: STICKER_SEEN_RECORD_ID }[kind];
    await putDatabaseRecord('keys', { id, items: stickerState[kind] }).catch(error => logDebug(`Could not store stickers: ${error.message}`));
}

async function storeStickerData(sticker) {
    await cacheMediaPayload(`sticker_${sticker.id}`, {
        data: sticker.data, sha256: sticker.sha256, w: sticker.w, h: sticker.h, adult: sticker.adult === true,
        ...(sticker.ref ? { ref: sticker.ref } : {}), ...(sticker.pack ? { pack: sticker.pack } : {})
    });
    stickerDataCache.set(sticker.id, sticker.data);
}

// Empfangene Sticker merken (zuletzt benutzt zuerst); ueber STICKER_SEEN_MAX fallen die aeltesten weg,
// ausser sie sind eigene oder Favoriten.
async function rememberSeenSticker(id) {
    await loadStickerState();
    stickerState.seen = [{ id, at: Date.now() }, ...stickerState.seen.filter(entry => entry.id !== id)];
    const dropped = stickerState.seen.slice(STICKER_SEEN_MAX);
    stickerState.seen = stickerState.seen.slice(0, STICKER_SEEN_MAX);
    for (const entry of dropped) {
        const kept = stickerState.own.some(item => item.id === entry.id) || stickerState.favorites.some(item => item.id === entry.id);
        if (!kept) await deleteDatabaseRecord('media', `sticker_${entry.id}`).catch(() => {});
    }
    await saveStickerList('seen');
}

// ----- Verweise: Aussteller-Hash + Nummer -----
async function stickerIssuerHash(text) {
    return (await sha256Base64(String(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 10);
}

// Eigene: "u" + Hash der eigenen Kennung (alle Geraete einer Person gleich) + hochzaehlende Nummer.
async function nextOwnStickerRef() {
    const record = await databaseRequest('keys', 'readonly', store => store.get(STICKER_COUNTER_RECORD_ID)).catch(() => null);
    const next = (Number(record?.n) || 0) + 1;
    await putDatabaseRecord('keys', { id: STICKER_COUNTER_RECORD_ID, n: next });
    const identity = typeof myIdentityId === 'function' ? myIdentityId() : state.myProfile.id;
    return `u${await stickerIssuerHash(identity)}-${next}`;
}

// Pakete: "r" + Hash des Routers + Paket + Stelle.
async function routerStickerRef(packId, index) {
    return `r${await stickerIssuerHash(API_BASE || window.location.origin)}-${packId}.${index}`;
}

function isStickerRef(value) {
    return typeof value === 'string' && STICKER_REF_PATTERN.test(value);
}

// Bild eines Stickers aus der Nachricht (alte Nachrichten tragen es noch selbst) oder aus dem Speicher der Sitzung.
function stickerDataFor(sticker) {
    if (isSafeStickerData(sticker?.data)) return sticker.data;
    return sticker?.sha256 ? stickerDataCache.get(stickerIdFor(sticker.sha256)) || null : null;
}

async function loadStickerData(entry) {
    const media = await loadMedia(`sticker_${entry.id}`).catch(() => null);
    if (!media || !isSafeStickerData(media.data)) return null;
    stickerDataCache.set(entry.id, media.data);
    return { ...entry, ...media };
}

// Bild (Canvas/Bitmap mit Transparenz) zu einem Sticker: hoechstens STICKER_EDGE, WebP (sonst PNG), klein genug.
async function encodeSticker(source, { adult = false } = {}) {
    const width = source.width;
    const height = source.height;
    if (!width || !height) return null;
    let scale = Math.min(1, STICKER_EDGE / Math.max(width, height));
    let quality = 0.9;
    const canvas = document.createElement('canvas');
    for (let attempt = 0; attempt < 14; attempt++) {
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d');
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/webp', quality);
        if (isSafeStickerData(data)) {
            const sha256 = await sha256Base64(data);
            return { id: stickerIdFor(sha256), data, sha256, w: canvas.width, h: canvas.height, ...(adult ? { adult: true } : {}) };
        }
        // Ohne WebP-Encoder (PNG) hilft nur kleiner; sonst erst die Qualitaet.
        if (data.startsWith('data:image/webp') && quality > 0.5) quality -= 0.1;
        else scale *= 0.85;
    }
    return null;
}

// ----- Altersregeln (FSK 18) -----
function profileAge(profile) {
    const value = Number(profile?.fields?.age);
    return Number.isFinite(value) && value > 0 ? value : null;
}

function iAmMinor() {
    if (state.ageGroup === 'minor') return true;
    const own = profileAge(state.myProfile);
    return own !== null && own < 18;
}

function adultStickerAllowedTo(peerId) {
    if (iAmMinor()) return false;
    if (!(typeof isDatingChat === 'function' && isDatingChat(peerId))) return false;
    const age = profileAge(state.cachedProfiles?.[peerId]);
    return age === null || age >= 18;
}

// ----- Senden -----
async function sendSticker(sticker) {
    const peerId = state.activeChatPeerId;
    if (!peerId || !sticker || !isSafeStickerData(sticker.data) || !sticker.sha256) return false;
    if (sticker.adult && !adultStickerAllowedTo(peerId)) {
        showToast(t('stickers.adultNotHere'), 'warning');
        return false;
    }
    // Aeltere eigene/Favoriten ohne Verweis: jetzt einen geben (gilt dann als eigener Sticker dieses Geraets).
    const ref = isStickerRef(sticker.ref) ? sticker.ref : await nextOwnStickerRef();
    const id = sticker.id || stickerIdFor(sticker.sha256);
    // Bei mir liegen lassen: der Empfaenger fragt es (einmal) bei mir an.
    await storeStickerData({ ...sticker, id, ref });
    closeMediaModal();
    return sendChatMessage(null, '', null, null, {
        peerId,
        sticker: { ref, sha256: sticker.sha256, w: sticker.w, h: sticker.h, ...(sticker.adult ? { adult: true } : {}), ...(sticker.pack ? { pack: sticker.pack } : {}) }
    });
}

// ----- Nachladen: einmal holen, pruefen, behalten -----
// Fehlt das Bild: aus dem Speicher; sonst Paket-Sticker vom Router; sonst beim Absender anfragen (nur ueber einen
// offenen Kanal, sonst Verbindung anstossen und spaeter erneut). Danach neu zeichnen.
async function ensureStickerLoaded(sticker, senderId) {
    if (!sticker?.sha256) return;
    const id = stickerIdFor(sticker.sha256);
    if (stickerDataCache.has(id)) return;
    const asked = stickerRequests.get(id);
    if (asked && Date.now() - asked < STICKER_REQUEST_RETRY_MS) return;
    stickerRequests.set(id, Date.now());
    const stored = await loadStickerData({ id });
    if (stored) {
        stickerRequests.delete(id);
        redrawStickerChat();
        return;
    }
    if (sticker.pack && await loadPackSticker(sticker).catch(() => false)) return;
    if (!senderId || (typeof isOwnNode === 'function' ? isOwnNode(senderId) : senderId === state.myProfile.id)) return;
    if (typeof isSecureChannelOpen === 'function' && !isSecureChannelOpen(senderId)) {
        if (typeof initiateP2PConnection === 'function') initiateP2PConnection(senderId).catch(() => {});
        return;
    }
    await sendSecurePayload(senderId, { type: 'STICKER_REQUEST', sha256: sticker.sha256 }).catch(logBackgroundError('ensureStickerLoaded'));
}

async function loadPackSticker(sticker) {
    const pack = await fetchStickerJson(`/api/stickers/${encodeURIComponent(sticker.pack)}`);
    const item = (pack.stickers || []).find(entry => entry?.sha256 === sticker.sha256);
    if (!item || !await acceptStickerData(sticker.sha256, item.data, { w: item.w, h: item.h, ref: sticker.ref, pack: sticker.pack })) return false;
    return true;
}

// Pruefsumme muss passen, sonst wird nichts gespeichert.
async function acceptStickerData(sha256, data, details = {}) {
    if (!isSafeStickerData(data) || (await sha256Base64(data)) !== sha256) return false;
    const id = stickerIdFor(sha256);
    await storeStickerData({ id, data, sha256, w: details.w, h: details.h, ...(details.ref ? { ref: details.ref } : {}), ...(details.pack ? { pack: details.pack } : {}) });
    await rememberSeenSticker(id);
    stickerRequests.delete(id);
    redrawStickerChat();
    return true;
}

function redrawStickerChat() {
    if (state.activeChatPeerId && typeof renderChatHistory === 'function') renderChatHistory();
}

// P2P (p2p.client.js): Anfrage beantworten, wenn ich den Sticker habe; Antwort nur, wenn ich gefragt habe.
async function handleStickerRequest(peerId, payload) {
    const id = stickerIdFor(payload.sha256);
    const stored = await loadStickerData({ id });
    if (!stored || stored.sha256 !== payload.sha256) {
        await sendSecurePayload(peerId, { type: 'STICKER_MISSING', sha256: payload.sha256 }).catch(() => {});
        return;
    }
    await sendSecurePayload(peerId, { type: 'STICKER_RESPONSE', sha256: stored.sha256, data: stored.data, w: stored.w, h: stored.h }).catch(logBackgroundError('handleStickerRequest'));
}

async function handleStickerResponse(peerId, payload) {
    if (!stickerRequests.has(stickerIdFor(payload.sha256))) return;
    if (!await acceptStickerData(payload.sha256, payload.data, { w: payload.w, h: payload.h })) logDebug(`Rejected sticker from ${peerId}: checksum mismatch.`);
}

function handleStickerMissing(peerId, payload) {
    logDebug(`Sticker ${stickerIdFor(payload.sha256)} not available at ${peerId}.`);
}

// ----- Anzeige im Chat (ohne Sprechblase, chat.js) -----
function renderStickerMessage(bubble, message, isMine) {
    const sticker = message.sticker;
    bubble.classList.add('chat-bubble-sticker');
    if (!sticker?.sha256 && !isSafeStickerData(sticker?.data)) {
        bubble.textContent = t('stickers.unavailable');
        return;
    }
    if (sticker.adult && !isMine && iAmMinor()) {
        const hidden = document.createElement('div');
        hidden.className = 'sticker-hidden text-xs italic opacity-70';
        hidden.textContent = t('stickers.hiddenAdult');
        bubble.appendChild(hidden);
        return;
    }
    const data = stickerDataFor(sticker);
    if (!data) {
        // Noch nicht da: Platzhalter in der richtigen Groesse, Bild einmal holen.
        const pending = document.createElement('div');
        pending.className = 'sticker-pending';
        pending.dataset.stickerPending = message.id;
        const ratio = sticker.w && sticker.h ? sticker.h / sticker.w : 1;
        pending.style.width = '8rem';
        pending.style.height = `${Math.min(10, 8 * ratio)}rem`;
        pending.setAttribute('aria-label', t('stickers.loading'));
        bubble.appendChild(pending);
        ensureStickerLoaded(sticker, message.senderId).catch(logBackgroundError('ensureStickerLoaded'));
        return;
    }
    const frame = document.createElement('div');
    frame.className = 'sticker-frame relative';
    frame.dataset.sticker = message.id;
    const image = createSecureImage(data, 'sticker-image', { w: sticker.w, h: sticker.h }, { own: isMine, reuseKey: `sticker:${message.id}` });
    image.setAttribute('role', 'img');
    image.setAttribute('aria-label', t('stickers.sticker'));
    frame.appendChild(image);
    const blurred = sticker.adult && !isMine && !stickerState.revealed.has(message.id);
    if (blurred) {
        frame.classList.add('is-adult-hidden');
        const badge = document.createElement('span');
        badge.className = 'sticker-adult-badge';
        badge.textContent = t('stickers.adultTapToShow');
        frame.appendChild(badge);
    }
    frame.onclick = event => {
        event.stopPropagation();
        if (frame.classList.contains('is-adult-hidden')) {
            stickerState.revealed.add(message.id);
            frame.classList.remove('is-adult-hidden');
            frame.querySelector('.sticker-adult-badge')?.remove();
            return;
        }
        openStickerDetails({ ...sticker, data }).catch(logBackgroundError('openStickerDetails'));
    };
    bubble.appendChild(frame);
}

// Antippen: gross ansehen und favorisieren (nie speichern).
async function openStickerDetails(sticker) {
    await loadStickerState();
    const id = stickerIdFor(sticker.sha256 || (await sha256Base64(sticker.data)));
    const content = openMediaModal(t('stickers.sticker'));
    const box = document.createElement('div');
    box.className = 'flex flex-col items-center gap-3';
    const preview = createSecureImage(sticker.data, 'sticker-preview', { w: sticker.w, h: sticker.h });
    const favorite = document.createElement('button');
    favorite.type = 'button';
    favorite.id = 'sticker-favorite-btn';
    favorite.className = 'btn-secondary';
    const paint = () => {
        const on = stickerState.favorites.some(entry => entry.id === id);
        favorite.innerHTML = `<i class="fa-${on ? 'solid' : 'regular'} fa-star"></i>`;
        favorite.append(document.createTextNode(` ${on ? t('stickers.unfavorite') : t('stickers.favorite')}`));
    };
    favorite.onclick = async () => {
        await toggleStickerFavorite({ ...sticker, id });
        paint();
    };
    paint();
    box.append(preview, favorite);
    content.appendChild(box);
}

async function toggleStickerFavorite(sticker) {
    await loadStickerState();
    const on = stickerState.favorites.some(entry => entry.id === sticker.id);
    if (on) {
        stickerState.favorites = stickerState.favorites.filter(entry => entry.id !== sticker.id);
        if (!stickerState.own.some(entry => entry.id === sticker.id)) await deleteDatabaseRecord('media', `sticker_${sticker.id}`).catch(() => {});
    } else {
        await storeStickerData(sticker);
        stickerState.favorites = [{ id: sticker.id, ...(sticker.adult ? { adult: true } : {}) }, ...stickerState.favorites.filter(entry => entry.id !== sticker.id)].slice(0, STICKER_LIST_MAX);
    }
    await saveStickerList('favorites');
    showToast(on ? t('stickers.favoriteRemoved') : t('stickers.favoriteAdded'), 'info');
    return !on;
}

async function addOwnSticker(sticker) {
    await loadStickerState();
    if (!isStickerRef(sticker.ref)) sticker.ref = await nextOwnStickerRef();
    await storeStickerData(sticker);
    stickerState.own = [{ id: sticker.id, ...(sticker.adult ? { adult: true } : {}) }, ...stickerState.own.filter(entry => entry.id !== sticker.id)].slice(0, STICKER_LIST_MAX);
    await saveStickerList('own');
}

async function removeOwnSticker(id) {
    await loadStickerState();
    stickerState.own = stickerState.own.filter(entry => entry.id !== id);
    if (!stickerState.favorites.some(entry => entry.id === id)) await deleteDatabaseRecord('media', `sticker_${id}`).catch(() => {});
    await saveStickerList('own');
}

// ----- Auswahl (Chat-Eingabe -> Medien -> Sticker) -----
function composeMediaSticker() {
    if (typeof closeComposeMediaMenu === 'function') closeComposeMediaMenu();
    openStickerPicker().catch(logBackgroundError('openStickerPicker'));
}

async function openStickerPicker() {
    const peerId = state.activeChatPeerId;
    if (!peerId) return;
    const allowance = getPeerChatAllowance(peerId);
    if (allowance && (!allowance.allowed || !allowance.images)) {
        showToast(allowance.reason || t('chat.imagesAreOnlyAllowedAfter'), 'info');
        return;
    }
    await loadStickerState();
    if (typeof sendTyping === 'function') sendTyping('media');
    const content = openMediaModal(t('stickers.pickerTitle'));
    const tabs = document.createElement('div');
    tabs.className = 'flex gap-2 overflow-x-auto pb-2';
    tabs.setAttribute('role', 'tablist');
    const body = document.createElement('div');
    body.id = 'sticker-picker-body';
    body.className = 'space-y-3';
    const available = ['favorites', 'own', ...(typeof stickerPacksAvailable === 'function' && stickerPacksAvailable() ? ['packs'] : [])];
    const labels = { favorites: t('stickers.tabFavorites'), own: t('stickers.tabOwn'), packs: t('stickers.tabPacks') };
    let current = null;
    const show = tab => {
        current = tab;
        tabs.querySelectorAll('button').forEach(button => {
            const active = button.dataset.stickerTab === tab;
            button.setAttribute('aria-selected', String(active));
            button.className = `shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${active ? 'bg-brand-600 border-brand-500 text-white' : 'border-slate-700 text-slate-300'}`;
        });
        body.replaceChildren();
        if (tab === 'packs') renderStickerPacksTab(body).catch(logBackgroundError('renderStickerPacksTab'));
        else renderStickerGrid(body, tab).catch(logBackgroundError('renderStickerGrid'));
    };
    available.forEach(tab => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.stickerTab = tab;
        button.setAttribute('role', 'tab');
        button.textContent = labels[tab];
        button.onclick = () => show(tab);
        tabs.appendChild(button);
    });
    content.append(tabs, body);
    show(stickerState.favorites.length ? 'favorites' : 'own');
    if (typeof attachTabStripSwipe === 'function') attachTabStripSwipe(body, { tabs: () => available, current: () => current, select: show, moving: () => body });
}

function stickerTile(sticker, { onRemove = null } = {}) {
    const tile = document.createElement('div');
    tile.className = 'sticker-tile relative';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sticker-tile-button';
    button.dataset.stickerId = sticker.id;
    button.setAttribute('aria-label', t('stickers.send'));
    button.appendChild(createSecureImage(sticker.data, 'sticker-tile-image', { w: sticker.w, h: sticker.h }));
    if (sticker.adult) {
        const badge = document.createElement('span');
        badge.className = 'sticker-tile-adult';
        badge.textContent = '18+';
        button.appendChild(badge);
    }
    button.onclick = () => sendSticker(sticker).catch(logBackgroundError('sendSticker'));
    tile.appendChild(button);
    if (onRemove) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'sticker-tile-remove';
        remove.setAttribute('aria-label', t('stickers.remove'));
        remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        remove.onclick = event => {
            event.stopPropagation();
            onRemove().then(() => tile.remove()).catch(logBackgroundError('removeSticker'));
        };
        tile.appendChild(remove);
    }
    return tile;
}

async function renderStickerGrid(body, kind) {
    const grid = document.createElement('div');
    grid.className = 'sticker-grid';
    if (kind === 'own') {
        const create = document.createElement('button');
        create.type = 'button';
        create.id = 'sticker-create-btn';
        create.className = 'sticker-tile sticker-create';
        create.innerHTML = '<i class="fa-solid fa-plus"></i>';
        create.append(document.createTextNode(` ${t('stickers.create')}`));
        create.onclick = () => {
            if (typeof openStickerCreator === 'function') openStickerCreator().catch(logBackgroundError('openStickerCreator'));
        };
        grid.appendChild(create);
    }
    const entries = kind === 'own' ? stickerState.own : stickerState.favorites;
    const minor = iAmMinor();
    for (const entry of entries) {
        if (entry.adult && minor) continue;
        const sticker = await loadStickerData(entry);
        if (!sticker) continue;
        grid.appendChild(stickerTile(sticker, {
            onRemove: kind === 'own' ? () => removeOwnSticker(entry.id) : () => toggleStickerFavorite(sticker)
        }));
    }
    if (!grid.children.length) {
        const empty = document.createElement('p');
        empty.className = 'text-sm text-slate-400';
        empty.textContent = t('stickers.noFavorites');
        body.appendChild(empty);
        return;
    }
    body.appendChild(grid);
}

// ----- S3: Pakete vom Router -----
function stickerPacksAvailable() {
    return state.appConfig?.stickers?.packs === true;
}

async function fetchStickerJson(path) {
    const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function renderStickerPacksTab(body) {
    const minor = iAmMinor();
    const { packs } = await fetchStickerJson('/api/stickers').catch(() => ({ packs: [] }));
    const visible = (packs || []).filter(pack => typeof pack?.id === 'string' && !(pack.adult && minor));
    if (!visible.length) {
        const empty = document.createElement('p');
        empty.className = 'text-sm text-slate-400';
        empty.textContent = t('stickers.packsEmpty');
        body.appendChild(empty);
        return;
    }
    const chips = document.createElement('div');
    chips.className = 'flex gap-2 overflow-x-auto pb-1';
    const grid = document.createElement('div');
    grid.className = 'sticker-grid';
    const showPack = async pack => {
        chips.querySelectorAll('button').forEach(button => button.classList.toggle('is-active', button.dataset.stickerPack === pack.id));
        grid.replaceChildren();
        try {
            const full = await fetchStickerJson(`/api/stickers/${encodeURIComponent(pack.id)}`);
            for (const [index, item] of (full.stickers || []).entries()) {
                if (!isSafeStickerData(item?.data)) continue;
                const adult = pack.adult || item.adult === true;
                if (adult && minor) continue;
                const ref = await routerStickerRef(pack.id, index);
                grid.appendChild(stickerTile({ id: stickerIdFor(item.sha256), data: item.data, sha256: item.sha256, w: item.w, h: item.h, ref, pack: pack.id, ...(adult ? { adult: true } : {}) }));
            }
        } catch {
            const failed = document.createElement('p');
            failed.className = 'text-sm text-rose-300';
            failed.textContent = t('stickers.packLoadFailed');
            grid.appendChild(failed);
        }
    };
    visible.forEach(pack => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.dataset.stickerPack = pack.id;
        chip.className = 'grid-filter-chip shrink-0';
        chip.textContent = pack.adult ? `${pack.name} · 18+` : pack.name;
        chip.onclick = () => showPack(pack).catch(logBackgroundError('showStickerPack'));
        chips.appendChild(chip);
    });
    body.append(chips, grid);
    await showPack(visible[0]);
}

