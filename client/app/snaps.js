// Snaps: Einmal-Snaps mit Wiederholung und die Snap-Kamera. Ausgelagert aus chat.js.
// ================= SNAPS =================
// Ein Snap erscheint dauerhaft im Chat (und in Medienuebersicht/Viewer), wenn er gespeichert wurde
// oder aus der Zeit vor den Einmal-Snaps stammt.
function isInlineSnap(message) {
    return isSafeInlineImage(message.snapData) && (message.snapMode !== 'replay' || message.snapSaved);
}

const REPLAY_SNAP_MAX_VIEWS = 2;

function renderReplaySnapMessage(bubble, message, isMine) {
    const views = message.snapViews || 0;
    const available = isSafeInlineImage(message.snapData) && (isMine || views < REPLAY_SNAP_MAX_VIEWS);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'flex items-center gap-3 text-left w-56';
    const icon = document.createElement('span');
    icon.className = `w-10 h-10 shrink-0 rounded-xl flex items-center justify-center text-lg ${available ? 'bg-brand-500/20 text-brand-300' : 'bg-slate-700 text-slate-400'}`;
    icon.innerHTML = '<i class="fa-solid fa-bolt"></i>';
    const details = document.createElement('div');
    details.className = 'min-w-0';
    const title = document.createElement('div');
    title.className = 'font-semibold';
    title.textContent = t('common.snap');
    const meta = document.createElement('div');
    meta.className = 'opacity-75 text-[11px]';
    if (isMine) {
        meta.textContent = available ? t('snaps.sentTapToView') : t('snaps.viewed');
        if (available && message.snapConsumed && !message.snapSaved && message.ownKeepUntil) {
            meta.textContent = `${t('snaps.viewed')} · ${t('snaps.keptUntil', { time: formatClockTime(message.ownKeepUntil) })}`;
        }
        if (message.savedByPeer) meta.textContent += t('snaps.savedByRecipient');
    }
    else if (!available) meta.textContent = t('snaps.expired');
    else meta.textContent = views === 0 ? t('snaps.tapToView') : t('snaps.tapToReplay1x');
    details.append(title, meta);
    card.append(icon, details);
    if (available) {
        card.onclick = event => {
            event.stopPropagation();
            openReplaySnap(message.id);
        };
    } else {
        card.disabled = true;
    }
    bubble.appendChild(card);
    if (message.text) {
        const caption = document.createElement('div');
        caption.className = 'opacity-90 mt-1';
        caption.textContent = message.text;
        bubble.appendChild(caption);
    }
}

function openReplaySnap(messageId) {
    const peerId = state.activeChatPeerId;
    const message = state.chats[peerId]?.find(item => item.id === messageId);
    if (!message || !isSafeInlineImage(message.snapData)) return;
    const isMine = message.senderId === state.myProfile.id;
    // Die Ansicht zaehlt schon beim Oeffnen: Neu laden oder Schliessen der App waehrend des Ansehens
    // gibt keine zusaetzliche Ansicht.
    if (!isMine && !message.snapSaved) {
        message.snapViews = (message.snapViews || 0) + 1;
        // Ab der ersten Ansicht laeuft die Frist des Absenders (ohne Anzeige beim Empfaenger).
        if (!message.firstViewedAt) message.firstViewedAt = Date.now();
        persistChatMessage(peerId, message).catch(logBackgroundError('openReplaySnap'));
        scheduleReplaySnapExpiry(peerId);
    }
    openSecureSnapViewer('');
    state.secureSnapViewing = { mode: 'replay', peerId, messageId, isMine };
    const image = document.getElementById('secure-snap-image');
    // Eigene Snaps nie durch den Nacktbild-Filter (der Viewer wird fuer beide genutzt).
    if (isMine) image.dataset.ownImage = 'true';
    else delete image.dataset.ownImage;
    if (!isMine && message.nudityScan && typeof markForcedNudityScan === 'function') markForcedNudityScan(message.snapData);
    drawSecureImage(image, message.snapData).catch(logBackgroundError('openReplaySnap'));
    image.classList.remove('hidden');
    renderReplayQueueLabel();
    // Auch der Sender kann seinen eigenen Snap behalten; der Empfaenger nur, wenn der Absender es erlaubt.
    const save = document.getElementById('secure-snap-save');
    save.classList.toggle('hidden', !isMine && message.downloadable === 'none');
    save.disabled = false;
    save.textContent = t('common.save');
}

