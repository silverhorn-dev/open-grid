// ================= ALBEN & MEDIEN =================
// Eigene Alben liegen im Store `albums` (ownerId = eigene ID) mit Zugriffsliste `acl`.
// Bilder liegen verschluesselt im Store `media`. Andere Peers erhalten Album und
// Bilder nur per P2P und nur, solange sie in der `acl` stehen.
const ALBUM_IMAGE_MAX_EDGE = 1080;
const ALBUM_IMAGE_QUALITY = 0.7;
const ALBUM_COVER_EDGE = 240;
// Vorschau im Chat (Besitzer waehlt je Album): 'normal' = Deckbild scharf, 'blur' = unscharf (schon beim
// Besitzer unscharf gerechnet, ein scharfes Deckbild verlaesst das Geraet nie), 'none' = Karte ohne Bild.
const ALBUM_PREVIEW_OPTIONS = ['normal', 'blur', 'none'];

// Begrenzt teilen (Sendemenue im Chat, ueberspringbar): wie ein Snap 1x/2x/3x ansehen oder 15 min/1 h/24 h.
// album.limits[viewerId] = { kind: 'views', views, used, sessionEndsAt } | { kind: 'time', until }.
// Ansichten: keine Schluessel vorab; jedes Oeffnen fragt den Besitzer, der zaehlt und Schluessel fuer
// eine Ansicht (ALBUM_VIEW_SESSION_MS) schickt. Zeit: Schluessel nur bis zur Frist. Danach wird der
// Zugriff wie von Hand entzogen (neue Schluesselversion).
const ALBUM_SHARE_LIMITS = {
    views1: { kind: 'views', views: 1 },
    views2: { kind: 'views', views: 2 },
    views3: { kind: 'views', views: 3 },
    m15: { kind: 'time', ms: 15 * 60 * 1000 },
    h1: { kind: 'time', ms: 60 * 60 * 1000 },
    h24: { kind: 'time', ms: 24 * 60 * 60 * 1000 }
};
const ALBUM_VIEW_SESSION_MS = 15 * 60 * 1000;

function albumLimitFor(album, viewerId) {
    const limit = album?.limits?.[viewerId];
    return limit && (limit.kind === 'views' || limit.kind === 'time') ? limit : null;
}

function albumLimitLabel(limit, now = Date.now()) {
    if (!limit) return '';
    if (limit.kind === 'views') {
        const left = Math.max(0, limit.views - (limit.used || 0));
        return left ? t('albums.viewsLeft', { left, views: limit.views }) : t('albums.viewsUsedUp');
    }
    return limit.until > now ? t('albums.availableUntil', { time: formatClockTime(limit.until) }) : t('albums.limitExpired');
}

function albumPreviewMode(album) {
    return ALBUM_PREVIEW_OPTIONS.includes(album?.preview) ? album.preview : 'normal';
}

async function loadAlbums() {
    const records = await getAllDatabaseRecords('albums').catch(() => []);
    const albums = [];
    for (const record of records) {
        if (record.sealed) {
            const album = await decryptStoredProfile(record.sealed).catch(() => null);
            if (album?.id === record.id) albums.push(album);
            continue;
        }
        // Alte Klartext-Datensaetze werden beim Laden verschluesselt neu gespeichert.
        albums.push(record);
        await persistAlbum(record);
    }
    state.albums = Object.fromEntries(albums.map(album => [album.id, album]));
    // Alben aus der Zeit vor den rotierenden Schluesseln bekommen nachtraeglich ein Geheimnis.
    for (const album of getOwnAlbums().filter(album => !album.secret)) {
        album.secret = createAlbumSecret();
        album.keyVersion = 1;
        await persistAlbum(album);
    }
    renderAlbumManager();
    // Begrenzungen, die abgelaufen sind, waehrend die App zu war.
    enforceAlbumLimits().catch(logBackgroundError('loadAlbums'));
    // Betrachter: was waehrend der Pause abgelaufen ist, jetzt vergessen.
    runAlbumSelfDestruct().catch(logBackgroundError('loadAlbums'));
}

// Alben (inkl. Albumgeheimnis und rollender Keys) liegen mit dem Speicherschluessel verschluesselt
// in IndexedDB, wie die Profile. Nur die ID bleibt lesbar.
async function persistAlbum(album) {
    if (!state.storageKey) {
        await putDatabaseRecord('albums', album);
        return;
    }
    await putDatabaseRecord('albums', { id: album.id, sealed: await encryptStoredProfile(album) });
}

function createAlbumSecret() {
    return bytesToBase64(window.crypto.getRandomValues(new Uint8Array(32)));
}

function getOwnAlbums() {
    return Object.values(state.albums)
        .filter(album => album.ownerId === state.myProfile.id)
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}

async function saveAlbum(album) {
    album.updatedAt = Date.now();
    state.albums[album.id] = album;
    await persistAlbum(album);
    renderAlbumManager();
}

async function createAlbum() {
    const input = document.getElementById('new-album-name');
    const name = input?.value.trim();
    if (!name) {
        showToast(t('albums.pleaseEnterAlbumName'), 'warning');
        return;
    }
    await saveAlbum({
        id: `alb_${window.crypto.randomUUID()}`,
        ownerId: state.myProfile.id,
        name: name.substring(0, 80),
        items: [],
        acl: [],
        secret: createAlbumSecret(),
        keyVersion: 1,
        keyEpochMinutes: state.albumDefaults.epochMinutes,
        keyEpochsAhead: state.albumDefaults.epochsAhead
    });
    input.value = '';
}

async function addAlbumImages(albumId, input) {
    const album = state.albums[albumId];
    const files = Array.from(input.files || []);
    input.value = '';
    if (!album || !files.length) return;
    for (const file of files) {
        try {
            const data = await compressImage(file, ALBUM_IMAGE_MAX_EDGE, ALBUM_IMAGE_MAX_EDGE, ALBUM_IMAGE_QUALITY);
            const imageId = `albimg_${window.crypto.randomUUID()}`;
            await cacheMedia(imageId, data, 1);
            album.items.push({ id: imageId, version: 1 });
        } catch (error) {
            logDebug(`Album image failed: ${error.message}`);
            showToast(t('albums.imageCouldNotBeAdded'), 'error');
        }
    }
    await saveAlbum(album);
}

async function removeAlbumImage(albumId, imageId) {
    const album = state.albums[albumId];
    if (!album) return;
    album.items = album.items.filter(item => item.id !== imageId);
    await deleteDatabaseRecord('media', imageId);
    await saveAlbum(album);
    if (state.albumViewer?.albumId === albumId) await openAlbumViewer(albumId);
}

async function deleteAlbum(albumId) {
    const album = state.albums[albumId];
    if (!album || !window.confirm(t('albums.reallyDeleteAlbum', { name: album.name }))) return;
    album.acl.forEach(peerId => notifyAlbumRevoked(peerId, albumId));
    await Promise.all(album.items.map(item => deleteDatabaseRecord('media', item.id)));
    await deleteDatabaseRecord('albums', albumId);
    delete state.albums[albumId];
    renderAlbumManager();
}

async function revokeAlbumAccess(albumId, peerId) {
    const album = state.albums[albumId];
    if (!album) return;
    album.acl = album.acl.filter(id => id !== peerId);
    if (album.viewerKeyEpochs?.[peerId]) {
        album.viewerKeyEpochs = { ...album.viewerKeyEpochs };
        delete album.viewerKeyEpochs[peerId];
    }
    if (album.limits?.[peerId]) {
        album.limits = { ...album.limits };
        delete album.limits[peerId];
    }
    // Neue Schluesselversion: auch ein zurueckbehaltener Schluessel passt nicht mehr zu neuen Uebertragungen.
    album.keyVersion = (album.keyVersion || 1) + 1;
    await saveAlbum(album);
    notifyAlbumRevoked(peerId, albumId);
    // Verbleibende Betrachter bekommen Buendel fuer die neue Schluesselversion.
    for (const viewerId of album.acl) pushAlbumKeys(viewerId, album, true).catch(logBackgroundError('revokeAlbumAccess'));
}

// Entzug als Chat-Operation: mit Rueckruf geht sie ohne Kanal nach 10 s ueber Pfad C, kommt also auch an,
// wenn der Betrachter gerade offline ist (sonst behielte er die Schluessel bis zum Epochenende).
// Die alte Direktnachricht geht fuer aeltere App-Versionen zusaetzlich mit.
function notifyAlbumRevoked(peerId, albumId) {
    const operation = {
        operationId: `albumrevoke:${albumId}:${window.crypto.randomUUID()}`,
        type: 'ALBUM_REVOKE',
        actorId: state.myProfile.id,
        createdAt: Date.now(),
        albumId
    };
    sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation }, () => {}).catch(logBackgroundError('notifyAlbumRevoked'));
    sendSecurePayload(peerId, { type: 'ALBUM_REVOKED', albumId }).catch(logBackgroundError('notifyAlbumRevoked'));
}

