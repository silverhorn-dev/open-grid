// ================= ALBEN & MEDIEN =================
// Eigene Alben liegen im Store `albums` (ownerId = eigene ID) mit Zugriffsliste `acl`.
// Bilder liegen verschluesselt im Store `media`. Andere Peers erhalten Album und
// Bilder nur per P2P und nur, solange sie in der `acl` stehen.
const ALBUM_IMAGE_MAX_EDGE = 1080;
const ALBUM_IMAGE_QUALITY = 0.7;
const ALBUM_COVER_EDGE = 240;

async function loadAlbums() {
    const records = await getAllDatabaseRecords('albums').catch(() => []);
    state.albums = Object.fromEntries(records.map(album => [album.id, album]));
    // Alben aus der Zeit vor den rotierenden Schluesseln bekommen nachtraeglich ein Geheimnis.
    for (const album of getOwnAlbums().filter(album => !album.secret)) {
        album.secret = createAlbumSecret();
        album.keyVersion = 1;
        await putDatabaseRecord('albums', album);
    }
    renderAlbumManager();
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
    await putDatabaseRecord('albums', album);
    renderAlbumManager();
}

async function createAlbum() {
    const input = document.getElementById('new-album-name');
    const name = input?.value.trim();
    if (!name) {
        showToast('Bitte einen Albumnamen eingeben.', 'warning');
        return;
    }
    await saveAlbum({
        id: `alb_${window.crypto.randomUUID()}`,
        ownerId: state.myProfile.id,
        name: name.substring(0, 80),
        items: [],
        acl: [],
        secret: createAlbumSecret(),
        keyVersion: 1
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
            showToast('Ein Bild konnte nicht hinzugefuegt werden.', 'error');
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
    if (!album || !window.confirm(`Album "${album.name}" wirklich loeschen?`)) return;
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
    // Neue Schluesselversion: auch ein zurueckbehaltener Schluessel passt nicht mehr zu neuen Uebertragungen.
    album.keyVersion = (album.keyVersion || 1) + 1;
    await saveAlbum(album);
    notifyAlbumRevoked(peerId, albumId);
    // Verbleibende Betrachter bekommen Buendel fuer die neue Schluesselversion.
    for (const viewerId of album.acl) pushAlbumKeys(viewerId, album, true).catch(() => {});
}

function notifyAlbumRevoked(peerId, albumId) {
    sendSecurePayload(peerId, { type: 'ALBUM_REVOKED', albumId }).catch(() => {});
}

// Kleines Deckfoto, das direkt in der Chat-Nachricht mitgeht.
async function createAlbumCover(album) {
    const first = album.items[0] ? await loadMedia(album.items[0].id) : null;
    if (!first?.data) return undefined;
    const image = new Image();
    image.src = first.data;
    await image.decode();
    const scale = Math.min(1, ALBUM_COVER_EDGE / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const cover = canvas.toDataURL('image/jpeg', 0.6);
    return cover.length <= ALBUM_COVER_MAX_LENGTH ? cover : undefined;
}

async function shareAlbumInChat(albumId) {
    const peerId = state.activeChatPeerId;
    const album = state.albums[albumId];
    if (!peerId || !album || isPeerBlocked(peerId)) return;
    if (!album.items.length) {
        showToast('Das Album ist leer.', 'warning');
        return;
    }
    if (!album.acl.includes(peerId)) {
        album.acl.push(peerId);
        await saveAlbum(album);
    }
    pushAlbumKeys(peerId, album, true).catch(error => logDebug(`Album key push failed: ${error.message}`));
    closeMediaModal();
    await sendChatMessage(null, '', {
        albumId: album.id,
        ownerId: state.myProfile.id,
        name: album.name,
        cover: await createAlbumCover(album).catch(() => undefined),
        count: album.items.length
    });
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
    await sendSecurePayload(peerId, {
        type: 'ALBUM_RESPONSE',
        album: {
            id: album.id,
            name: album.name,
            keyVersion: album.keyVersion || 1,
            items: album.items.map(({ id, version }) => ({ id, version }))
        }
    });
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
        receivedAt: Date.now()
    };
    state.albums[album.id] = album;
    await putDatabaseRecord('albums', album);
    // Buendel koennen vor den Album-Metadaten angekommen sein.
    if (!state.albumKeys[album.id]) await loadAlbumKeys(album.id).catch(() => false);
    if (state.albumViewer?.albumId === album.id) await renderAlbumViewer(album);
}

async function forgetReceivedAlbum(peerId, albumId) {
    const album = state.albums[albumId];
    if (!album || album.ownerId !== peerId) return;
    await Promise.all(album.items.map(item => deleteDatabaseRecord('media', item.id)));
    await deleteDatabaseRecord('albums', albumId);
    delete state.albums[albumId];
    expireAlbumKeys(albumId, false);
    if (state.albumViewer?.albumId === albumId) {
        renderMediaModalMessage('Du hast keinen Zugriff mehr auf dieses Album.');
    }
}

async function handleAlbumDenied(peerId, albumId) {
    delete state.pendingAlbumRequests[`${peerId}:${albumId}`];
    await forgetReceivedAlbum(peerId, albumId);
    if (state.albumViewer?.albumId === albumId) renderMediaModalMessage('Du hast keinen Zugriff (mehr) auf dieses Album.');
}

// ----- Medien-Modal (Album, Medienuebersicht, Albumauswahl) -----
function openMediaModal(title) {
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

function hideMediaModal() {
    state.albumViewer = null;
    document.getElementById('media-modal').classList.add('hidden');
    document.getElementById('media-modal-content').innerHTML = '';
}

function renderMediaModalMessage(text) {
    const content = document.getElementById('media-modal-content');
    content.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'text-center text-sm text-slate-400 py-10';
    note.textContent = text;
    content.appendChild(note);
}

// Alle bereits geladenen Bilder des offenen Medien-Modals, in Anzeigereihenfolge.
function openViewerFromTiles(dataUrl) {
    const images = [...document.querySelectorAll('#media-modal-content [data-viewer-image] img')].map(image => image.src);
    openImageViewer(images, Math.max(0, images.indexOf(dataUrl)));
}

function createThumbnail(dataUrl, onClick) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'aspect-square rounded-xl overflow-hidden border border-slate-800 bg-slate-800 hover:border-brand-500 transition';
    if (dataUrl && isSafeInlineImage(dataUrl)) {
        tile.dataset.viewerImage = 'true';
        const image = document.createElement('img');
        image.src = dataUrl;
        image.alt = '';
        image.className = 'w-full h-full object-cover';
        tile.appendChild(image);
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
    openMediaModal(album?.name || reference?.name || 'Album');
    state.albumViewer = { albumId, ownerId };
    if (album) await renderAlbumViewer(album);
    if (ownerId && ownerId !== state.myProfile.id) {
        if (!album) renderMediaModalMessage('Album wird geladen... Der Besitzer muss online sein.');
        state.pendingAlbumRequests[`${ownerId}:${albumId}`] = true;
        await sendSecurePayload(ownerId, { type: 'ALBUM_REQUEST', albumId });
        await requestAlbumKeys(ownerId, albumId);
    }
}

async function renderAlbumViewer(album) {
    if (state.albumViewer?.albumId !== album.id) return;
    document.getElementById('media-modal-title').textContent = album.name;
    const content = document.getElementById('media-modal-content');
    content.innerHTML = '';
    if (!album.items.length) {
        renderMediaModalMessage('Dieses Album ist leer.');
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
        remove.setAttribute('aria-label', 'Bild entfernen');
        remove.onclick = () => removeAlbumImage(album.id, item.id);
        wrapper.append(tile, remove);
        grid.appendChild(wrapper);
    }
}

// Empfangene Albumbilder liegen nur als Ciphertext vor und brauchen den Schluessel der aktuellen Epoche.
async function renderReceivedAlbumTile(album, item) {
    const stored = await loadMedia(item.id);
    const isCurrent = stored?.encrypted && stored.version === item.version && stored.keyVersion === album.keyVersion;
    if (!isCurrent) {
        state.pendingImageRequests[`${album.ownerId}:${item.id}`] = item.version;
        sendSecurePayload(album.ownerId, { type: 'IMAGE_REQUEST', imageId: item.id, version: item.version }).catch(() => {});
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
    tile.innerHTML = '<i class="fa-solid fa-lock text-lg"></i><span>Schluessel abgelaufen</span>';
    return tile;
}

// Medienuebersicht des aktiven Chats: alle Snaps und geteilten Alben.
const MEDIA_FILTERS = [
    { id: 'all', label: 'Beide' },
    { id: 'mine', label: 'Eigene' },
    { id: 'theirs', label: 'Andere' }
];

function openChatMediaOverview(filter = state.mediaOverviewFilter || 'all') {
    const peerId = state.activeChatPeerId;
    if (!peerId) return;
    state.mediaOverviewFilter = filter;
    const content = openMediaModal('Medien im Chat');
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
        const note = document.createElement('div');
        note.className = 'text-center text-sm text-slate-400 py-10';
        note.textContent = filter === 'all' ? 'In diesem Chat wurden noch keine Bilder geteilt.' : 'Keine Bilder in dieser Auswahl.';
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
    const content = openMediaModal('Album teilen');
    const albums = getOwnAlbums().filter(album => album.items.length);
    if (!albums.length) {
        renderMediaModalMessage('Du hast noch kein Album mit Bildern. Lege eins im Profil an.');
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
        meta.textContent = `${album.items.length} Bilder${album.acl.includes(state.activeChatPeerId) ? ' · bereits geteilt' : ''}`;
        button.append(name, meta);
        button.onclick = () => shareAlbumInChat(album.id);
        content.appendChild(button);
    });
}

// Album-Karte in einer Chat-Nachricht.
function renderAlbumMessage(bubble, album) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'block w-48 sm:w-56 text-left';
    if (album.cover && isSafeInlineImage(album.cover)) {
        const image = document.createElement('img');
        image.src = album.cover;
        image.alt = '';
        image.className = 'w-full aspect-square object-cover rounded-xl mb-1.5 border border-slate-900/50';
        card.appendChild(image);
    }
    const title = document.createElement('div');
    title.className = 'font-semibold';
    title.innerHTML = '<i class="fa-solid fa-images mr-1"></i>';
    title.appendChild(document.createTextNode(album.name));
    const meta = document.createElement('div');
    meta.className = 'opacity-75 text-[11px]';
    meta.textContent = Number.isInteger(album.count) ? `${album.count} Bilder · Antippen zum Oeffnen` : 'Antippen zum Oeffnen';
    card.append(title, meta);
    card.onclick = event => {
        event.stopPropagation();
        openAlbumViewer(album.albumId, album);
    };
    bubble.appendChild(card);
}

// ----- Verwaltung im Profil -----
function renderAlbumManager() {
    const container = document.getElementById('album-manager-list');
    if (!container) return;
    container.innerHTML = '';
    const albums = getOwnAlbums();
    if (!albums.length) {
        container.innerHTML = '<div class="text-xs text-slate-500">Noch keine Alben.</div>';
        return;
    }
    albums.forEach(album => {
        const card = document.createElement('div');
        card.className = 'border border-slate-800 rounded-xl p-3 space-y-2 bg-slate-950/40';
        const header = document.createElement('div');
        header.className = 'flex items-center justify-between gap-2';
        const title = document.createElement('button');
        title.type = 'button';
        title.className = 'text-sm font-semibold text-slate-200 truncate hover:text-brand-400 text-left';
        title.textContent = `${album.name} (${album.items.length})`;
        title.onclick = () => openAlbumViewer(album.id);
        const actions = document.createElement('div');
        actions.className = 'flex items-center gap-2 shrink-0';
        const add = document.createElement('label');
        add.className = 'text-xs px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-slate-200 cursor-pointer hover:bg-slate-700';
        add.innerHTML = '<i class="fa-solid fa-plus"></i> Bilder';
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.multiple = true;
        fileInput.className = 'hidden';
        fileInput.onchange = () => addAlbumImages(album.id, fileInput);
        add.appendChild(fileInput);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'text-xs px-2.5 py-1.5 rounded-lg border border-red-900 text-red-300 hover:bg-red-950';
        remove.textContent = 'Loeschen';
        remove.onclick = () => deleteAlbum(album.id);
        actions.append(add, remove);
        header.append(title, actions);
        card.appendChild(header);

        const access = document.createElement('div');
        access.className = 'flex flex-wrap gap-1.5 text-xs';
        if (!album.acl.length) {
            access.innerHTML = '<span class="text-slate-500">Mit niemandem geteilt</span>';
        } else {
            album.acl.forEach(peerId => {
                const chip = document.createElement('span');
                chip.className = 'flex items-center gap-1 bg-slate-800 border border-slate-700 rounded-full pl-2.5 pr-1 py-0.5 text-slate-300';
                chip.appendChild(document.createTextNode(getPeerPresentation(peerId).name || 'Peer'));
                const revoke = document.createElement('button');
                revoke.type = 'button';
                revoke.className = 'w-5 h-5 rounded-full hover:bg-red-900 text-red-300';
                revoke.title = 'Zugriff entziehen';
                revoke.setAttribute('aria-label', 'Zugriff entziehen');
                revoke.innerHTML = '<i class="fa-solid fa-xmark"></i>';
                revoke.onclick = () => revokeAlbumAccess(album.id, peerId);
                chip.appendChild(revoke);
                access.appendChild(chip);
            });
        }
        card.appendChild(access);
        container.appendChild(card);
    });
}

// ----- Rotierende Album-Schluessel -----
// Pro Betrachter und Bild: Schluessel = HKDF(Albumgeheimnis des Besitzers, Album + Version, Bild + Betrachter).
// Der Betrachter bekommt die Bilder nur als Ciphertext und die Schluessel nur fuer die laufende
// Epoche (Serverzeit). Sie liegen ausschliesslich im Arbeitsspeicher und verfallen mit der Epoche.
function findOwnAlbumForImage(imageId) {
    return getOwnAlbums().find(album => album.items.some(item => item.id === imageId)) || null;
}

async function deriveAlbumImageKey(album, imageId, viewerId) {
    const secret = await window.crypto.subtle.importKey('raw', base64ToBytes(album.secret), 'HKDF', false, ['deriveKey']);
    return window.crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new TextEncoder().encode(`${album.id}:${album.keyVersion || 1}`),
            info: new TextEncoder().encode(`${imageId}:${viewerId}`)
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
    const marked = typeof embedWatermark === 'function' ? await embedWatermark(media.data, peerId) : media.data;
    const key = await deriveAlbumImageKey(album, imageId, peerId);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(marked));
    await sendSecurePayload(peerId, {
        type: 'IMAGE_RESPONSE',
        imageId,
        version: item.version,
        keyVersion: album.keyVersion || 1,
        encrypted: { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) }
    });
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
    const encrypted = { iv: payload.encrypted.iv, ciphertext: payload.encrypted.ciphertext };
    await cacheMediaPayload(payload.imageId, { encrypted, version: payload.version, keyVersion: payload.keyVersion });
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
const ALBUM_KEY_EPOCHS_AHEAD = 1;

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

// Besitzer: zufaelliger rollender Key pro Album und Epoche; aeltere Epochen werden verworfen.
function getRollingKey(album, epoch, currentEpoch) {
    album.rollingKeys = Object.fromEntries(Object.entries(album.rollingKeys || {})
        .filter(([storedEpoch]) => Number(storedEpoch) >= currentEpoch));
    if (!album.rollingKeys[epoch]) album.rollingKeys[epoch] = bytesToBase64(window.crypto.getRandomValues(new Uint8Array(32)));
    return album.rollingKeys[epoch];
}

async function buildAlbumKeyBundle(album, viewerId, time, epoch) {
    const keyVersion = album.keyVersion || 1;
    const keys = {};
    for (const item of album.items) {
        const key = await deriveAlbumImageKey(album, item.id, viewerId);
        keys[item.id] = bytesToBase64(new Uint8Array(await window.crypto.subtle.exportKey('raw', key)));
    }
    const rollingKey = getRollingKey(album, epoch, time.epoch);
    const kek = await deriveAlbumKek(viewerId, rollingKey, album.id, epoch, keyVersion);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, new TextEncoder().encode(JSON.stringify(keys)));
    return {
        albumId: album.id,
        keyVersion,
        epoch,
        epochEndsAt: (epoch + 1) * time.epochMs,
        rollingKey,
        iv: bytesToBase64(iv),
        wrapped: bytesToBase64(new Uint8Array(wrapped))
    };
}