async function saveReplaySnap() {
    const viewing = state.secureSnapViewing;
    // Eigener Secure Snap (Frist nach dem Ansehen): als Datei speichern.
    if (viewing?.mode === 'own') {
        downloadCanvasImage(document.getElementById('secure-snap-image'), `opengrid-snap-${Date.now()}.jpg`);
        return;
    }
    if (viewing?.mode !== 'replay') return;
    const message = state.chats[viewing.peerId]?.find(item => item.id === viewing.messageId);
    if (!message) return;
    if (!viewing.isMine && message.downloadable === 'none') return;
    message.snapSaved = true;
    viewing.saved = true;
    await persistChatMessage(viewing.peerId, message);
    const save = document.getElementById('secure-snap-save');
    save.disabled = true;
    save.textContent = t('snaps.saved');
    renderChatHistory();
    // Der Absender erfaehrt, dass sein Snap gespeichert wurde (wie bei Snapchat).
    if (message.senderId === viewing.peerId) await sendSnapSaved(viewing.peerId, message.id);
}

async function sendSnapSaved(peerId, messageId) {
    const operation = {
        operationId: `saved:${messageId}`,
        peerId,
        type: 'SNAP_SAVED',
        messageId,
        actorId: state.myProfile.id,
        createdAt: Date.now()
    };
    await persistChatOperation(operation);
    const { peerId: _localPeerId, ...sharedOperation } = operation;
    await sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation: sharedOperation }, () => {});
}

// Wird beim Schliessen des Viewers aufgerufen: zaehlt die Ansicht, nach der Wiederholung ist der Snap weg.
// Ungesehene Einmal-Snaps des Chat-Partners, aelteste zuerst (fuer "weiter zum naechsten").
function unseenReplaySnaps(peerId) {
    return (state.chats[peerId] || [])
        .filter(message => message.snapMode === 'replay' && message.senderId === peerId && !message.snapSaved
            && !message.deleted && isSafeInlineImage(message.snapData) && !(message.snapViews > 0))
        .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
}

function renderReplayQueueLabel() {
    const label = document.getElementById('secure-snap-queue');
    const viewing = state.secureSnapViewing;
    if (!label) return;
    const remaining = viewing?.mode === 'replay' && !viewing.isMine ? unseenReplaySnaps(viewing.peerId).length : 0;
    const hint = { doubletap: t('snaps.doubleTap'), swipe: t('snaps.swipeSideways'), swipeup: t('snaps.swipeUp') }[state.snapSettings.nextGesture] || t('snaps.doubleTap');
    label.textContent = !remaining ? ''
        : remaining > 1 ? t('snaps.moreSnapsNext', { count: remaining, hint }) : t('snaps.1MoreSnapNext', { hint });
    label.classList.toggle('hidden', !remaining);
}

// Naechster ungesehener Snap im selben Viewer; ohne weitere schliesst der Viewer.
async function advanceReplaySnap() {
    const viewing = state.secureSnapViewing;
    if (viewing?.mode !== 'replay') return;
    // Zeitlich der naechste nach dem aktuellen, sonst der aelteste noch ungesehene.
    const current = (state.chats[viewing.peerId] || []).find(message => message.id === viewing.messageId);
    const others = unseenReplaySnaps(viewing.peerId).filter(message => message.id !== viewing.messageId);
    const next = others.find(message => (message.createdAt || 0) >= (current?.createdAt || 0)) || others[0];
    if (!next) {
        closeSecureSnapViewer();
        return;
    }
    hapticTick();
    await finishReplaySnapView(viewing);
    openReplaySnap(next.id);
}

async function finishReplaySnapView(viewing) {
    if (viewing.isMine || viewing.saved) return;
    const message = state.chats[viewing.peerId]?.find(item => item.id === viewing.messageId);
    if (!message || message.snapSaved) return;
    if (isReplaySnapUsedUp(message)) await consumeReplaySnap(viewing.peerId, message);
    else if (state.activeChatPeerId === viewing.peerId) renderChatHistory();
}

// Letzte Ansicht vorbei: Bild loeschen und dem Sender melden (er loescht dann seine Kopie).
async function consumeReplaySnap(peerId, message) {
    message.snapData = undefined;
    await removeSnapFromOperation(message.id);
    await persistChatMessage(peerId, message);
    if (state.activeChatPeerId === peerId) renderChatHistory();
    await sendSnapConsumed(peerId, message.id);
}