// Kleines Deckfoto, das direkt in der Chat-Nachricht mitgeht.
async function createAlbumCover(album) {
    const preview = albumPreviewMode(album);
    if (preview === 'none') return undefined;
    const first = album.items[0] ? await loadMedia(album.items[0].id) : null;
    if (!first?.data) return undefined;
    const image = new Image();
    image.src = first.data;
    await image.decode();
    const scale = Math.min(1, ALBUM_COVER_EDGE / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext('2d');
    if (preview === 'blur') {
        // Stark verkleinern und wieder vergroessern: weichgezeichnet, ohne canvas.filter (geht ueberall).
        // Zwei Stufen (1/48, dann 1/12), damit es weich statt kachelig aussieht.
        const shrink = factor => {
            const step = document.createElement('canvas');
            step.width = Math.max(1, Math.round(canvas.width / factor));
            step.height = Math.max(1, Math.round(canvas.height / factor));
            const stepContext = step.getContext('2d');
            stepContext.imageSmoothingEnabled = true;
            stepContext.imageSmoothingQuality = 'high';
            return { step, stepContext };
        };
        const tiny = shrink(48);
        tiny.stepContext.drawImage(image, 0, 0, tiny.step.width, tiny.step.height);
        const middle = shrink(12);
        middle.stepContext.drawImage(tiny.step, 0, 0, middle.step.width, middle.step.height);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(middle.step, 0, 0, canvas.width, canvas.height);
    } else {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
    }
    const cover = canvas.toDataURL('image/jpeg', 0.6);
    return cover.length <= ALBUM_COVER_MAX_LENGTH ? cover : undefined;
}

// limitId: Schluessel aus ALBUM_SHARE_LIMITS, ohne = normal (unbegrenzt, wie bisher).
async function shareAlbumInChat(albumId, limitId = null) {
    const peerId = state.activeChatPeerId;
    const album = state.albums[albumId];
    if (!peerId || !album || isPeerBlocked(peerId)) return;
    if (!album.items.length) {
        showToast(t('albums.isEmpty'), 'warning');
        return;
    }
    if (!album.acl.includes(peerId)) album.acl.push(peerId);
    const preset = ALBUM_SHARE_LIMITS[limitId] || null;
    const limits = { ...(album.limits || {}) };
    if (!preset) delete limits[peerId];
    else if (preset.kind === 'views') limits[peerId] = { kind: 'views', views: preset.views, used: 0 };
    else limits[peerId] = { kind: 'time', until: (await fetchServerTime().catch(() => ({ now: Date.now() }))).now + preset.ms };
    album.limits = limits;
    await saveAlbum(album);
    scheduleAlbumLimitCheck();
    // Bei Ansichten gibt es keine Schluessel vorab, erst beim Oeffnen.
    if (preset?.kind !== 'views') pushAlbumKeys(peerId, album, true).catch(error => logDebug(`Album key push failed: ${error.message}`));
    closeMediaModal();
    const limit = limits[peerId];
    await sendChatMessage(null, '', {
        albumId: album.id,
        ownerId: state.myProfile.id,
        name: album.name,
        cover: await createAlbumCover(album).catch(() => undefined),
        count: album.items.length,
        ...(limit ? { limit: limit.kind === 'views' ? { kind: 'views', views: limit.views } : { kind: 'time', until: limit.until } } : {})
    });
}

// Abgelaufene Begrenzungen beenden: Frist vorbei bzw. alle Ansichten verbraucht und die letzte vorbei.
async function enforceAlbumLimits(now = null) {
    const current = now ?? (await fetchServerTime().catch(() => ({ now: Date.now() }))).now;
    for (const album of getOwnAlbums()) {
        for (const viewerId of [...album.acl]) {
            const limit = albumLimitFor(album, viewerId);
            if (!limit) continue;
            const over = limit.kind === 'time'
                ? limit.until <= current
                : (limit.used || 0) >= limit.views && (limit.sessionEndsAt || 0) <= current;
            if (over) await revokeAlbumAccess(album.id, viewerId);
        }
    }
    scheduleAlbumLimitCheck(current);
}

function scheduleAlbumLimitCheck(now = Date.now()) {
    clearTimeout(state.albumLimitTimer);
    const ends = getOwnAlbums().flatMap(album => album.acl.map(viewerId => {
        const limit = albumLimitFor(album, viewerId);
        if (!limit) return null;
        return limit.kind === 'time' ? limit.until : (limit.used || 0) >= limit.views ? limit.sessionEndsAt || now : null;
    })).filter(Number.isFinite);
    if (!ends.length) return;
    const next = Math.min(...ends);
    state.albumLimitTimer = setTimeout(() => enforceAlbumLimits().catch(logBackgroundError('enforceAlbumLimits')),
        Math.min(Math.max(0, next - now) + 1000, 2147483647));
}

// ----- P2P-Protokoll -----
function canPeerAccessImage(peerId, imageId) {
    if ((state.myProfile.gallery || []).some(item => item.id === imageId)) return isGalleryVisibleTo(peerId);
    return getOwnAlbums().some(album => album.acl.includes(peerId) && album.items.some(item => item.id === imageId));
}

function findReceivedAlbumItem(peerId, imageId) {
    return Object.values(state.albums)
        .filter(album => album.ownerId === peerId)
        .flatMap(album => album.items)
        .find(item => item.id === imageId);
}

async function handleAlbumRequest(peerId, albumId) {
    const album = state.albums[albumId];
    if (!album || album.ownerId !== state.myProfile.id || !album.acl.includes(peerId)) {
        await sendSecurePayload(peerId, { type: 'ALBUM_DENIED', albumId });
        return;
    }
    const summary = {
        id: album.id,
        name: album.name,
        keyVersion: album.keyVersion || 1,
        updatedAt: album.updatedAt || 0,
        // Weitergebende Betrachter halten sich an die Wasserzeichen-Einstellung des Besitzers.
        watermark: isTraceWatermarkEnabled(),
        items: album.items.map(({ id, version }) => ({ id, version }))
    };
    await sendSecurePayload(peerId, { type: 'ALBUM_RESPONSE', album: summary, manifest: await signAlbumManifest(summary) });
}

// Signiertes Manifest (Name, Version, Bilder): Betrachter koennen es weitergeben, Dritte koennen es
// nicht faelschen.
async function signAlbumManifest(summary) {
    if (!state.myKeys?.ecdsaKeyPair?.privateKey) return null;
    return signEnvelope({ ...summary, ownerId: state.myProfile.id }, state.myKeys.ecdsaKeyPair.privateKey, state.myKeys.jwkEcdsaPublic);
}

// Gueltig nur mit dem gepinnten Schluessel des Besitzers und passender Album-ID.
async function verifyAlbumManifest(manifest, ownerId, albumId) {
    if (manifest?.payload?.ownerId !== ownerId || manifest.payload.id !== albumId) return false;
    const identity = await getPeerIdentity(ownerId);
    return verifyEnvelope(manifest, identity?.profileSigningKey);
}

async function handleAlbumResponse(peerId, payload) {
    const requestKey = `${peerId}:${payload.album?.id}`;
    if (!state.pendingAlbumRequests[requestKey]) return;
    delete state.pendingAlbumRequests[requestKey];
    const items = (Array.isArray(payload.album.items) ? payload.album.items : [])
        .filter(item => typeof item?.id === 'string' && Number.isInteger(item.version))
        .slice(0, 500)
        .map(item => ({ id: item.id.substring(0, 200), version: item.version }));
    const previous = state.albums[payload.album.id];
    const keyVersion = Number.isInteger(payload.album.keyVersion) ? payload.album.keyVersion : 1;
    // Entfernte Bilder loeschen; bei neuer Schluesselversion ist der ganze Ciphertext wertlos.
    const keptIds = new Set(previous?.keyVersion === keyVersion ? items.map(item => item.id) : []);
    await Promise.all((previous?.items || [])
        .filter(item => !keptIds.has(item.id))
        .map(item => deleteDatabaseRecord('media', item.id)));
    if (previous && previous.keyVersion !== keyVersion) delete state.albumKeys[payload.album.id];
    const album = {
        id: payload.album.id,
        ownerId: peerId,
        name: String(payload.album.name || 'Album').substring(0, 80),
        keyVersion,
        items,
        receivedAt: Date.now(),
        ...(await verifyAlbumManifest(payload.manifest, peerId, payload.album.id) ? { manifest: payload.manifest } : {})
    };
    state.albums[album.id] = album;
    await persistAlbum(album);
    // Buendel koennen vor den Album-Metadaten angekommen sein.
    if (!state.albumKeys[album.id]) await loadAlbumKeys(album.id).catch(() => false);
    if (state.albumViewer?.albumId === album.id) await renderAlbumViewer(album);
}

async function forgetReceivedAlbum(peerId, albumId) {
    const album = state.albums[albumId];
    if (album && album.ownerId !== peerId) return;
    // Schluessel-Buendel und Zugangsticket dieses Besitzers auch dann loeschen, wenn das Album nie
    // geoeffnet wurde (dann gibt es nur die Buendel).
    const records = await getAllDatabaseRecords('keys').catch(() => []);
    await Promise.all(records
        .filter(record => typeof record.id === 'string' && record.ownerId === peerId
            && (record.id.startsWith(`${ALBUM_KEY_BUNDLE_PREFIX}${albumId}:`) || record.id === `${ALBUM_TICKET_PREFIX}${albumId}`
                || record.id === `${ALBUM_SELF_DESTRUCT_PREFIX}${albumId}`))
        .map(record => deleteDatabaseRecord('keys', record.id)));
    expireAlbumKeys(albumId, false);
    if (!album) return;
    await Promise.all(album.items.map(item => deleteDatabaseRecord('media', item.id)));
    await deleteDatabaseRecord('albums', albumId);
    delete state.albums[albumId];
    if (state.albumViewer?.albumId === albumId) {
        renderMediaModalMessage(t('albums.youNoLongerHaveAccess'), 'fa-lock');
    }
}

async function handleAlbumDenied(peerId, albumId) {
    delete state.pendingAlbumRequests[`${peerId}:${albumId}`];
    await forgetReceivedAlbum(peerId, albumId);
    if (state.albumViewer?.albumId === albumId) renderMediaModalMessage(t('albums.youDontHaveAccessTo'), 'fa-lock');
}

// ----- Medien-Modal (Album, Medienuebersicht, Albumauswahl) -----
function openMediaModal(title) {
    runMediaModalCleanup();
    document.getElementById('media-modal-title').textContent = title;
    document.getElementById('media-modal-content').innerHTML = '';
    const modal = document.getElementById('media-modal');
    if (modal.classList.contains('hidden')) {
        modal.classList.remove('hidden');
        pushModalEntry('media', hideMediaModal);
    }
    return document.getElementById('media-modal-content');
}

function closeMediaModal() {
    if (document.getElementById('media-modal').classList.contains('hidden')) return;
    dismissModalEntry('media', hideMediaModal);
}

// Inhalte mit eigenen Ressourcen (z. B. Video als Blob-URL) raeumen beim Schliessen/Ersetzen auf.
function runMediaModalCleanup() {
    const cleanup = state.mediaModalCleanup;
    state.mediaModalCleanup = null;
    if (cleanup) cleanup();
}

function hideMediaModal() {
    runMediaModalCleanup();
    const viewing = state.albumViewer;
    state.albumViewer = null;
    // Begrenzte Ansicht endet mit dem Schliessen (nicht erst nach 15 Minuten).
    if (viewing) endLimitedAlbumView(viewing.albumId).catch(logBackgroundError('endLimitedAlbumView'));
    document.getElementById('media-modal').classList.add('hidden');
    document.getElementById('media-modal-content').innerHTML = '';
}

function renderMediaModalMessage(text, icon = 'fa-images') {
    showEmptyState(document.getElementById('media-modal-content'), { icon, text });
}

// Alle bereits geladenen Bilder des offenen Medien-Modals, in Anzeigereihenfolge.
function openViewerFromTiles(dataUrl) {
    const images = [...document.querySelectorAll('#media-modal-content [data-viewer-image] canvas')].map(secureImageSource).filter(Boolean);
    openImageViewer(images, Math.max(0, images.indexOf(dataUrl)));
}

function createThumbnail(dataUrl, onClick) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'aspect-square rounded-xl overflow-hidden border border-slate-800 bg-slate-800 hover:border-brand-500 transition';
    if (dataUrl && isSafeInlineImage(dataUrl)) {
        tile.dataset.viewerImage = 'true';
        tile.appendChild(createSecureImage(dataUrl, 'w-full h-full object-cover'));
    } else {
        tile.classList.add('animate-pulse', 'flex', 'items-center', 'justify-center', 'text-brand-500');
        tile.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    }
    tile.onclick = onClick;
    return tile;
}

