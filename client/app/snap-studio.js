// ================= SNAP-SEITE (Social-Modus) =================
// Eigener Tab zwischen Chat und Profil (`/snap`): die Snap-Kamera als Seite, Navigation bleibt sichtbar,
// seitlich wischen wechselt den Tab. Das Ziel waehlt man erst nach der Aufnahme im Editor: ein Chat
// (als Snap, Secure Snap oder Bild), eines der eigenen Alben oder die Galerie des eigenen Profils.
// Abschaltbar in den Einstellungen (`keys`/`snap-page`, Router-Standard `CLIENT_DEFAULTS.snapPage`, sonst an).
const SNAP_STUDIO_GALLERY_EDGE = 800;
const SNAP_PAGE_RECORD_ID = 'snap-page';

function snapPageEnabled() {
    return typeof state.snapPageEnabled === 'boolean' ? state.snapPageEnabled : clientDefault('snapPage', true) !== false;
}

function snapPageAvailable() {
    return isSocialMode() && snapPageEnabled();
}

async function loadSnapPageSetting() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(SNAP_PAGE_RECORD_ID)).catch(() => null);
    if (typeof stored?.enabled === 'boolean') state.snapPageEnabled = stored.enabled;
    const toggle = document.getElementById('snap-page-toggle');
    if (toggle) toggle.checked = snapPageEnabled();
    applyAppModeUi();
}

async function updateSnapPageSetting(enabled) {
    state.snapPageEnabled = Boolean(enabled);
    await putDatabaseRecord('keys', { id: SNAP_PAGE_RECORD_ID, enabled: state.snapPageEnabled })
        .catch(error => logDebug(`Could not store snap page setting: ${error.message}`));
    applyAppModeUi();
}

// Tab geoeffnet: Kamera-Modal in die Seite holen (statt Vollbild) und die Kamera starten.
function enterSnapPage() {
    const modal = document.getElementById('snap-capture-modal');
    const host = document.getElementById('snap-page-host');
    if (!modal || !host || state.snapPage) return;
    state.snapPage = true;
    state.snapTarget = 'pick';
    if (typeof warmUpNudityModel === 'function') warmUpNudityModel();
    state.snapFacingMode = state.snapFacingMode || 'user';
    host.appendChild(modal);
    modal.classList.add('snap-in-page');
    modal.setAttribute('aria-modal', 'false');
    resetSnapPreview();
    setSnapSendMode(state.snapSendMode || 'snap');
    modal.classList.remove('hidden');
    startSnapCamera().catch(logBackgroundError('enterSnapPage'));
}

// Tab verlassen: Kamera aus, Entwurf verwerfen, Modal zurueck als Vollbild an das Ende von body.
function leaveSnapPage() {
    if (!state.snapPage) return;
    state.snapPage = false;
    const modal = document.getElementById('snap-capture-modal');
    hideSnapModal();
    if (!modal) return;
    modal.classList.remove('snap-in-page');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
}

// Entwurf festhalten (flaches Bild + Optionen aus dem Editor), dann den Editor schliessen und das Ziel waehlen.
async function chooseSnapStudioTarget() {
    if (!hasSnapDraft()) return;
    const flat = flattenSnapDraft();
    if (!flat) {
        showToast(t('snaps.couldNotBeCreated'), 'error');
        return;
    }
    // Nacktbild-Warnung (nudity.js); "Abbrechen" laesst den Entwurf offen.
    if (!(await confirmNudeSend([flat]))) return;
    const draft = {
        flat: copyCanvas(flat),
        caption: document.getElementById('snap-caption-input')?.value || '',
        mode: state.snapSendMode === 'image' ? 'image' : (state.snapSettings.secureSnaps ? 'secure' : 'snap'),
        wantsOriginal: document.getElementById('snap-original-toggle')?.checked === true,
        views: Number(document.getElementById('snap-review-views')?.value) || state.snapSettings.views,
        seconds: Number(document.getElementById('snap-review-seconds')?.value ?? state.snapSettings.seconds),
        saveOptions: snapSaveOptions()
    };
    // Seite: Kamera aus, solange die Auswahl offen ist; danach (Abbrechen, Album, Profil) wieder an.
    if (state.snapPage) {
        stopSnapCamera();
        resetSnapPreview();
        renderSnapStudioPicker(draft);
        state.mediaModalCleanup = () => {
            if (state.snapPage) startSnapCamera().catch(logBackgroundError('chooseSnapStudioTarget'));
        };
        return;
    }
    // Erst nach dem Schliessen der Kamera oeffnen, sonst blendet dessen popstate die Auswahl gleich wieder aus.
    replaceModal(closeSnapModal, () => renderSnapStudioPicker(draft));
}

function copyCanvas(source) {
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d').drawImage(source, 0, 0);
    return canvas;
}

function renderSnapStudioPicker(draft) {
    const content = openMediaModal(t('snapStudio.sendTo'));
    content.append(renderSnapStudioModes(draft));

    content.append(snapStudioHeading(t('common.chat'), 'fa-comments'));
    const peerIds = (state.chatPeerIds || []).filter(peerId => !isPeerBlocked(peerId));
    if (peerIds.length) {
        content.append(createChatPickerList(peerIds, peerId => replaceModal(closeMediaModal, () => sendSnapStudioToChat(peerId, draft))));
    } else {
        content.append(snapStudioNote(t('share.noChatsYet')));
    }

    content.append(snapStudioHeading(t('snapStudio.albums'), 'fa-images'));
    const albums = typeof getOwnAlbums === 'function' ? getOwnAlbums() : [];
    if (albums.length) {
        const list = document.createElement('div');
        list.className = 'space-y-1.5';
        albums.forEach(album => list.append(snapStudioOption(album.name || t('snapStudio.album'), 'fa-images',
            () => replaceModal(closeMediaModal, () => addSnapStudioToAlbum(album.id, draft)))));
        content.append(list);
    } else {
        content.append(snapStudioNote(t('snapStudio.noAlbums')));
    }

    content.append(snapStudioHeading(t('common.profile'), 'fa-user'));
    content.append(snapStudioOption(t('snapStudio.profileGallery'), 'fa-user-plus',
        () => replaceModal(closeMediaModal, () => addSnapStudioToProfile(draft))));
}