// Frist nach der ersten Ansicht (Enum vom Absender); aeltere Snaps ohne Angabe: Standard 30 min.
function replaySnapExpiresAt(message) {
    if (!message.firstViewedAt) return null;
    const duration = SNAP_EXPIRY_OPTIONS[message.snapExpiry ?? '30m'];
    return duration ? message.firstViewedAt + duration : null;
}

function isReplaySnapUsedUp(message, now = Date.now()) {
    if ((message.snapViews || 0) >= REPLAY_SNAP_MAX_VIEWS) return true;
    const expiresAt = replaySnapExpiresAt(message);
    return expiresAt !== null && now >= expiresAt;
}

// Verbrauchte oder abgelaufene Snaps aufraeumen (auch nach Neu laden oder Schliessen der App waehrend
// des Ansehens). Ein gerade offener Snap wird erst beim Schliessen geloescht.
async function expireUsedReplaySnaps(peerId) {
    const viewing = state.secureSnapViewing;
    const used = (state.chats[peerId] || []).filter(message => message.snapMode === 'replay' && message.senderId === peerId
        && !message.snapSaved && message.snapData && isReplaySnapUsedUp(message)
        && !(viewing?.mode === 'replay' && viewing.messageId === message.id));
    for (const message of used) await consumeReplaySnap(peerId, message);
    await expireOwnKeptSnaps(peerId);
    scheduleReplaySnapExpiry(peerId);
}

// Eigene Snaps nach der eigenen Frist (ownKeepUntil, gesetzt wenn der Empfaenger alles gesehen hat)
// loeschen: Einmal-Snaps das Bild, Secure Snaps Schluessel und Ciphertext.
async function expireOwnKeptSnaps(peerId, now = Date.now()) {
    for (const message of state.chats[peerId] || []) {
        if (message.senderId !== state.myProfile.id) continue;
        if (message.snapMode === 'replay' && message.snapData && !message.snapSaved && message.ownKeepUntil && message.ownKeepUntil <= now) {
            message.snapData = undefined;
            await removeSnapFromOperation(message.id);
            await persistChatMessage(peerId, message);
        } else if (message.secureSnap?.ownKeepUntil && message.secureSnap.ownKeepUntil <= now && message.secureSnap.encrypted) {
            await deleteDatabaseRecord('media', `ssnap_${message.secureSnap.snapId}`);
            message.secureSnap = { ...message.secureSnap, encrypted: undefined };
            await persistChatMessage(peerId, message);
        } else {
            continue;
        }
        if (state.activeChatPeerId === peerId) renderChatHistory();
    }
}

// Timer bis zum naechsten Ablauf im offenen Chat (die Liste prueft sonst beim Oeffnen).
function scheduleReplaySnapExpiry(peerId) {
    clearTimeout(state.snapExpiryTimer);
    if (state.activeChatPeerId !== peerId) return;
    const messages = state.chats[peerId] || [];
    const next = messages
        .filter(message => message.snapMode === 'replay' && message.senderId === peerId && !message.snapSaved && message.snapData)
        .map(replaySnapExpiresAt)
        .concat(messages.filter(message => message.senderId === state.myProfile.id)
            .map(message => (message.snapData && !message.snapSaved ? message.ownKeepUntil : message.secureSnap?.encrypted && message.secureSnap.ownKeepUntil) || null))
        .filter(at => at !== null && at !== undefined)
        .sort((left, right) => left - right)[0];
    if (!next) return;
    state.snapExpiryTimer = setTimeout(() => expireUsedReplaySnaps(peerId).catch(logBackgroundError('scheduleReplaySnapExpiry')),
        Math.min(Math.max(0, next - Date.now()) + 50, 2147483647));
}

async function sendSnapConsumed(peerId, messageId) {
    const operation = {
        operationId: `consumed:${messageId}`,
        peerId,
        type: 'SNAP_CONSUMED',
        messageId,
        actorId: state.myProfile.id,
        createdAt: Date.now()
    };
    await persistChatOperation(operation);
    const { peerId: _localPeerId, ...sharedOperation } = operation;
    await sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation: sharedOperation });
}
// Snaps muessen auch ueber Pfad C passen (Queue-Limit 100 KB Ciphertext), daher max. ca. 70 KB als Data-URL.
const SNAP_MAX_EDGE = 1080;
const SNAP_MAX_DATA_URL_LENGTH = 70000;

async function openSnapUploadModal() {
    if (!state.activeChatPeerId || isPeerBlocked(state.activeChatPeerId)) {
        showToast(t('snaps.pleaseChooseActiveChatFirst'), 'warning');
        return;
    }
    await openSnapCamera('chat');
}