async function openAlbumViewer(albumId, reference = null) {
    const album = state.albums[albumId];
    const ownerId = album?.ownerId || reference?.ownerId;
    openMediaModal(album?.name || reference?.name || t('albums.album'));
    state.albumViewer = { albumId, ownerId };
    if (album) await renderAlbumViewer(album);
    if (ownerId && ownerId !== state.myProfile.id) {
        if (!album) renderMediaModalMessage(t('albums.loadingAlbumFromOwnerOr'), 'fa-spinner');
        state.pendingAlbumRequests[`${ownerId}:${albumId}`] = true;
        await sendSecurePayload(ownerId, { type: 'ALBUM_REQUEST', albumId });
        await requestAlbumKeys(ownerId, albumId);
        if (!isSecureChannelOpen(ownerId)) requestAlbumFromSwarm(ownerId, albumId);
    }
}

async function renderAlbumViewer(album) {
    if (state.albumViewer?.albumId !== album.id) return;
    document.getElementById('media-modal-title').textContent = album.name;
    const content = document.getElementById('media-modal-content');
    content.innerHTML = '';
    if (!album.items.length) {
        renderMediaModalMessage(t('albums.thisAlbumIsEmpty'));
        return;
    }
    const isOwn = album.ownerId === state.myProfile.id;
    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-3 sm:grid-cols-4 gap-2';
    content.appendChild(grid);
    for (const item of album.items) {
        if (!isOwn) {
            grid.appendChild(await renderReceivedAlbumTile(album, item));
            continue;
        }
        const media = await loadMedia(item.id);
        const hasCurrent = media && media.version === item.version;
        const tile = createThumbnail(hasCurrent ? media.data : null, () => hasCurrent && openViewerFromTiles(media.data));
        tile.id = `album-tile-${item.id}`;
        const wrapper = document.createElement('div');
        wrapper.className = 'relative group';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'absolute top-1 right-1 w-6 h-6 bg-red-600 hover:bg-red-500 text-white rounded-full text-xs';
        remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        remove.setAttribute('aria-label', t('common.removeImage'));
        remove.onclick = () => removeAlbumImage(album.id, item.id);
        wrapper.append(tile, remove);
        grid.appendChild(wrapper);
    }
}

// Empfangene Albumbilder liegen nur als Ciphertext vor und brauchen den Schluessel der aktuellen Epoche.
async function renderReceivedAlbumTile(album, item) {
    const stored = await loadMedia(item.id);
    const isCurrent = stored?.encrypted && stored.version === item.version && stored.keyVersion === album.keyVersion
        && stored.keyScheme === ALBUM_KEY_SCHEME;
    const ownerOnline = isSecureChannelOpen(album.ownerId);
    // Weitergegebene Kopien werden durch die des Besitzers ersetzt, sobald er erreichbar ist.
    if (!isCurrent || (stored.relayedBy && ownerOnline)) {
        state.pendingImageRequests[`${album.ownerId}:${item.id}`] = item.version;
        sendSecurePayload(album.ownerId, { type: 'IMAGE_REQUEST', imageId: item.id, version: item.version }).catch(logBackgroundError('renderReceivedAlbumTile'));
        if (!isCurrent && !ownerOnline) requestAlbumImageFromSwarm(album, item).catch(logBackgroundError('renderReceivedAlbumTile'));
    }
    const dataUrl = isCurrent ? await decryptAlbumImage(album.id, item.id, stored.encrypted) : null;
    const tile = dataUrl
        ? createThumbnail(dataUrl, () => openViewerFromTiles(dataUrl))
        : isCurrent ? createLockedTile() : createThumbnail(null, () => {});
    tile.id = `album-tile-${item.id}`;
    return tile;
}

function createLockedTile() {
    const tile = document.createElement('div');
    tile.className = 'aspect-square rounded-xl border border-slate-800 bg-slate-900 flex flex-col items-center justify-center gap-1 text-slate-500 text-[10px] text-center p-1';
    tile.innerHTML = `<i class="fa-solid fa-lock text-lg"></i><span>${t('albums.keyExpired')}</span>`;
    return tile;
}

// Medienuebersicht des aktiven Chats: alle Snaps und geteilten Alben.
const MEDIA_FILTERS = [
    { id: 'all', label: t('albums.both') },
    { id: 'mine', label: t('albums.mine') },
    { id: 'theirs', label: t('albums.others') }
];

function openChatMediaOverview(filter = state.mediaOverviewFilter || 'all') {
    const peerId = state.activeChatPeerId;
    if (!peerId) return;
    state.mediaOverviewFilter = filter;
    const content = openMediaModal(t('albums.mediaInChat'));
    // Filter: alle, nur eigene oder nur die des Chat-Partners.
    const switcher = document.createElement('div');
    switcher.className = 'flex gap-1 p-1 mb-3 rounded-xl bg-slate-950 border border-slate-800 text-xs w-fit';
    MEDIA_FILTERS.forEach(option => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `px-3 py-1.5 rounded-lg font-semibold transition ${option.id === filter ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-slate-200'}`;
        button.textContent = option.label;
        button.onclick = () => openChatMediaOverview(option.id);
        switcher.appendChild(button);
    });
    content.appendChild(switcher);
    const messages = (state.chats[peerId] || []).filter(message => !message.deleted && !message.held
        && (filter === 'all' || (filter === 'mine') === (message.senderId === state.myProfile.id)));
    const snaps = messages.filter(isInlineSnap);
    const albums = messages.filter(message => message.album);
    if (!snaps.length && !albums.length) {
        const note = createEmptyState({ icon: 'fa-images', text: filter === 'all' ? t('albums.noImagesHaveBeenShared') : t('albums.noImagesInThisSelection') });
        content.appendChild(note);
        return;
    }
    const addSection = (title, build) => {
        const heading = document.createElement('h4');
        heading.className = 'text-xs font-bold uppercase tracking-wider text-slate-400 mt-2 mb-2';
        heading.textContent = title;
        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-3 sm:grid-cols-4 gap-2';
        build(grid);
        content.append(heading, grid);
    };
    if (snaps.length) {
        addSection(`Snaps (${snaps.length})`, grid => snaps.slice().reverse()
            .forEach(message => grid.appendChild(createThumbnail(message.snapData, () => openViewerFromTiles(message.snapData)))));
    }
    if (albums.length) {
        addSection(`Alben (${albums.length})`, grid => albums.slice().reverse().forEach(message => {
            const tile = createThumbnail(message.album.cover, () => openAlbumViewer(message.album.albumId, message.album));
            delete tile.dataset.viewerImage;
            tile.classList.add('relative');
            const label = document.createElement('span');
            label.className = 'absolute inset-x-0 bottom-0 bg-black/60 text-[10px] text-white px-1.5 py-1 truncate';
            label.textContent = message.album.name;
            tile.appendChild(label);
            grid.appendChild(tile);
        }));
    }
}