// Modus fuer Chats: Snap, Secure Snap oder Bild. Alben und Profil speichern immer ein Bild.
function renderSnapStudioModes(draft) {
    const row = document.createElement('div');
    row.className = 'flex gap-2 mb-1';
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', t('snapStudio.mode'));
    const modes = [['snap', t('common.snap')], ['secure', t('snapStudio.secure')], ['image', t('common.image')]];
    const render = () => row.querySelectorAll('button').forEach(button => {
        const active = button.dataset.mode === draft.mode;
        button.setAttribute('aria-checked', String(active));
        button.className = `flex-1 rounded-full px-3 py-1.5 text-xs font-semibold border ${active ? 'border-brand-500 bg-brand-500/20 text-white' : 'border-slate-700 text-slate-300'}`;
    });
    modes.forEach(([mode, label]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.mode = mode;
        button.setAttribute('role', 'radio');
        button.textContent = label;
        button.onclick = () => {
            draft.mode = mode;
            render();
        };
        row.append(button);
    });
    render();
    const wrapper = document.createElement('div');
    wrapper.append(row, snapStudioNote(t('snapStudio.modeHint')));
    return wrapper;
}

function snapStudioHeading(text, icon) {
    const heading = document.createElement('h4');
    heading.className = 'mt-4 mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-2';
    const symbol = document.createElement('i');
    symbol.className = `fa-solid ${icon}`;
    heading.append(symbol, document.createTextNode(text));
    return heading;
}

function snapStudioNote(text) {
    const note = document.createElement('p');
    note.className = 'text-xs text-slate-500';
    note.textContent = text;
    return note;
}

function snapStudioOption(text, icon, onPick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'w-full flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/40 hover:border-slate-700 p-3 text-left text-sm font-semibold text-slate-200';
    const symbol = document.createElement('i');
    symbol.className = `fa-solid ${icon} text-slate-400`;
    const label = document.createElement('span');
    label.className = 'truncate';
    label.textContent = text;
    button.append(symbol, label);
    button.onclick = onPick;
    return button;
}

function snapStudioJpeg(canvas, maxEdge, quality) {
    const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
    const target = document.createElement('canvas');
    target.width = Math.max(1, Math.round(canvas.width * scale));
    target.height = Math.max(1, Math.round(canvas.height * scale));
    target.getContext('2d').drawImage(canvas, 0, 0, target.width, target.height);
    return target.toDataURL('image/jpeg', quality);
}

async function sendSnapStudioToChat(peerId, draft) {
    switchTab('chat');
    await openChatWithPeer(peerId);
    replaceRoute(routeForTab('chat'));
    const bits = isTraceWatermarkEnabled() ? await watermarkTag(peerId) : null;
    const snapData = encodeSnap(draft.flat, draft.flat.width, draft.flat.height, false, bits);
    if (!snapData) {
        showToast(t('snaps.couldNotBeCreated'), 'error');
        return;
    }
    if (draft.mode === 'image') {
        const original = draft.wantsOriginal ? await createOriginalImage(draft.flat, peerId) : null;
        if (draft.wantsOriginal && !original) showToast(t('snaps.originalIsTooLargeOnly'), 'warning');
        await sendChatMessage(snapData, draft.caption, null, null, { asImage: true, original, ...draft.saveOptions });
        return;
    }
    if (draft.mode === 'snap') {
        await sendChatMessage(snapData, draft.caption, null, null, draft.saveOptions);
        return;
    }
    const seconds = Number.isFinite(draft.seconds) ? draft.seconds : 10;
    const secureSnap = await createSecureSnap(snapData, peerId, draft.views, seconds);
    await sendChatMessage(null, draft.caption, null, secureSnap);
}

async function addSnapStudioToAlbum(albumId, draft) {
    const album = state.albums[albumId];
    if (!album) return;
    try {
        const data = snapStudioJpeg(draft.flat, ALBUM_IMAGE_MAX_EDGE, ALBUM_IMAGE_QUALITY);
        const imageId = `albimg_${window.crypto.randomUUID()}`;
        await cacheMedia(imageId, data, 1);
        album.items.push({ id: imageId, version: 1 });
        await saveAlbum(album);
        showToast(t('snapStudio.addedToAlbum', { name: album.name || t('snapStudio.album') }), 'success');
    } catch (error) {
        logDebug(`Snap studio album image failed: ${error.message}`);
        showToast(t('albums.imageCouldNotBeAdded'), 'error');
    }
}

async function addSnapStudioToProfile(draft) {
    const part = editingProfilePart();
    if (!part.gallery) part.gallery = [];
    try {
        const data = snapStudioJpeg(draft.flat, SNAP_STUDIO_GALLERY_EDGE, 0.75);
        const imageId = `img_${window.crypto.randomUUID()}`;
        await cacheMedia(imageId, data, 1);
        part.gallery.push({ id: imageId, version: 1, sha256: await sha256Base64(data) });
        renderEditGallery();
        await saveUserProfile();
        showToast(t('profile.imageAddedToGallery'), 'success');
    } catch (error) {
        logDebug(`Snap studio gallery image failed: ${error.message}`);
        showToast(t('profile.uploadFailed'), 'error');
    }
}