// Ziel: 'chat' (Snap an den aktiven Chat) oder 'status' (Foto-Status fuer Freunde, status.js).
async function openSnapCamera(target) {
    state.snapTarget = target;
    // Nacktbild-Warnung vor dem Senden: Modell schon jetzt im Hintergrund laden (nudity-model.js).
    if (typeof warmUpNudityModel === 'function') warmUpNudityModel();
    setSnapSendMode('snap');
    state.snapFacingMode = state.snapFacingMode || 'user';
    resetSnapPreview();
    document.getElementById('snap-capture-modal').classList.remove('hidden');
    pushModalEntry('snap', hideSnapModal);
    await startSnapCamera();
}

function stopSnapCamera() {
    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(track => track.stop());
        state.mediaStream = null;
    }
    const video = document.getElementById('snap-video-preview');
    if (video) video.srcObject = null;
}

async function startSnapCamera() {
    stopSnapCamera();
    const video = document.getElementById('snap-video-preview');
    const status = document.getElementById('snap-camera-status');
    status.classList.add('hidden');
    if (!navigator.mediaDevices?.getUserMedia) {
        showSnapCameraProblem(t('snaps.noCameraAvailableYouCan'));
        return;
    }
    try {
        try {
            state.mediaStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: state.snapFacingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio: false
            });
        } catch (error) {
            // Manche Geraete kennen facingMode oder die Aufloesung nicht.
            if (error.name === 'NotAllowedError') throw error;
            state.mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        // Das Modal kann waehrend der Kamera-Anfrage geschlossen worden sein.
        if (document.getElementById('snap-capture-modal').classList.contains('hidden')) {
            stopSnapCamera();
            return;
        }
        video.srcObject = state.mediaStream;
        video.classList.toggle('snap-mirrored', state.snapFacingMode === 'user');
        await video.play().catch(logBackgroundError('startSnapCamera'));
        updateSnapCameraCapabilities();
    } catch (error) {
        logDebug(`Camera error: ${error.name}: ${error.message}`);
        showSnapCameraProblem(error.name === 'NotAllowedError'
            ? t('snaps.cameraAccessDeniedYouCan')
            : t('snaps.cameraNotAvailableYouCan'));
    }
}

function showSnapCameraProblem(text) {
    const status = document.getElementById('snap-camera-status');
    status.textContent = text;
    status.classList.remove('hidden');
}

async function switchSnapCamera() {
    state.snapFacingMode = state.snapFacingMode === 'user' ? 'environment' : 'user';
    await startSnapCamera();
}

function closeSnapModal() {
    dismissModalEntry('snap', hideSnapModal);
}

function hideSnapModal() {
    stopSnapCamera();
    resetSnapPreview();
    document.getElementById('snap-capture-modal').classList.add('hidden');
    finishPickedEdit();
}

function resetSnapPreview() {
    closeSnapEditor();
    if (document.getElementById('snap-mode-pill')) setSnapSendMode(state.snapSendMode);
    document.getElementById('snap-live-controls')?.classList.remove('hidden');
    document.getElementById('snap-gesture-hint')?.classList.remove('hidden');
    document.getElementById('snap-camera-stage')?.classList.remove('hidden');
    document.getElementById('snap-review-controls')?.classList.add('hidden');
    const caption = document.getElementById('snap-caption-input');
    if (caption) caption.value = '';
    const original = document.getElementById('snap-original-toggle');
    if (original) original.checked = false;
}

// Verkleinert und komprimiert, bis der Snap unter das Pfad-C-Limit passt.
// Mit watermarkBits wird die Empfaenger-ID unsichtbar eingebettet (vor jeder Kompression neu).
function encodeSnap(source, width, height, mirror = false, watermarkBits = null) {
    const canvas = document.getElementById('snap-canvas-capture');
    let scale = Math.min(1, SNAP_MAX_EDGE / Math.max(width, height));
    let quality = 0.8;
    for (let attempt = 0; attempt < 12; attempt++) {
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const context = canvas.getContext('2d');
        context.save();
        if (mirror) {
            context.translate(canvas.width, 0);
            context.scale(-1, 1);
        }
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
        context.restore();
        if (watermarkBits) embedWatermarkInCanvas(canvas, watermarkBits);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        if (dataUrl.length <= SNAP_MAX_DATA_URL_LENGTH) return dataUrl;
        if (quality > 0.45) quality -= 0.1;
        else scale *= 0.8;
    }
    return null;
}