function openAlbumPicker() {
    if (!state.activeChatPeerId) return;
    const content = openMediaModal(t('common.shareAlbum'));
    const albums = getOwnAlbums().filter(album => album.items.length);
    if (!albums.length) {
        renderMediaModalMessage(t('albums.youDontHaveAlbumWith'));
        return;
    }
    albums.forEach(album => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'w-full flex items-center justify-between gap-3 p-3 mb-2 rounded-xl border border-slate-800 bg-slate-950/40 hover:border-brand-500 text-left';
        const name = document.createElement('span');
        name.className = 'text-sm text-slate-200 truncate';
        name.textContent = album.name;
        const meta = document.createElement('span');
        meta.className = 'text-xs text-slate-500 shrink-0';
        meta.textContent = `${t('albums.images2', { count: album.items.length })}${album.acl.includes(state.activeChatPeerId) ? t('albums.alreadyShared') : ''}`;
        button.append(name, meta);
        button.onclick = () => openAlbumShareOptions(album.id);
        content.appendChild(button);
    });
}

// Zweiter Schritt im Sendemenue: normal teilen (ueberspringen) oder begrenzt wie ein Snap.
function openAlbumShareOptions(albumId) {
    const album = state.albums[albumId];
    if (!album) return;
    const content = document.getElementById('media-modal-content');
    document.getElementById('media-modal-title').textContent = t('albums.shareAlbumName', { name: album.name });
    content.replaceChildren();
    const option = (id, icon, title, text, primary = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.shareLimit = id || 'none';
        button.className = `w-full flex items-center gap-3 p-3 mb-2 rounded-xl border text-left ${primary ? 'border-brand-500/60 bg-brand-500/10' : 'border-slate-800 bg-slate-950/40 hover:border-slate-600'}`;
        button.innerHTML = `<i class="fa-solid ${icon} w-5 text-center text-brand-400"></i>`;
        const label = document.createElement('span');
        label.className = 'min-w-0';
        const heading = document.createElement('span');
        heading.className = 'block text-sm font-semibold text-slate-100';
        heading.textContent = title;
        label.appendChild(heading);
        if (text) {
            const description = document.createElement('span');
            description.className = 'block text-xs text-slate-400';
            description.textContent = text;
            label.appendChild(description);
        }
        button.appendChild(label);
        button.onclick = () => shareAlbumInChat(albumId, id).catch(logBackgroundError('shareAlbumInChat'));
        return button;
    };
    const section = text => {
        const heading = document.createElement('div');
        heading.className = 'text-[11px] font-bold uppercase tracking-wide text-slate-500 mt-3 mb-2';
        heading.textContent = text;
        return heading;
    };
    const chips = (ids, labels) => {
        const row = document.createElement('div');
        row.className = 'grid grid-cols-3 gap-2';
        ids.forEach((id, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.shareLimit = id;
            button.className = 'btn-secondary justify-center';
            button.textContent = labels[index];
            button.onclick = () => shareAlbumInChat(albumId, id).catch(logBackgroundError('shareAlbumInChat'));
            row.appendChild(button);
        });
        return row;
    };
    content.append(
        option(null, 'fa-share', t('albums.shareNormally'), t('albums.shareNormallyText'), true),
        section(t('albums.limitedViews')),
        chips(['views1', 'views2', 'views3'], [t('snaps.viewOnce'), t('snaps.viewTwice'), t('snaps.view3Times')]),
        section(t('albums.limitedTime')),
        chips(['m15', 'h1', 'h24'], [t('common.15Min'), t('settings.1Hour'), t('settings.24Hours')])
    );
    const note = document.createElement('p');
    note.className = 'text-[11px] text-slate-500 mt-3';
    note.textContent = t('albums.limitedNote');
    content.appendChild(note);
}

// Album-Karte in einer Chat-Nachricht.
function renderAlbumMessage(bubble, album, messageId = null) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'block w-48 sm:w-56 text-left';
    if (album.cover && isSafeInlineImage(album.cover)) {
        card.appendChild(createSecureImage(album.cover, 'w-full aspect-square object-cover rounded-xl mb-1.5 border border-slate-900/50',
            null, { reuseKey: messageId ? `album-card:${messageId}` : null }));
    }
    const title = document.createElement('div');
    title.className = 'font-semibold';
    title.innerHTML = '<i class="fa-solid fa-images mr-1"></i>';
    title.appendChild(document.createTextNode(album.name));
    const meta = document.createElement('div');
    meta.className = 'opacity-75 text-[11px]';
    meta.textContent = Number.isInteger(album.count) ? t('albums.imagesTapToOpen', { count: album.count }) : t('albums.tapToOpen');
    card.append(title, meta);
    if (album.limit) {
        const limit = document.createElement('div');
        limit.className = 'text-[11px] font-semibold mt-0.5';
        limit.innerHTML = '<i class="fa-solid fa-hourglass-half mr-1"></i>';
        limit.appendChild(document.createTextNode(album.limit.kind === 'views'
            ? t('albums.limitViews', { views: album.limit.views })
            : album.limit.until > Date.now() ? t('albums.availableUntil', { time: formatClockTime(album.limit.until) }) : t('albums.limitExpired')));
        card.appendChild(limit);
    }
    card.onclick = event => {
        event.stopPropagation();
        openAlbumViewer(album.albumId, album);
    };
    bubble.appendChild(card);
}

// ----- Verwaltung im Profil -----
// Chat-/Freunde-Modus: Alben-Karte nur, wenn es eigene Alben gibt (damit geteilte nicht vergessen
// werden); in Grid und Event immer.
function syncAlbumCardVisibility() {
    const hide = isSocialMode() && getOwnAlbums().length === 0;
    document.getElementById('album-manager-card')?.classList.toggle('hidden', hide);
}

// Erstes Bild je Album (Bild-ID -> Data-URL) fuer die Vorschau in der Verwaltung.
const albumManagerCovers = new Map();

function renderAlbumManager() {
    syncAlbumCardVisibility();
    const container = document.getElementById('album-manager-list');
    if (!container) return;
    container.replaceChildren();
    const albums = getOwnAlbums();
    if (!albums.length) {
        container.appendChild(createEmptyState({ icon: 'fa-images', title: t('albums.noAlbumsYet'), text: t('albums.createFirstAlbum'), compact: true }));
        return;
    }
    albums.forEach(album => container.appendChild(createAlbumManagerItem(album)));
}

