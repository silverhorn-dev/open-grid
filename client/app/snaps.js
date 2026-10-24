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
    title.textContent = 'Snap';
    const meta = document.createElement('div');
    meta.className = 'opacity-75 text-[11px]';
    if (isMine) meta.textContent = available ? 'Gesendet · Tippen zum Ansehen' : 'Angesehen';
    else if (!available) meta.textContent = 'Abgelaufen';
    else meta.textContent = views === 0 ? 'Tippen zum Ansehen' : 'Tippen zum Wiederholen (1x)';
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
    openSecureSnapViewer('');
    state.secureSnapViewing = { mode: 'replay', peerId, messageId, isMine };
    const image = document.getElementById('secure-snap-image');
    drawSecureImage(image, message.snapData).catch(logBackgroundError('openReplaySnap'));
    image.classList.remove('hidden');
    // Auch der Sender kann seinen eigenen Snap behalten.
    const save = document.getElementById('secure-snap-save');
    save.classList.remove('hidden');
    save.disabled = false;
    save.textContent = 'Speichern';
}

async function saveReplaySnap() {
    const viewing = state.secureSnapViewing;
    if (viewing?.mode !== 'replay') return;
    const message = state.chats[viewing.peerId]?.find(item => item.id === viewing.messageId);
    if (!message) return;
    message.snapSaved = true;
    viewing.saved = true;
    await persistChatMessage(viewing.peerId, message);
    const save = document.getElementById('secure-snap-save');
    save.disabled = true;
    save.textContent = 'Gespeichert';
    renderChatHistory();
}

// Wird beim Schliessen des Viewers aufgerufen: zaehlt die Ansicht, nach der Wiederholung ist der Snap weg.
async function finishReplaySnapView(viewing) {
    if (viewing.isMine || viewing.saved) return;
    const message = state.chats[viewing.peerId]?.find(item => item.id === viewing.messageId);
    if (!message || message.snapSaved) return;
    message.snapViews = (message.snapViews || 0) + 1;
    const consumed = message.snapViews >= REPLAY_SNAP_MAX_VIEWS;
    if (consumed) {
        message.snapData = undefined;
        await removeSnapFromOperation(message.id);
    }
    await persistChatMessage(viewing.peerId, message);
    if (state.activeChatPeerId === viewing.peerId) renderChatHistory();
    // Dem Sender mitteilen, dass der Snap verbraucht ist: er loescht dann seine Kopie.
    if (consumed) await sendSnapConsumed(viewing.peerId, message.id);
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
        showToast('Bitte waehle zuerst einen aktiven Chat aus.', 'warning');
        return;
    }
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
        showSnapCameraProblem('Keine Kamera verfuegbar. Du kannst ein Bild auswaehlen.');
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
    } catch (error) {
        logDebug(`Camera error: ${error.name}: ${error.message}`);
        showSnapCameraProblem(error.name === 'NotAllowedError'
            ? 'Kamera-Zugriff verweigert. Du kannst ein Bild auswaehlen.'
            : 'Kamera nicht verfuegbar. Du kannst ein Bild auswaehlen.');
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
}

function resetSnapPreview() {
    state.snapDraft = null;
    document.getElementById('snap-live-controls')?.classList.remove('hidden');
    document.getElementById('snap-review-controls')?.classList.add('hidden');
    const preview = document.getElementById('snap-review-image');
    if (preview) {
        preview.src = '';
        preview.classList.add('hidden');
    }
    const caption = document.getElementById('snap-caption-input');
    if (caption) caption.value = '';
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

function showSnapReview(dataUrl) {
    stopSnapCamera();
    renderSnapSettings();
    state.snapDraft = dataUrl;
    const preview = document.getElementById('snap-review-image');
    preview.src = dataUrl;
    preview.classList.remove('hidden');
    document.getElementById('snap-live-controls').classList.add('hidden');
    document.getElementById('snap-review-controls').classList.remove('hidden');
}

async function captureSnap() {
    const video = document.getElementById('snap-video-preview');
    if (!video.videoWidth) return;
    const bits = isTraceWatermarkEnabled() ? await watermarkTag(state.activeChatPeerId) : null;
    const dataUrl = encodeSnap(video, video.videoWidth, video.videoHeight, state.snapFacingMode === 'user', bits);
    if (!dataUrl) {
        showToast('Snap konnte nicht erstellt werden.', 'error');
        return;
    }
    showSnapReview(dataUrl);
}

async function pickSnapImage(input) {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
        const bitmap = await createImageBitmap(file);
        const bits = isTraceWatermarkEnabled() ? await watermarkTag(state.activeChatPeerId) : null;
        const dataUrl = encodeSnap(bitmap, bitmap.width, bitmap.height, false, bits);
        bitmap.close?.();
        if (!dataUrl) throw new Error('Image too large');
        showSnapReview(dataUrl);
    } catch (error) {
        logDebug(`Snap image failed: ${error.message}`);
        showToast('Bild konnte nicht geladen werden.', 'error');
    }
}

async function retakeSnap() {
    resetSnapPreview();
    await startSnapCamera();
}

async function sendSnapDraft() {
    const snapData = state.snapDraft;
    const peerId = state.activeChatPeerId;
    if (!snapData || !peerId) return;
    const caption = document.getElementById('snap-caption-input').value;
    const secure = state.snapSettings.secureSnaps;
    const views = Number(document.getElementById('snap-review-views')?.value) || state.snapSettings.views;
    const seconds = Number(document.getElementById('snap-review-seconds')?.value ?? state.snapSettings.seconds);
    closeSnapModal();
    if (!secure) {
        await sendChatMessage(snapData, caption);
        return;
    }
    const secureSnap = await createSecureSnap(snapData, peerId, views, Number.isFinite(seconds) ? seconds : 10);
    await sendChatMessage(null, caption, null, secureSnap);
}