// Nach der Aufnahme: Editor mit dem Rohbild (ohne Wasserzeichen) oeffnen.
// Darf der Empfaenger dieses Bild/diesen Snap speichern? Je Aufnahme, Standard vom Router
// (CLIENT_DEFAULTS.snapSaveable, ohne Angabe: ja). Aus = Nachricht traegt downloadable: 'none'.
function resetSnapSaveable() {
    state.snapSaveable = clientDefault('snapSaveable', true) !== false;
    renderSnapSaveable();
}

function toggleSnapSaveable() {
    state.snapSaveable = !state.snapSaveable;
    hapticTick();
    renderSnapSaveable();
}

function renderSnapSaveable() {
    const button = document.getElementById('snap-saveable-btn');
    if (button) button.setAttribute('aria-pressed', String(state.snapSaveable));
    document.getElementById('snap-saveable-note')?.classList.toggle('hidden', state.snapSaveable);
}

function snapSaveOptions() {
    return state.snapSaveable ? {} : { downloadable: 'none' };
}

function showSnapReview(base) {
    stopSnapCamera();
    resetSnapSaveable();
    renderSnapSettings();
    document.getElementById('snap-camera-stage').classList.add('hidden');
    document.getElementById('snap-live-controls').classList.add('hidden');
    document.getElementById('snap-gesture-hint').classList.add('hidden');
    document.getElementById('snap-review-controls').classList.remove('hidden');
    openSnapEditor(base);
    setSnapSendMode(state.snapSendMode);
}

// Foto-Status und "Bild" haben keine Secure-Snap-Optionen; der Senden-Knopf sagt, was passiert.
function updateSnapReviewOptions() {
    const forStatus = state.snapTarget === 'status';
    const asImage = !forStatus && state.snapSendMode === 'image';
    document.getElementById('snap-original-option')?.classList.toggle('hidden', !asImage);
    const secureOptions = document.getElementById('snap-review-secure-options');
    if (forStatus || asImage) secureOptions?.classList.add('hidden');
    else secureOptions?.classList.toggle('hidden', !state.snapSettings.secureSnaps);
    // Secure Snaps und Status lassen sich ohnehin nie speichern.
    const saveableRelevant = !forStatus && (asImage || !state.snapSettings.secureSnaps);
    document.getElementById('snap-saveable-btn')?.classList.toggle('hidden', !saveableRelevant);
    if (!saveableRelevant) document.getElementById('snap-saveable-note')?.classList.add('hidden');
    else renderSnapSaveable();
    const send = document.getElementById('snap-send-btn');
    if (send) {
        send.innerHTML = forStatus
            ? 'Als Status teilen <i class="fa-solid fa-circle-plus"></i>'
            : asImage ? 'Bild senden <i class="fa-solid fa-paper-plane"></i>' : 'Senden <i class="fa-solid fa-paper-plane"></i>';
    }
}

function captureSnap() {
    const video = document.getElementById('snap-video-preview');
    if (!video.videoWidth) return;
    showSnapReview(captureSnapBase(video, video.videoWidth, video.videoHeight, state.snapFacingMode === 'user'));
}

// Bearbeitetes Bild flachen, Wasserzeichen des Empfaengers einbetten und unter das Pfad-C-Limit kodieren.
async function encodeSnapDraft(peerId) {
    const flat = flattenSnapDraft();
    if (!flat) return null;
    // Ohne Empfaenger (Status) kein Wasserzeichen hier; das setzt status.js pro Freund.
    const bits = peerId && isTraceWatermarkEnabled() ? await watermarkTag(peerId) : null;
    return encodeSnap(flat, flat.width, flat.height, false, bits);
}

async function pickSnapImage(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length > 1) {
        await sendPickedImages(files);
        return;
    }
    const file = files[0];
    if (!file) return;
    try {
        const bitmap = await createImageBitmap(file);
        const base = captureSnapBase(bitmap, bitmap.width, bitmap.height, false);
        bitmap.close?.();
        showSnapReview(base);
    } catch (error) {
        logDebug(`Snap image failed: ${error.message}`);
        showToast(t('snaps.imageCouldNotBeLoaded'), 'error');
    }
}

// Mehrfachauswahl aus der Galerie: erst durchsehen, dann senden. Jedes Bild wird ein eigener Snap (bzw.
// Bild oder Foto-Status). In der Ansicht: grosses Bild, seitlich wischen oder Pfeile, Leiste mit allen,
// einzelne entfernen, Art pro Bild (Snap/Bild/Secure, vorbelegt wie im Snap-Menue), einzelnes Bild im
// Snap-Editor bearbeiten (zurueck mit "Uebernehmen" oder Schliessen), "Alle senden".
const MAX_PICKED_IMAGES = 20;
const PICKED_MODES = ['snap', 'image', 'secure'];
const pickedReview = { items: [], index: 0, context: null, editIndex: null };