// Schickt einem Betrachter die Buendel fuer jetzt und die naechste Epoche (einmal pro Epoche und Version).
async function pushAlbumKeys(viewerId, album, force = false) {
    if (!album || album.ownerId !== state.myProfile.id || !album.acl.includes(viewerId) || !album.items.length) return;
    const time = await fetchServerTime();
    const marker = `${album.keyVersion || 1}:${time.epoch}`;
    const pushed = state.albumKeyPushes[viewerId] || (state.albumKeyPushes[viewerId] = {});
    if (!force && pushed[album.id] === marker) return;
    const bundles = [];
    for (let offset = 0; offset <= ALBUM_KEY_EPOCHS_AHEAD; offset++) {
        bundles.push(await buildAlbumKeyBundle(album, viewerId, time, time.epoch + offset));
    }
    await putDatabaseRecord('albums', album);
    pushed[album.id] = marker;
    const operation = {
        operationId: `albumkeys:${album.id}:${marker}:${window.crypto.randomUUID()}`,
        type: 'ALBUM_KEYS',
        actorId: state.myProfile.id,
        createdAt: Date.now(),
        bundles
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
    if (time) state.albumKeyPushTimer = setTimeout(() => pushAllAlbumKeys().catch(() => {}), Math.min(time.epochEndsAt - time.now + 1000, 2147483647));
}

function isValidKeyBundle(bundle) {
    return bundle && typeof bundle.albumId === 'string' && bundle.albumId.length <= 200
        && Number.isInteger(bundle.keyVersion) && Number.isInteger(bundle.epoch) && Number.isFinite(bundle.epochEndsAt)
        && typeof bundle.rollingKey === 'string' && typeof bundle.iv === 'string'
        && typeof bundle.wrapped === 'string' && bundle.wrapped.length <= 200000;
}

// Betrachter: Buendel speichern (verpackt), abgelaufene entfernen. Aus applyChatOperation.
async function handleAlbumKeysOperation(ownerId, operation) {
    const bundles = Array.isArray(operation.bundles) ? operation.bundles.slice(0, ALBUM_KEY_EPOCHS_AHEAD + 1) : [];
    const valid = bundles.filter(isValidKeyBundle);
    for (const bundle of valid) {
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

// Entpackt das Buendel der laufenden Epoche in nicht exportierbare Schluessel (nur im RAM).
async function loadAlbumKeys(albumId) {
    const album = state.albums[albumId];
    if (!album || album.ownerId === state.myProfile.id) return false;
    const time = await fetchServerTime();
    const keyVersion = album.keyVersion || 1;
    const record = await databaseRequest('keys', 'readonly', store => store.get(`${ALBUM_KEY_BUNDLE_PREFIX}${albumId}:${keyVersion}:${time.epoch}`)).catch(() => null);
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
        keys.set(imageId, await window.crypto.subtle.importKey('raw', base64ToBytes(raw), { name: 'AES-GCM' }, false, ['decrypt']));
    }
    expireAlbumKeys(albumId, false);
    state.albumKeys[albumId] = {
        ownerId: album.ownerId,
        keyVersion,
        epoch: record.epoch,
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

async function handleAlbumKeyRequest(peerId, payload) {
    const album = state.albums[payload.albumId];
    if (!album || album.ownerId !== state.myProfile.id || !album.acl.includes(peerId)) {
        await sendSecurePayload(peerId, { type: 'ALBUM_DENIED', albumId: payload.albumId });
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
    if (!renew || !album || state.albumViewer?.albumId !== albumId) return;
    renderAlbumViewer(album).catch(() => {});
    requestAlbumKeys(album.ownerId, albumId).catch(() => {});
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