function albumIconButton(icon, label, onClick, danger = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `icon-btn${danger ? ' is-danger' : ''}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    button.onclick = onClick;
    return button;
}

// Zeile im Stil der Einstellungen: Titel links, Auswahl rechts.
function albumSettingRow(title, control) {
    const row = document.createElement('label');
    row.className = 'setting-row';
    const text = document.createElement('span');
    text.className = 'setting-text';
    const label = document.createElement('span');
    label.className = 'setting-title text-sm';
    label.textContent = title;
    text.appendChild(label);
    control.classList.add('setting-select');
    row.append(text, control);
    return row;
}

function createAlbumManagerItem(album) {
    const card = document.createElement('div');
    card.className = 'album-item';
    card.dataset.albumId = album.id;

    const head = document.createElement('div');
    head.className = 'album-item-head';
    const cover = document.createElement('button');
    cover.type = 'button';
    cover.className = 'album-cover';
    cover.setAttribute('aria-label', t('albums.openAlbum', { name: album.name }));
    cover.onclick = () => openAlbumViewer(album.id);
    // Vorschaubild synchron, sobald es einmal geladen ist (sonst kurz das Platzhalter-Symbol bei jedem
    // Neuaufbau der Liste).
    const first = album.items[0];
    const known = first ? albumManagerCovers.get(first.id) : null;
    if (known) {
        cover.appendChild(createSecureImage(known, '', null, { reuseKey: `album-cover:${album.id}` }));
    } else {
        cover.innerHTML = '<i class="fa-solid fa-images"></i>';
        if (first) {
            loadMedia(first.id).then(media => {
                if (!media?.data || !isSafeInlineImage(media.data)) return;
                albumManagerCovers.set(first.id, media.data);
                cover.replaceChildren(createSecureImage(media.data, '', null, { reuseKey: `album-cover:${album.id}` }));
            }).catch(() => {});
        }
    }
    const info = document.createElement('div');
    info.className = 'min-w-0 flex-1';
    const name = document.createElement('div');
    name.className = 'text-sm font-semibold text-slate-100 truncate';
    name.textContent = album.name;
    const meta = document.createElement('div');
    meta.className = 'text-xs text-slate-400 truncate';
    meta.textContent = [
        t('albums.images2', { count: album.items.length }),
        album.acl.length ? t('albums.sharedWithCount', { count: album.acl.length }) : t('albums.notShared')
    ].join(' · ');
    info.append(name, meta);

    const add = document.createElement('label');
    add.className = 'icon-btn';
    add.title = t('albums.addImages');
    add.setAttribute('aria-label', t('albums.addImages'));
    add.innerHTML = '<i class="fa-solid fa-plus"></i>';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.className = 'hidden';
    fileInput.onchange = () => addAlbumImages(album.id, fileInput);
    add.appendChild(fileInput);
    head.append(cover, info, add, albumIconButton('fa-trash', t('common.delete'), () => deleteAlbum(album.id), true));
    card.appendChild(head);

    // Einstellungen des Albums, eingeklappt.
    const settings = document.createElement('details');
    settings.className = 'setting-details';
    const summary = document.createElement('summary');
    summary.className = 'setting-details-summary';
    summary.textContent = t('albums.albumSettings');
    settings.append(summary, ...createAlbumKeyTimingControls(album), albumSettingRow(t('albums.previewInChat'), createAlbumPreviewSelect(album)));
    card.appendChild(settings);

    // Zugriff: eine Zeile pro Person (eigene Gueltigkeit bzw. Begrenzung, Entziehen); ab 3 eingeklappt.
    const rows = album.acl.map(peerId => {
        const row = document.createElement('div');
        row.className = 'album-access-row';
        row.dataset.viewer = peerId;
        const person = document.createElement('span');
        person.className = 'flex-1 min-w-0 truncate text-sm text-slate-200';
        person.innerHTML = '<i class="fa-solid fa-user text-slate-500 mr-1.5"></i>';
        person.appendChild(document.createTextNode(getPeerPresentation(peerId).name || HIDDEN_PEER_NAME));
        row.appendChild(person);
        const limit = albumLimitFor(album, peerId);
        if (limit) {
            const chip = document.createElement('span');
            chip.className = 'album-limit-chip';
            chip.innerHTML = '<i class="fa-solid fa-hourglass-half"></i>';
            chip.appendChild(document.createTextNode(albumLimitLabel(limit)));
            row.appendChild(chip);
        } else {
            const select = createViewerKeyTimingSelect(album, peerId);
            select.className = 'setting-select';
            row.appendChild(select);
        }
        row.appendChild(albumIconButton('fa-user-xmark', t('albums.revokeAccess'), () => revokeAlbumAccess(album.id, peerId), true));
        return row;
    });
    if (rows.length >= 3) {
        const access = document.createElement('details');
        access.className = 'setting-details album-access';
        const summary = document.createElement('summary');
        summary.className = 'setting-details-summary';
        summary.textContent = t('albums.accessCount', { count: rows.length });
        access.append(summary, ...rows);
        card.appendChild(access);
    } else {
        rows.forEach(row => card.appendChild(row));
    }
    return card;
}

// ----- Rotierende Album-Schluessel -----
// Pro Betrachter und Bild: Schluessel = HKDF(Albumgeheimnis des Besitzers, Album + Version, Bild + Betrachter).
// Der Betrachter bekommt die Bilder nur als Ciphertext und die Schluessel nur fuer die laufende
// Epoche (Serverzeit). Sie liegen ausschliesslich im Arbeitsspeicher und verfallen mit der Epoche.
function findOwnAlbumForImage(imageId) {
    return getOwnAlbums().find(album => album.items.some(item => item.id === imageId)) || null;
}

// Schema 2 (R3): ein Inhaltsschluessel pro Bild und Version, fuer alle Betrachter gleich. So kann ein
// Betrachter einem anderen das Bild weitergeben, wenn der Besitzer offline ist. Das Wasserzeichen
// setzt jeweils der Sender (Besitzer oder weitergebender Betrachter) fuer den Empfaenger.
const ALBUM_KEY_SCHEME = 2;

async function deriveAlbumImageKey(album, imageId) {
    const secret = await window.crypto.subtle.importKey('raw', base64ToBytes(album.secret), 'HKDF', false, ['deriveKey']);
    return window.crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new TextEncoder().encode(`${album.id}:${album.keyVersion || 1}`),
            info: new TextEncoder().encode(`og-album-image:${imageId}`)
        },
        secret,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt']
    );
}

async function serveAlbumImage(peerId, imageId) {
    const album = findOwnAlbumForImage(imageId);
    const item = album?.items.find(entry => entry.id === imageId);
    const media = item ? await loadMedia(imageId) : null;
    if (!album || !media?.data || !album.acl.includes(peerId)) return;
    const key = await deriveAlbumImageKey(album, imageId);
    await sendSecurePayload(peerId, {
        type: 'IMAGE_RESPONSE',
        imageId,
        version: item.version,
        keyVersion: album.keyVersion || 1,
        keyScheme: ALBUM_KEY_SCHEME,
        encrypted: await encryptAlbumImageFor(peerId, media.data, key, isTraceWatermarkEnabled())
    });
}

// Wasserzeichen fuer den Empfaenger (wenn gewuenscht), dann mit dem Inhaltsschluessel verschluesseln.
async function encryptAlbumImageFor(recipientId, dataUrl, key, watermark = true) {
    const marked = watermark && typeof embedWatermark === 'function' ? await embedWatermark(dataUrl, recipientId) : dataUrl;
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(marked));
    return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function handleAlbumImageResponse(peerId, payload) {
    const requestKey = `${peerId}:${payload.imageId}`;
    const item = findReceivedAlbumItem(peerId, payload.imageId);
    const album = Object.values(state.albums).find(entry => entry.ownerId === peerId && entry.items.includes(item));
    if (!item || !album || state.pendingImageRequests[requestKey] !== payload.version || item.version !== payload.version
        || payload.keyVersion !== album.keyVersion
        || typeof payload.encrypted?.iv !== 'string' || typeof payload.encrypted?.ciphertext !== 'string') {
        logDebug(`Rejected unsolicited album image ${payload.imageId} from ${peerId}.`);
        return;
    }
    delete state.pendingImageRequests[requestKey];
    await storeReceivedAlbumImage(album, payload, null);
}

// Speichert ein empfangenes Albumbild (vom Besitzer oder weitergegeben) nur verschluesselt.
async function storeReceivedAlbumImage(album, payload, relayedBy) {
    const encrypted = { iv: payload.encrypted.iv, ciphertext: payload.encrypted.ciphertext };
    await cacheMediaPayload(payload.imageId, {
        encrypted,
        version: payload.version,
        keyVersion: payload.keyVersion,
        keyScheme: payload.keyScheme === ALBUM_KEY_SCHEME ? ALBUM_KEY_SCHEME : 1,
        ...(relayedBy ? { relayedBy } : {})
    });
    if (state.albumViewer?.albumId !== album.id) return;
    const dataUrl = await decryptAlbumImage(album.id, payload.imageId, encrypted);
    const tile = document.getElementById(`album-tile-${payload.imageId}`);
    if (tile) {
        const replacement = dataUrl ? createThumbnail(dataUrl, () => openViewerFromTiles(dataUrl)) : createLockedTile();
        replacement.id = `album-tile-${payload.imageId}`;
        tile.replaceWith(replacement);
    }
}

// ----- Alben v2: eigener Key + Source-Key + rollender Source-Key -----
// KEK_e = HKDF(ikm = ECDH(eigener Identitaetsschluessel, Schluessel der Gegenseite),
//              salt = R_e (rollender Source-Key des Besitzers), info = Album:Epoche:Version).
// Der Besitzer schickt pro Betrachter ein Buendel fuer die laufende und die naechste Epoche:
// R_e plus die mit KEK_e verpackten Inhaltsschluessel. Weg: P2P, sonst Pfad C (Chat-Operation
// ALBUM_KEYS, ohne Push). Der Betrachter speichert nur das Buendel; die Inhaltsschluessel entstehen
// erst beim Ansehen, nicht exportierbar und nur im Arbeitsspeicher.
const ALBUM_KEY_BUNDLE_PREFIX = 'album-keys:';
// Der Besitzer stellt pro Album ein, wie lange ein rollender Key gilt (0 = Server-Wert
// MEDIA_KEY_EPOCH_MINUTES) und wie viele Epochen er vorab ausliefert.
const ALBUM_KEY_EPOCH_OPTIONS = [0, 15, 60, 180, 1440, 10080];
const ALBUM_KEY_AHEAD_OPTIONS = [1, 2, 3];
const MAX_ALBUM_KEY_BUNDLES = 1 + Math.max(...ALBUM_KEY_AHEAD_OPTIONS);
const ALBUM_DEFAULTS_RECORD_ID = 'album-defaults';

// Gueltigkeit pro Betrachter (album.viewerKeyEpochs[viewerId], Minuten) ueberschreibt die des Albums.
function albumKeyMinutesFor(album, viewerId = null) {
    const override = viewerId ? album.viewerKeyEpochs?.[viewerId] : undefined;
    if (ALBUM_KEY_EPOCH_OPTIONS.includes(override) && override > 0) return override;
    return ALBUM_KEY_EPOCH_OPTIONS.includes(album.keyEpochMinutes) ? album.keyEpochMinutes : 0;
}

function albumEpochMs(album, time, viewerId = null) {
    const minutes = albumKeyMinutesFor(album, viewerId);
    return minutes > 0 ? minutes * 60 * 1000 : time.epochMs;
}

function albumEpochsAhead(album) {
    return ALBUM_KEY_AHEAD_OPTIONS.includes(album.keyEpochsAhead) ? album.keyEpochsAhead : 1;
}

// Laufende Epoche eines Albums (fuer einen Betrachter) nach Serverzeit.
function albumEpoch(album, time, viewerId = null) {
    const epochMs = albumEpochMs(album, time, viewerId);
    const epoch = Math.floor(time.now / epochMs);
    return { epoch, epochMs, epochEndsAt: (epoch + 1) * epochMs };
}

async function pairwiseAlbumSecret(peerId) {
    const peerJwk = await getPeerIdentityKey(peerId);
    if (!peerJwk) throw new Error('No trusted identity key for this peer.');
    const publicKey = await window.crypto.subtle.importKey('jwk', peerJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return window.crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, state.myKeys.keyPair.privateKey, 256);
}

async function deriveAlbumKek(peerId, rollingKey, albumId, epoch, keyVersion) {
    const shared = await window.crypto.subtle.importKey('raw', await pairwiseAlbumSecret(peerId), 'HKDF', false, ['deriveKey']);
    return window.crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: base64ToBytes(rollingKey),
            info: new TextEncoder().encode(`og-album:${albumId}:${epoch}:${keyVersion}`)
        },
        shared,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

// Besitzer: zufaelliger rollender Key pro Album, Epochenlaenge und Epoche (Betrachter koennen
// unterschiedliche Laengen haben); abgelaufene werden verworfen. Schluessel "<epochMs>:<epoch>".
function getRollingKey(album, epoch, epochMs, now) {
    album.rollingKeys = Object.fromEntries(Object.entries(album.rollingKeys || {}).filter(([key]) => {
        const [storedMs, storedEpoch] = key.split(':').map(Number);
        return Number.isFinite(storedMs) && Number.isFinite(storedEpoch) && (storedEpoch + 1) * storedMs > now;
    }));
    const key = `${epochMs}:${epoch}`;
    if (!album.rollingKeys[key]) album.rollingKeys[key] = bytesToBase64(window.crypto.getRandomValues(new Uint8Array(32)));
    return album.rollingKeys[key];
}

async function buildAlbumKeyBundle(album, viewerId, current, epoch) {
    const keyVersion = album.keyVersion || 1;
    const keys = {};
    for (const item of album.items) {
        const key = await deriveAlbumImageKey(album, item.id);
        keys[item.id] = bytesToBase64(new Uint8Array(await window.crypto.subtle.exportKey('raw', key)));
    }
    const rollingKey = getRollingKey(album, epoch, current.epochMs, current.epoch * current.epochMs);
    const kek = await deriveAlbumKek(viewerId, rollingKey, album.id, epoch, keyVersion);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, new TextEncoder().encode(JSON.stringify(keys)));
    return {
        albumId: album.id,
        keyVersion,
        epoch,
        epochMs: current.epochMs,
        epochEndsAt: (epoch + 1) * current.epochMs,
        rollingKey,
        iv: bytesToBase64(iv),
        wrapped: bytesToBase64(new Uint8Array(wrapped))
    };
}

// Schickt einem Betrachter die Buendel fuer jetzt und die vorab eingestellten Epochen
// (einmal pro Epoche, Version und Einstellung).
async function pushAlbumKeys(viewerId, album, force = false, { sessionUntil = null } = {}) {
    if (!album || album.ownerId !== state.myProfile.id || !album.acl.includes(viewerId) || !album.items.length) return;
    const limit = albumLimitFor(album, viewerId);
    // Begrenzt auf Ansichten: nur fuer eine gezaehlte Ansicht (handleAlbumKeyRequest).
    if (limit?.kind === 'views' && !sessionUntil) return;
    const time = await fetchServerTime();
    const cap = sessionUntil ?? (limit?.kind === 'time' ? limit.until : null);
    if (cap !== null && cap <= time.now) return;
    const current = albumEpoch(album, time, viewerId);
    const ahead = albumEpochsAhead(album);
    const marker = `${album.keyVersion || 1}:${current.epochMs}:${current.epoch}:${ahead}:${cap || ''}`;
    const pushed = state.albumKeyPushes[viewerId] || (state.albumKeyPushes[viewerId] = {});
    if (!force && pushed[album.id] === marker) return;
    const bundles = [];
    for (let offset = 0; offset <= ahead; offset++) {
        const bundle = await buildAlbumKeyBundle(album, viewerId, current, current.epoch + offset);
        bundle.epochStartsAt = bundle.epoch * current.epochMs;
        if (cap !== null) {
            // Nichts ueber die Frist hinaus: spaetere Epochen weglassen, die laufende kuerzen.
            if (bundle.epochStartsAt >= cap) break;
            bundle.epochEndsAt = Math.min(bundle.epochEndsAt, cap);
        }
        if (sessionUntil) bundle.session = true;
        // Zeitlich begrenzt: der Betrachter raeumt zur Frist selbst auf (auch wenn der Besitzer dann offline ist).
        else if (cap !== null) bundle.limitedUntil = cap;
        bundles.push(bundle);
    }
    if (!bundles.length) return;
    await persistAlbum(album);
    pushed[album.id] = marker;
    const operation = {
        operationId: `albumkeys:${album.id}:${marker}:${window.crypto.randomUUID()}`,
        type: 'ALBUM_KEYS',
        actorId: state.myProfile.id,
        createdAt: Date.now(),
        bundles,
        ticket: await signAlbumTicket(album, viewerId, bundles.at(-1).epochEndsAt)
    };
    // Mit Rueckruf: steht nach 10 s kein Kanal, geht das Buendel ueber Pfad C.
    await sendSecurePayload(viewerId, { type: 'CHAT_OPERATION', operation }, () => {});
}

async function pushAlbumKeysToPeer(peerId) {
    for (const album of getOwnAlbums().filter(entry => entry.acl.includes(peerId))) {
        await pushAlbumKeys(peerId, album).catch(error => logDebug(`Album key push failed: ${error.message}`));
    }
}

// Beim Start und zu jedem Epochenwechsel an alle Betrachter.
async function pushAllAlbumKeys() {
    clearTimeout(state.albumKeyPushTimer);
    const viewers = new Set(getOwnAlbums().flatMap(album => album.acl));
    for (const viewerId of viewers) await pushAlbumKeysToPeer(viewerId);
    const time = await fetchServerTime().catch(() => null);
    if (!time) return;
    // Naechster Lauf zum fruehesten Epochenende aller eigenen Alben.
    const nextEnd = Math.min(time.epochEndsAt, ...getOwnAlbums().flatMap(album => [
        albumEpoch(album, time).epochEndsAt,
        ...album.acl.map(viewerId => albumEpoch(album, time, viewerId).epochEndsAt)
    ]));
    state.albumKeyPushTimer = setTimeout(() => pushAllAlbumKeys().catch(logBackgroundError('pushAllAlbumKeys')), Math.min(nextEnd - time.now + 1000, 2147483647));
}

// ----- Einstellungen: Schluessel-Gueltigkeit -----
async function loadAlbumDefaults() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(ALBUM_DEFAULTS_RECORD_ID)).catch(() => null);
    if (stored) {
        state.albumDefaults = {
            epochMinutes: ALBUM_KEY_EPOCH_OPTIONS.includes(stored.epochMinutes) ? stored.epochMinutes : 0,
            epochsAhead: ALBUM_KEY_AHEAD_OPTIONS.includes(stored.epochsAhead) ? stored.epochsAhead : 1
        };
    } else {
        const minutes = clientDefault('albumKeyEpochMinutes', 0);
        const ahead = clientDefault('albumKeyEpochsAhead', 1);
        state.albumDefaults = {
            epochMinutes: ALBUM_KEY_EPOCH_OPTIONS.includes(minutes) ? minutes : 0,
            epochsAhead: ALBUM_KEY_AHEAD_OPTIONS.includes(ahead) ? ahead : 1
        };
    }
    renderAlbumDefaults();
}

async function updateAlbumDefault(key, value) {
    const options = key === 'epochMinutes' ? ALBUM_KEY_EPOCH_OPTIONS : ALBUM_KEY_AHEAD_OPTIONS;
    if (!options.includes(value)) return;
    state.albumDefaults = { ...state.albumDefaults, [key]: value };
    try {
        await putDatabaseRecord('keys', { id: ALBUM_DEFAULTS_RECORD_ID, ...state.albumDefaults });
    } catch (error) {
        logDebug(`Could not store album defaults: ${error.message}`);
        showToast(t('common.settingCouldNotBeSaved'), 'error');
    }
    renderAlbumDefaults();
}

function renderAlbumDefaults() {
    const minutes = document.getElementById('album-default-epoch');
    if (minutes) minutes.value = String(state.albumDefaults.epochMinutes);
    const ahead = document.getElementById('album-default-ahead');
    if (ahead) ahead.value = String(state.albumDefaults.epochsAhead);
}

function albumEpochLabel(minutes) {
    if (!minutes) return t('albums.serverDefault');
    if (minutes === 10080) return t('albums.oneWeek');
    return minutes < 60 ? `${minutes} min` : `${minutes / 60} h`;
}

// Besitzer aendert die Gueltigkeit: sofort neue Buendel an alle Betrachter. Alte Buendel laufen
// zu ihrem Epochenende ab; die Inhaltsschluessel (und damit gecachte Bilder) bleiben gleich.
async function updateAlbumKeyTiming(albumId, key, value) {
    const album = state.albums[albumId];
    if (!album || album.ownerId !== state.myProfile.id) return;
    const options = key === 'keyEpochMinutes' ? ALBUM_KEY_EPOCH_OPTIONS : ALBUM_KEY_AHEAD_OPTIONS;
    if (!options.includes(value)) return;
    album[key] = value;
    await saveAlbum(album);
    for (const viewerId of album.acl) {
        await pushAlbumKeys(viewerId, album, true).catch(logBackgroundError('updateAlbumKeyTiming'));
    }
    await pushAllAlbumKeys().catch(logBackgroundError('updateAlbumKeyTiming'));
}

async function updateAlbumPreview(albumId, value) {
    const album = state.albums[albumId];
    if (!album || album.ownerId !== state.myProfile.id || !ALBUM_PREVIEW_OPTIONS.includes(value)) return;
    album.preview = value;
    await saveAlbum(album);
}

// Gilt fuer kuenftig geteilte Album-Karten; schon gesendete behalten ihr Deckbild.
function createAlbumPreviewSelect(album) {
    const select = document.createElement('select');
    select.dataset.albumPreview = album.id;
    select.setAttribute('aria-label', t('albums.previewInChat'));
    const labels = { normal: t('albums.previewNormal'), blur: t('albums.previewBlur'), none: t('albums.previewNone') };
    ALBUM_PREVIEW_OPTIONS.forEach(option => {
        const entry = document.createElement('option');
        entry.value = option;
        entry.textContent = labels[option];
        select.appendChild(entry);
    });
    select.value = albumPreviewMode(album);
    select.onchange = () => updateAlbumPreview(album.id, select.value).catch(logBackgroundError('updateAlbumPreview'));
    return select;
}

// Gueltigkeit fuer eine Person (0 = wie das Album); sofort neue Buendel an diese Person.
async function updateViewerKeyTiming(albumId, viewerId, minutes) {
    const album = state.albums[albumId];
    if (!album || album.ownerId !== state.myProfile.id || !album.acl.includes(viewerId) || !ALBUM_KEY_EPOCH_OPTIONS.includes(minutes)) return;
    const overrides = { ...(album.viewerKeyEpochs || {}) };
    if (minutes > 0) overrides[viewerId] = minutes;
    else delete overrides[viewerId];
    album.viewerKeyEpochs = overrides;
    await saveAlbum(album);
    await pushAlbumKeys(viewerId, album, true).catch(logBackgroundError('updateViewerKeyTiming'));
    await pushAllAlbumKeys().catch(logBackgroundError('updateViewerKeyTiming'));
}

function createViewerKeyTimingSelect(album, viewerId) {
    const select = document.createElement('select');
    select.className = 'bg-slate-900 border border-slate-700 rounded-full px-1.5 py-0 text-[11px] text-slate-300';
    select.dataset.viewerKeyEpoch = viewerId;
    select.setAttribute('aria-label', t('albums.keyValidityForPerson', { name: getPeerPresentation(viewerId).name || HIDDEN_PEER_NAME }));
    ALBUM_KEY_EPOCH_OPTIONS.forEach(minutes => {
        const option = document.createElement('option');
        option.value = String(minutes);
        option.textContent = minutes ? albumEpochLabel(minutes) : t('albums.likeAlbum');
        select.appendChild(option);
    });
    const override = album.viewerKeyEpochs?.[viewerId];
    select.value = String(ALBUM_KEY_EPOCH_OPTIONS.includes(override) ? override : 0);
    select.onchange = () => updateViewerKeyTiming(album.id, viewerId, Number(select.value)).catch(logBackgroundError('updateViewerKeyTiming'));
    return select;
}

function createAlbumKeyTimingControls(album) {
    const select = (options, value, label, onChange) => {
        const element = document.createElement('select');
        element.setAttribute('aria-label', label);
        options.forEach(option => {
            const entry = document.createElement('option');
            entry.value = String(option.value);
            entry.textContent = option.text;
            element.appendChild(entry);
        });
        element.value = String(value);
        element.onchange = () => onChange(Number(element.value));
        return element;
    };
    return [
        albumSettingRow(t('albums.keyValidFor'), select(ALBUM_KEY_EPOCH_OPTIONS.map(minutes => ({ value: minutes, text: albumEpochLabel(minutes) })),
            ALBUM_KEY_EPOCH_OPTIONS.includes(album.keyEpochMinutes) ? album.keyEpochMinutes : 0, t('albums.keyValidity'),
            value => updateAlbumKeyTiming(album.id, 'keyEpochMinutes', value))),
        albumSettingRow(t('albums.epochsDeliveredInAdvance'), select(ALBUM_KEY_AHEAD_OPTIONS.map(count => ({ value: count, text: t(['albums.1Epoch', 'albums.2Epochs', 'albums.3Epochs'][count - 1]) })),
            albumEpochsAhead(album), t('albums.epochsDeliveredInAdvance'),
            value => updateAlbumKeyTiming(album.id, 'keyEpochsAhead', value)))
    ];
}

function isValidKeyBundle(bundle) {
    return bundle && typeof bundle.albumId === 'string' && bundle.albumId.length <= 200
        && Number.isInteger(bundle.keyVersion) && Number.isInteger(bundle.epoch) && Number.isFinite(bundle.epochEndsAt)
        && typeof bundle.rollingKey === 'string' && typeof bundle.iv === 'string'
        && typeof bundle.wrapped === 'string' && bundle.wrapped.length <= 200000;
}

// Betrachter: Buendel speichern (verpackt), abgelaufene entfernen. Aus applyChatOperation.
// Zugangsticket (R4): vom Besitzer signiert, gilt fuer genau einen Betrachter bis zum Ende der letzten
// gelieferten Epoche. Weitergebende Betrachter (Schwarm) bedienen nur Peers mit gueltigem Ticket.
const ALBUM_TICKET_PREFIX = 'album-ticket:';

async function signAlbumTicket(album, viewerId, expiresAt) {
    if (!state.myKeys?.ecdsaKeyPair?.privateKey) return null;
    return signEnvelope(
        { albumId: album.id, ownerId: state.myProfile.id, viewerId, keyVersion: album.keyVersion || 1, expiresAt },
        state.myKeys.ecdsaKeyPair.privateKey,
        state.myKeys.jwkEcdsaPublic
    );
}

// Prueft ein Ticket: Signatur des Besitzers (gepinnt), Album, Betrachter und Ablauf.
async function verifyAlbumTicket(ticket, { ownerId, albumId, viewerId, now }) {
    const payload = ticket?.payload;
    if (!payload || payload.ownerId !== ownerId || payload.albumId !== albumId || payload.viewerId !== viewerId) return false;
    if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= now) return false;
    const identity = await getPeerIdentity(ownerId);
    return verifyEnvelope(ticket, identity?.profileSigningKey);
}

async function loadAlbumTicket(albumId) {
    return databaseRequest('keys', 'readonly', store => store.get(`${ALBUM_TICKET_PREFIX}${albumId}`))
        .then(record => record?.ticket || null)
        .catch(() => null);
}

async function handleAlbumKeysOperation(ownerId, operation) {
    const bundles = Array.isArray(operation.bundles) ? operation.bundles.slice(0, MAX_ALBUM_KEY_BUNDLES) : [];
    const valid = bundles.filter(isValidKeyBundle);
    const ticketAlbumId = operation.ticket?.payload?.albumId;
    if (typeof ticketAlbumId === 'string' && await verifyAlbumTicket(operation.ticket, {
        ownerId, albumId: ticketAlbumId, viewerId: state.myProfile.id, now: (await fetchServerTime().catch(() => ({ now: Date.now() }))).now
    })) {
        await putDatabaseRecord('keys', { id: `${ALBUM_TICKET_PREFIX}${ticketAlbumId}`, ownerId, ticket: operation.ticket });
    }
    for (const bundle of valid) {
        // Ansichts-Buendel nur, solange das Album offen ist (kommt es nach dem Schliessen an, waere es
        // eine Ansicht gratis).
        if (bundle.session === true && state.albumViewer?.albumId !== bundle.albumId) continue;
        if (Number.isFinite(bundle.limitedUntil)) await rememberAlbumSelfDestruct(ownerId, bundle.albumId, bundle.limitedUntil);
        await putDatabaseRecord('keys', {
            id: `${ALBUM_KEY_BUNDLE_PREFIX}${bundle.albumId}:${bundle.keyVersion}:${bundle.epoch}`,
            ownerId,
            ...bundle
        });
    }
    await pruneAlbumKeyBundles();
    const openAlbum = state.albumViewer && state.albums[state.albumViewer.albumId];
    if (openAlbum && valid.some(bundle => bundle.albumId === openAlbum.id) && !state.albumKeys[openAlbum.id]) {
        if (await loadAlbumKeys(openAlbum.id)) await renderAlbumViewer(openAlbum);
    }
    return valid.length > 0;
}

async function pruneAlbumKeyBundles() {
    const now = (await fetchServerTime().catch(() => ({ now: Date.now() }))).now;
    const records = await getAllDatabaseRecords('keys').catch(() => []);
    await Promise.all(records
        .filter(record => typeof record.id === 'string' && record.id.startsWith(ALBUM_KEY_BUNDLE_PREFIX) && record.epochEndsAt <= now)
        .map(record => deleteDatabaseRecord('keys', record.id)));
}

// Das Buendel, dessen Zeitfenster jetzt laeuft. Die Epochenlaenge legt der Besitzer pro Album fest
// und steht im Buendel (aeltere Buendel ohne `epochMs` nutzen den Server-Wert).
async function findCurrentAlbumKeyBundle(albumId, keyVersion, time) {
    const prefix = `${ALBUM_KEY_BUNDLE_PREFIX}${albumId}:${keyVersion}:`;
    const records = await getAllDatabaseRecords('keys').catch(() => []);
    return records.find(record => typeof record.id === 'string' && record.id.startsWith(prefix)
        && record.epochEndsAt > time.now
        && (Number.isFinite(record.epochStartsAt) ? record.epochStartsAt
            : record.epochEndsAt - (Number.isFinite(record.epochMs) && record.epochMs > 0 ? record.epochMs : time.epochMs)) <= time.now) || null;
}

// Entpackt das Buendel der laufenden Epoche in nicht exportierbare Schluessel (nur im RAM).
async function loadAlbumKeys(albumId) {
    const album = state.albums[albumId];
    if (!album || album.ownerId === state.myProfile.id) return false;
    const time = await fetchServerTime();
    const keyVersion = album.keyVersion || 1;
    const record = await findCurrentAlbumKeyBundle(albumId, keyVersion, time);
    if (!record || record.ownerId !== album.ownerId) return false;
    let keyMap;
    try {
        const kek = await deriveAlbumKek(album.ownerId, record.rollingKey, albumId, record.epoch, keyVersion);
        const plaintext = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(record.iv) }, kek, base64ToBytes(record.wrapped));
        keyMap = JSON.parse(new TextDecoder().decode(plaintext));
    } catch (error) {
        logDebug(`Album key bundle could not be opened: ${error.message}`);
        return false;
    }
    const keys = new Map();
    for (const [imageId, raw] of Object.entries(keyMap).slice(0, 500)) {
        if (typeof raw !== 'string') continue;
        // Auch 'encrypt': Betrachter geben Bilder fuer andere Betrachter neu verschluesselt weiter.
        keys.set(imageId, await window.crypto.subtle.importKey('raw', base64ToBytes(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
    }
    expireAlbumKeys(albumId, false);
    state.albumKeys[albumId] = {
        ownerId: album.ownerId,
        keyVersion,
        epoch: record.epoch,
        // Begrenzte Ansicht: nach Ablauf nicht automatisch nachfragen (das wuerde eine Ansicht zaehlen).
        session: record.session === true,
        keys,
        timer: setTimeout(() => expireAlbumKeys(albumId, true), Math.min(Math.max(0, record.epochEndsAt - time.now), 2147483647))
    };
    return true;
}

// Erst das gespeicherte Buendel, sonst den Besitzer direkt fragen (er pusht dann neu).
async function requestAlbumKeys(ownerId, albumId) {
    if (await loadAlbumKeys(albumId).catch(() => false)) {
        const album = state.albums[albumId];
        if (album && state.albumViewer?.albumId === albumId) await renderAlbumViewer(album);
        return;
    }
    await sendSecurePayload(ownerId, { type: 'ALBUM_KEY_REQUEST', albumId });
}

// Betrachter: Album mit begrenzten Ansichten geschlossen -> Schluessel und gespeicherte Ansichts-Buendel
// sofort weg und dem Besitzer melden (er beendet die Ansicht und entzieht, wenn alle verbraucht sind).
async function endLimitedAlbumView(albumId) {
    const entry = state.albumKeys[albumId];
    const records = await getAllDatabaseRecords('keys').catch(() => []);
    const sessionBundles = records.filter(record => typeof record.id === 'string'
        && record.id.startsWith(`${ALBUM_KEY_BUNDLE_PREFIX}${albumId}:`) && record.session === true);
    if (!entry?.session && !sessionBundles.length) return;
    const ownerId = entry?.ownerId || sessionBundles[0]?.ownerId;
    if (entry?.session) expireAlbumKeys(albumId, false);
    await Promise.all(sessionBundles.map(record => deleteDatabaseRecord('keys', record.id)));
    // Auch die verschluesselten Bilder: nach der Ansicht bleibt nichts liegen (naechste Ansicht laedt neu).
    await deleteReceivedAlbumImages(albumId);
    if (ownerId) await sendSecurePayload(ownerId, { type: 'ALBUM_VIEW_CLOSED', albumId });
}

async function deleteReceivedAlbumImages(albumId) {
    const album = state.albums[albumId];
    if (!album || album.ownerId === state.myProfile.id) return;
    await Promise.all(album.items.map(item => deleteDatabaseRecord('media', item.id)));
}

// Betrachter: zeitlich begrenztes Album zur Frist selbst vergessen (Album, Bilder, Schluessel, Ticket).
const ALBUM_SELF_DESTRUCT_PREFIX = 'album-expires:';

async function rememberAlbumSelfDestruct(ownerId, albumId, until) {
    const id = `${ALBUM_SELF_DESTRUCT_PREFIX}${albumId}`;
    const existing = await databaseRequest('keys', 'readonly', store => store.get(id)).catch(() => null);
    if (existing && existing.ownerId === ownerId && existing.until <= until) return;
    await putDatabaseRecord('keys', { id, ownerId, albumId, until });
    scheduleAlbumSelfDestruct();
}

async function runAlbumSelfDestruct() {
    const now = (await fetchServerTime().catch(() => ({ now: Date.now() }))).now;
    const records = await getAllDatabaseRecords('keys').catch(() => []);
    for (const record of records.filter(entry => typeof entry.id === 'string' && entry.id.startsWith(ALBUM_SELF_DESTRUCT_PREFIX))) {
        if (record.until > now) continue;
        await forgetReceivedAlbum(record.ownerId, record.albumId);
        await deleteDatabaseRecord('keys', record.id);
    }
    scheduleAlbumSelfDestruct(records, now);
}

function scheduleAlbumSelfDestruct(records = null, now = Date.now()) {
    clearTimeout(state.albumSelfDestructTimer);
    const run = list => {
        const next = list.filter(entry => typeof entry.id === 'string' && entry.id.startsWith(ALBUM_SELF_DESTRUCT_PREFIX) && entry.until > now)
            .map(entry => entry.until).sort((left, right) => left - right)[0];
        if (!next) return;
        state.albumSelfDestructTimer = setTimeout(() => runAlbumSelfDestruct().catch(logBackgroundError('runAlbumSelfDestruct')),
            Math.min(Math.max(0, next - now) + 500, 2147483647));
    };
    if (records) run(records);
    else getAllDatabaseRecords('keys').then(run).catch(() => {});
}

// Besitzer: Ansicht vorzeitig beendet.
async function handleAlbumViewClosed(peerId, payload) {
    const album = state.albums[payload.albumId];
    const limit = albumLimitFor(album, peerId);
    if (!album || album.ownerId !== state.myProfile.id || limit?.kind !== 'views') return;
    const now = (await fetchServerTime().catch(() => ({ now: Date.now() }))).now;
    if ((limit.sessionEndsAt || 0) <= now) return;
    album.limits = { ...album.limits, [peerId]: { ...limit, sessionEndsAt: now } };
    await saveAlbum(album);
    await enforceAlbumLimits(now);
}

async function handleAlbumKeyRequest(peerId, payload) {
    const album = state.albums[payload.albumId];
    if (!album || album.ownerId !== state.myProfile.id || !album.acl.includes(peerId)) {
        await sendSecurePayload(peerId, { type: 'ALBUM_DENIED', albumId: payload.albumId });
        return;
    }
    const limit = albumLimitFor(album, peerId);
    if (limit?.kind === 'views') {
        const now = (await fetchServerTime().catch(() => ({ now: Date.now() }))).now;
        // Laufende Ansicht: dieselbe Frist erneut schicken, ohne zu zaehlen.
        if ((limit.sessionEndsAt || 0) > now) {
            await pushAlbumKeys(peerId, album, true, { sessionUntil: limit.sessionEndsAt });
            return;
        }
        if ((limit.used || 0) >= limit.views) {
            await sendSecurePayload(peerId, { type: 'ALBUM_DENIED', albumId: album.id });
            await enforceAlbumLimits(now);
            return;
        }
        album.limits = { ...album.limits, [peerId]: { ...limit, used: (limit.used || 0) + 1, sessionEndsAt: now + ALBUM_VIEW_SESSION_MS } };
        await saveAlbum(album);
        scheduleAlbumLimitCheck(now);
        await pushAlbumKeys(peerId, album, true, { sessionUntil: now + ALBUM_VIEW_SESSION_MS });
        return;
    }
    await pushAlbumKeys(peerId, album, true);
}

// Laeuft die Epoche ab, werden die Schluessel verworfen. Ist das Album offen, wird sofort nachgefragt.
function expireAlbumKeys(albumId, renew) {
    const entry = state.albumKeys[albumId];
    if (!entry) return;
    clearTimeout(entry.timer);
    delete state.albumKeys[albumId];
    const album = state.albums[albumId];
    if (entry.session && album && state.albumViewer?.albumId === albumId) renderAlbumViewer(album).catch(logBackgroundError('expireAlbumKeys'));
    if (!renew || entry.session || !album || state.albumViewer?.albumId !== albumId) return;
    renderAlbumViewer(album).catch(logBackgroundError('expireAlbumKeys'));
    requestAlbumKeys(album.ownerId, albumId).catch(logBackgroundError('expireAlbumKeys'));
}

async function decryptAlbumImage(albumId, imageId, encrypted) {
    const entry = state.albumKeys[albumId];
    const album = state.albums[albumId];
    const key = entry?.keyVersion === album?.keyVersion ? entry.keys.get(imageId) : null;
    if (!key) return null;
    try {
        const plaintext = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: base64ToBytes(encrypted.iv) },
            key,
            base64ToBytes(encrypted.ciphertext)
        );
        const dataUrl = new TextDecoder().decode(plaintext);
        return isSafeInlineImage(dataUrl) ? dataUrl : null;
    } catch {
        return null;
    }
}