async function sendPickedImages(files) {
    const context = {
        target: state.snapTarget,
        peerId: state.activeChatPeerId,
        asImage: state.snapSendMode === 'image',
        secure: state.snapSettings.secureSnaps && state.snapSendMode !== 'image',
        skipped: Math.max(0, files.length - MAX_PICKED_IMAGES)
    };
    closeSnapModal();
    const items = [];
    for (const file of files.slice(0, MAX_PICKED_IMAGES)) {
        try {
            const bitmap = await createImageBitmap(file);
            const base = captureSnapBase(bitmap, bitmap.width, bitmap.height, false);
            bitmap.close?.();
            items.push({ id: window.crypto.randomUUID(), base, mode: context.asImage ? 'image' : context.secure ? 'secure' : 'snap' });
        } catch (error) {
            logDebug(`Picked image failed: ${error.message}`);
        }
    }
    if (!items.length) {
        showToast(t('snaps.imageCouldNotBeLoaded'), 'error');
        return;
    }
    pickedReview.items = items;
    pickedReview.index = 0;
    pickedReview.context = context;
    renderPickedReview();
}

function pickedReviewTitle() {
    const count = pickedReview.items.length;
    if (pickedReview.context.target === 'status') return t('snaps.reviewStatuses', { count });
    const modes = new Set(pickedReview.items.map(item => item.mode));
    if (modes.size > 1) return t('snaps.reviewMixed', { count });
    if (modes.has('image')) return t('snaps.reviewImages', { count });
    return modes.has('secure') ? t('snaps.reviewSecureSnaps', { count }) : t('snaps.reviewSnaps', { count });
}

// Verkleinerte Kopie fuer Vorschau/Leiste (das Original bleibt fuers Senden).
function pickedPreviewCanvas(base, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(base.width, base.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(base.width * scale));
    canvas.height = Math.max(1, Math.round(base.height * scale));
    canvas.getContext('2d').drawImage(base, 0, 0, canvas.width, canvas.height);
    return canvas;
}

function renderPickedReview() {
    const { items } = pickedReview;
    if (!items.length) {
        closeMediaModal();
        return;
    }
    pickedReview.index = Math.min(Math.max(0, pickedReview.index), items.length - 1);
    // Neu zeichnen (blaettern, entfernen) ist kein Schliessen: alte Aufraeum-Funktion nicht ausfuehren.
    if (document.getElementById('media-modal')?.classList.contains('hidden') === false) state.mediaModalCleanup = null;
    const content = openMediaModal(pickedReviewTitle());
    state.mediaModalCleanup = () => {
        pickedReview.items = [];
        pickedReview.context = null;
    };
    const wrap = document.createElement('div');
    wrap.className = 'picked-review';

    const stage = document.createElement('div');
    stage.className = 'picked-review-stage';
    stage.setAttribute('data-no-sheet-swipe', '');
    const preview = pickedPreviewCanvas(items[pickedReview.index].base, 1080);
    preview.className = 'picked-review-image';
    stage.appendChild(preview);
    const arrow = (direction, icon, label) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `picked-review-arrow ${direction < 0 ? 'is-prev' : 'is-next'}`;
        button.setAttribute('aria-label', label);
        button.innerHTML = `<i class="fa-solid ${icon}"></i>`;
        button.disabled = direction < 0 ? pickedReview.index === 0 : pickedReview.index === items.length - 1;
        button.onclick = () => stepPickedReview(direction);
        return button;
    };
    if (items.length > 1) stage.append(arrow(-1, 'fa-chevron-left', t('snaps.previousImage')), arrow(1, 'fa-chevron-right', t('snaps.nextImage')));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'picked-review-remove';
    remove.setAttribute('aria-label', t('common.remove'));
    remove.title = t('common.remove');
    remove.innerHTML = '<i class="fa-solid fa-trash"></i>';
    remove.onclick = removePickedImage;
    stage.appendChild(remove);
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'picked-review-edit';
    editButton.setAttribute('aria-label', t('snaps.editImage'));
    editButton.title = t('snaps.editImage');
    editButton.innerHTML = '<i class="fa-solid fa-pen"></i>';
    editButton.onclick = () => editPickedImage(pickedReview.index);
    stage.appendChild(editButton);
    const counter = document.createElement('span');
    counter.className = 'picked-review-counter';
    counter.textContent = `${pickedReview.index + 1} / ${items.length}`;
    stage.appendChild(counter);
    attachPickedReviewSwipe(stage);

    const strip = document.createElement('div');
    strip.className = 'picked-review-strip';
    strip.setAttribute('data-no-tab-swipe', '');
    strip.setAttribute('data-no-sheet-swipe', '');
    items.forEach((item, index) => {
        const thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.className = `picked-review-thumb${index === pickedReview.index ? ' is-active' : ''}`;
        thumb.setAttribute('aria-label', `${index + 1} / ${items.length}`);
        thumb.appendChild(pickedPreviewCanvas(item.base, 160));
        thumb.onclick = () => {
            pickedReview.index = index;
            renderPickedReview();
        };
        strip.appendChild(thumb);
    });

    const send = document.createElement('button');
    send.type = 'button';
    send.id = 'picked-review-send';
    send.className = 'compose-btn compose-btn-primary w-full';
    send.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
    send.append(` ${t('snaps.sendAll', { count: items.length })}`);
    send.onclick = sendPickedReview;

    const parts = [stage];
    // Art pro Bild (nicht beim Foto-Status).
    if (pickedReview.context.target !== 'status') {
        const modes = document.createElement('div');
        modes.className = 'picked-review-modes';
        modes.setAttribute('role', 'radiogroup');
        const current = items[pickedReview.index];
        const labels = { snap: t('common.snap'), image: t('common.image'), secure: t('common.secureSnap') };
        PICKED_MODES.forEach(mode => {
            const option = document.createElement('button');
            option.type = 'button';
            option.className = `picked-review-mode${current.mode === mode ? ' is-active' : ''}`;
            option.dataset.mode = mode;
            option.setAttribute('role', 'radio');
            option.setAttribute('aria-checked', String(current.mode === mode));
            option.textContent = labels[mode];
            option.onclick = () => {
                current.mode = mode;
                renderPickedReview();
            };
            modes.appendChild(option);
        });
        parts.push(modes);
    }
    wrap.append(...parts, strip, send);
    content.appendChild(wrap);
    strip.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
}

function stepPickedReview(direction) {
    const next = pickedReview.index + direction;
    if (next < 0 || next >= pickedReview.items.length) return;
    pickedReview.index = next;
    renderPickedReview();
}

function removePickedImage() {
    pickedReview.items.splice(pickedReview.index, 1);
    renderPickedReview();
}

// Seitlich wischen auf dem grossen Bild = vor/zurueck.
function attachPickedReviewSwipe(stage) {
    let start = null;
    stage.addEventListener('touchstart', event => {
        start = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    }, { passive: true });
    stage.addEventListener('touchend', event => {
        if (!start) return;
        const touch = event.changedTouches[0];
        const deltaX = touch.clientX - start.x;
        const deltaY = touch.clientY - start.y;
        start = null;
        if (Math.abs(deltaX) < 50 || Math.abs(deltaX) < Math.abs(deltaY) * 1.5) return;
        hapticTick();
        stepPickedReview(deltaX < 0 ? 1 : -1);
    }, { passive: true });
}

// Ein Bild im Snap-Editor bearbeiten (ohne Kamera); "Uebernehmen" bzw. Schliessen fuehrt zurueck.
function editPickedImage(index) {
    const item = pickedReview.items[index];
    if (!item) return;
    pickedReview.editIndex = index;
    // Die Durchsicht bleibt erhalten, nur das Fenster geht zu. Erst nach dessen Zurueck-Schritt den Editor
    // oeffnen (sonst schloesse das spaete "Zurueck" gleich den Editor).
    state.mediaModalCleanup = null;
    replaceModal(closeMediaModal, () => {
        state.snapTarget = pickedReview.context.target;
        document.getElementById('snap-capture-modal').classList.remove('hidden');
        pushModalEntry('snap', hideSnapModal);
        showSnapReview(item.base);
        const send = document.getElementById('snap-send-btn');
        if (send) {
            send.dataset.label = send.textContent;
            send.textContent = t('snaps.applyEdit');
        }
    });
}

// Aus hideSnapModal: Bearbeitung beenden und zur Durchsicht zurueck (uebernommen oder nicht).
function finishPickedEdit() {
    if (pickedReview.editIndex === null) return;
    pickedReview.editIndex = null;
    const send = document.getElementById('snap-send-btn');
    if (send?.dataset.label) {
        send.textContent = send.dataset.label;
        delete send.dataset.label;
    }
    setTimeout(renderPickedReview, 0);
}

async function sendPickedReview() {
    const { items, context } = pickedReview;
    if (!items.length || !context) return;
    const picked = items.map(item => ({ base: item.base, mode: item.mode }));
    // Nacktbild-Warnung (nudity.js): vor dem Schliessen, damit "Abbrechen" in der Durchsicht bleibt.
    if (!(await confirmNudeSend(picked.map(item => item.base)))) return;
    closeMediaModal();
    let sent = 0;
    for (const { base, mode } of picked) {
        try {
            if (context.target === 'status') {
                const image = encodeSnap(base, base.width, base.height, false, null);
                if (image) await postPhotoStatus(image, '');
            } else if (context.peerId) {
                const bits = isTraceWatermarkEnabled() ? await watermarkTag(context.peerId) : null;
                const data = encodeSnap(base, base.width, base.height, false, bits);
                if (!data) continue;
                if (mode === 'secure') {
                    await sendChatMessage(null, '', null, await createSecureSnap(data, context.peerId, state.snapSettings.views, state.snapSettings.seconds));
                } else {
                    // Ohne Editor gilt der Router-Standard fuer "speicherbar".
                    await sendChatMessage(data, '', null, null, { asImage: mode === 'image', ...(clientDefault('snapSaveable', true) !== false ? {} : { downloadable: 'none' }) });
                }
            }
            sent += 1;
        } catch (error) {
            logDebug(`Picked image failed: ${error.message}`);
        }
    }
    const message = context.target === 'status' ? t('snaps.statusesSent', { count: sent })
        : picked.every(item => item.mode === 'image') ? t('snaps.imagesSent', { count: sent }) : t('snaps.sent', { count: sent });
    const limit = context.skipped ? t('snaps.atMost', { max: MAX_PICKED_IMAGES }) : '';
    showToast(`${message}${limit}.`, sent ? 'success' : 'error');
}

async function retakeSnap() {
    resetSnapPreview();
    await startSnapCamera();
}

async function sendSnapDraft() {
    // Bild aus der Mehrfachauswahl bearbeitet: Ergebnis in die Durchsicht uebernehmen, nicht senden.
    if (pickedReview.editIndex !== null) {
        const flat = hasSnapDraft() ? flattenSnapDraft() : null;
        const item = pickedReview.items[pickedReview.editIndex];
        if (flat && item) item.base = flat;
        closeSnapModal();
        return;
    }
    if (state.snapTarget === 'status') {
        if (hasSnapDraft() && !(await confirmNudeSend([flattenSnapDraft()]))) return;
        const image = hasSnapDraft() ? await encodeSnapDraft(null) : null;
        const caption = document.getElementById('snap-caption-input').value;
        closeSnapModal();
        if (image) await postPhotoStatus(image, caption);
        else showToast(t('snaps.statusCouldNotBeCreated'), 'error');
        return;
    }
    const peerId = state.activeChatPeerId;
    if (!hasSnapDraft() || !peerId) return;
    // Nacktbild-Warnung (nudity.js); "Abbrechen" laesst den Entwurf offen.
    if (!(await confirmNudeSend([flattenSnapDraft()]))) return;
    const snapData = await encodeSnapDraft(peerId);
    if (!snapData) {
        showToast(t('snaps.couldNotBeCreated'), 'error');
        return;
    }
    const caption = document.getElementById('snap-caption-input').value;
    if (state.snapSendMode === 'image') {
        const wantsOriginal = document.getElementById('snap-original-toggle')?.checked;
        const original = wantsOriginal ? await createOriginalImage(flattenSnapDraft(), peerId) : null;
        if (wantsOriginal && !original) showToast(t('snaps.originalIsTooLargeOnly'), 'warning');
        closeSnapModal();
        await sendChatMessage(snapData, caption, null, null, { asImage: true, original, ...snapSaveOptions() });
        return;
    }
    const secure = state.snapSettings.secureSnaps;
    const views = Number(document.getElementById('snap-review-views')?.value) || state.snapSettings.views;
    const seconds = Number(document.getElementById('snap-review-seconds')?.value ?? state.snapSettings.seconds);
    closeSnapModal();
    if (!secure) {
        await sendChatMessage(snapData, caption, null, null, snapSaveOptions());
        return;
    }
    const secureSnap = await createSecureSnap(snapData, peerId, views, Number.isFinite(seconds) ? seconds : 10);
    await sendChatMessage(null, caption, null, secureSnap);
}
