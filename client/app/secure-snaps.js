// ================= SECURE SNAPS =================
// Opt-in (Einstellungen). Der Snap geht verschluesselt raus (auch offline ueber Pfad C), der
// Schluessel bleibt beim Sender. Ansehen geht nur, solange der Sender online ist:
//   1. Empfaenger -> SNAP_VIEW_REQUEST (nur ueber eine stehende P2P-Verbindung, nie gequeued)
//   2. Sender zaehlt die Ansicht und versucht zuerst einen Live-Stream (Video-Track aus einem Canvas,
//      der Empfaenger bekommt keine Bilddaten). Kommt kein SNAP_STREAM_PLAYING, folgt SNAP_VIEW_GRANT
//      mit dem Schluessel; der Empfaenger entschluesselt nur im Arbeitsspeicher.
//   3. Nach Ablauf der Anzeigedauer wird alles verworfen; nach der letzten Ansicht loescht der
//      Empfaenger auch den Ciphertext. Bis dahin kann der Sender seinen eigenen Snap ansehen; nach der
//      letzten Ansicht loescht auch er Schluessel und Ciphertext.
const SECURE_SNAP_VIEW_OPTIONS = [1, 2, 3];
const SECURE_SNAP_SECOND_OPTIONS = [5, 10, 30, 0]; // 0 = bis zum Schliessen
const SECURE_SNAP_UNLIMITED_CAP_MS = 5 * 60 * 1000;
const SECURE_SNAP_CONNECT_TIMEOUT_MS = 10000;
const SECURE_SNAP_STREAM_TIMEOUT_MS = 6000;
// Antwortet der Sender nicht (Anfrage in einem halb toten Kanal verloren), Kanal neu aufbauen und
// einmal erneut fragen; danach eine klare Meldung statt ewig "Warte auf Freigabe".
const SECURE_SNAP_REQUEST_TIMEOUT_MS = 8000;
const SNAP_SETTINGS_RECORD_ID = 'snap-settings';
// Einmal-Snaps laufen nach der ersten Ansicht ab (Einstellung des Absenders, geht als Enum mit dem
// Snap mit). 'off' = nur die Ansichten zaehlen. Standard 30 min, vom Router per CLIENT_DEFAULTS.snapExpiry.
const SNAP_EXPIRY_OPTIONS = { '15m': 15 * 60 * 1000, '30m': 30 * 60 * 1000, '60m': 60 * 60 * 1000, off: 0 };

function defaultSnapExpiry() {
    const value = clientDefault('snapExpiry', '30m');
    return SNAP_EXPIRY_OPTIONS[value] !== undefined ? value : '30m';
}

// ----- Einstellungen -----
async function loadSnapSettings() {
    try {
        const stored = await databaseRequest('keys', 'readonly', store => store.get(SNAP_SETTINGS_RECORD_ID));
        if (stored) {
            state.snapSettings = {
                secureSnaps: stored.secureSnaps === true,
                views: SECURE_SNAP_VIEW_OPTIONS.includes(stored.views) ? stored.views : 1,
                seconds: SECURE_SNAP_SECOND_OPTIONS.includes(stored.seconds) ? stored.seconds : 10,
                nextGesture: SNAP_NEXT_GESTURES.includes(stored.nextGesture) ? stored.nextGesture : 'doubletap',
                expiry: SNAP_EXPIRY_OPTIONS[stored.expiry] !== undefined ? stored.expiry : defaultSnapExpiry()
            };
        } else {
            const gesture = clientDefault('snapNextGesture', 'doubletap');
            state.snapSettings = {
                ...state.snapSettings,
                secureSnaps: clientDefault('secureSnaps', false) === true,
                nextGesture: SNAP_NEXT_GESTURES.includes(gesture) ? gesture : 'doubletap',
                expiry: defaultSnapExpiry()
            };
        }
    } catch (error) {
        logDebug(`Could not load snap settings: ${error.message}`);
    }
    renderSnapSettings();
}

async function updateSnapSetting(key, value) {
    if (key === 'nextGesture' && !SNAP_NEXT_GESTURES.includes(value)) return;
    if (key === 'expiry' && SNAP_EXPIRY_OPTIONS[value] === undefined) return;
    state.snapSettings = { ...state.snapSettings, [key]: value };
    try {
        await putDatabaseRecord('keys', { id: SNAP_SETTINGS_RECORD_ID, ...state.snapSettings });
    } catch (error) {
        logDebug(`Could not store snap settings: ${error.message}`);
        showToast(t('common.settingCouldNotBeSaved'), 'error');
    }
    renderSnapSettings();
}

function renderSnapSettings() {
    const settings = state.snapSettings;
    const toggle = document.getElementById('secure-snaps-toggle');
    if (toggle) toggle.checked = settings.secureSnaps;
    ['secure-snap-default-views', 'snap-review-views'].forEach(id => {
        const select = document.getElementById(id);
        if (select) select.value = String(settings.views);
    });
    ['secure-snap-default-seconds', 'snap-review-seconds'].forEach(id => {
        const select = document.getElementById(id);
        if (select) select.value = String(settings.seconds);
    });
    const nextGesture = document.getElementById('snap-next-gesture');
    if (nextGesture) nextGesture.value = settings.nextGesture;
    const expiry = document.getElementById('snap-expiry-select');
    if (expiry) expiry.value = settings.expiry;
    document.getElementById('secure-snap-defaults')?.classList.toggle('hidden', !settings.secureSnaps);
    document.getElementById('snap-review-secure-options')?.classList.toggle('hidden', !settings.secureSnaps);
}

function secureSnapDurationLabel(seconds) {
    return seconds ? `${seconds} s` : t('snaps.untilClosed');
}

// ----- Sender -----
function dataUrlToBytes(dataUrl) {
    return base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1));
}

// Verschluesselt den Snap mit einem frischen Schluessel. Der Schluessel bleibt lokal beim Sender.
async function createSecureSnap(dataUrl, peerId, views, seconds) {
    const key = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const bytes = dataUrlToBytes(dataUrl);
    const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    bytes.fill(0);
    const snapId = window.crypto.randomUUID();
    await cacheMediaPayload(`ssnap_${snapId}`, {
        snapId,
        peerId,
        rawKey: bytesToBase64(new Uint8Array(await window.crypto.subtle.exportKey('raw', key))),
        views,
        viewsLeft: views,
        seconds
    });
    return {
        snapId,
        views,
        seconds,
        encrypted: { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) }
    };
}

async function loadSecureSnapSecret(snapId) {
    return loadMedia(`ssnap_${snapId}`);
}

function findSecureSnapMessage(peerId, snapId) {
    return (state.chats[peerId] || []).find(message => message.secureSnap?.snapId === snapId) || null;
}

async function updateOwnSecureSnapMessage(peerId, snapId, changes) {
    const stored = (await getDatabaseRecordsByIndex('messages', 'peerId', peerId))
        .find(message => message.secureSnap?.snapId === snapId);
    const loaded = findSecureSnapMessage(peerId, snapId);
    const target = loaded || stored;
    if (!target) return;
    target.secureSnap = { ...target.secureSnap, ...changes };
    await persistChatMessage(peerId, target);
    if (state.activeChatPeerId === peerId) renderChatHistory();
}

async function handleSnapViewRequest(peerId, payload) {
    const snapId = typeof payload.snapId === 'string' ? payload.snapId : null;
    const secret = snapId ? await loadSecureSnapSecret(snapId) : null;
    if (!secret || secret.peerId !== peerId || secret.viewsLeft <= 0) {
        await sendSecurePayload(peerId, { type: 'SNAP_VIEW_DENIED', snapId });
        return;
    }
    secret.viewsLeft -= 1;
    if (secret.viewsLeft > 0) await cacheMediaPayload(`ssnap_${snapId}`, secret);
    else await deleteDatabaseRecord('media', `ssnap_${snapId}`);
    await updateOwnSecureSnapMessage(peerId, snapId, { viewsUsed: secret.views - secret.viewsLeft });

    const streamed = await startSecureSnapStream(peerId, secret).catch(error => {
        logDebug(`Secure snap stream failed: ${error.message}`);
        return false;
    });
    if (!streamed) {
        await sendSecurePayload(peerId, {
            type: 'SNAP_VIEW_GRANT',
            snapId,
            key: secret.rawKey,
            seconds: secret.seconds,
            viewsLeft: secret.viewsLeft
        });
    }
    // Nach der letzten Ansicht braucht auch der Sender den Ciphertext nicht mehr.
    if (secret.viewsLeft <= 0) await updateOwnSecureSnapMessage(peerId, snapId, { encrypted: undefined });
}

// Eigener Secure Snap: der Sender entschluesselt lokal und sieht ihn ohne Zeitlimit, solange der
// Empfaenger noch Ansichten uebrig hat.
async function openOwnSecureSnap(messageId) {
    const peerId = state.activeChatPeerId;
    const message = state.chats[peerId]?.find(item => item.id === messageId);
    const snapId = message?.secureSnap?.snapId;
    if (!snapId || message.senderId !== state.myProfile.id) return;
    const secret = await loadSecureSnapSecret(snapId);
    let bytes = null;
    try {
        bytes = secret ? await decryptOwnSecureSnap(peerId, secret) : null;
    } catch (error) {
        logDebug(`Own secure snap could not be decrypted: ${error.message}`);
    }
    if (!bytes) {
        showToast(t('snaps.ownSnapNoLongerAvailable'), 'info');
        return;
    }
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    bytes.fill(0);
    openSecureSnapViewer('');
    state.secureSnapViewing = { mode: 'own', peerId, snapId, messageId };
    const image = document.getElementById('secure-snap-image');
    await drawSecureImage(image, blob);
    image.classList.remove('hidden');
}

async function decryptOwnSecureSnap(peerId, secret) {
    const message = findSecureSnapMessage(peerId, secret.snapId)
        || (await getDatabaseRecordsByIndex('messages', 'peerId', peerId)).find(item => item.secureSnap?.snapId === secret.snapId);
    const encrypted = message?.secureSnap?.encrypted;
    if (!encrypted) return null;
    const key = await window.crypto.subtle.importKey('raw', base64ToBytes(secret.rawKey), { name: 'AES-GCM' }, false, ['decrypt']);
    const bytes = new Uint8Array(await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(encrypted.iv) },
        key,
        base64ToBytes(encrypted.ciphertext)
    ));
    return bytes;
}

// Live-Stream: das Bild wird in einen Canvas gezeichnet und als Video-Track gesendet.
async function startSecureSnapStream(peerId, secret) {
    const connection = state.webrtcConnections[peerId];
    if (!connection || connection.connectionState !== 'connected' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
        return false;
    }
    const bytes = await decryptOwnSecureSnap(peerId, secret);
    if (!bytes) return false;
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    bytes.fill(0);
    let image;
    try {
        image = await loadImageElement(objectUrl);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    const draw = () => context.drawImage(image, 0, 0);
    draw();
    const stream = canvas.captureStream(5);
    const track = stream.getVideoTracks()[0];
    // Ein statischer Canvas liefert sonst keine neuen Frames.
    const redraw = setInterval(draw, 200);
    const sender = connection.addTrack(track, stream);
    const session = { peerId, snapId: secret.snapId, sender, track, redraw, connection, playing: false };
    state.outgoingSnapStreams[secret.snapId] = session;

    await sendSecurePayload(peerId, {
        type: 'SNAP_STREAM_START',
        snapId: secret.snapId,
        streamId: stream.id,
        seconds: secret.seconds,
        viewsLeft: secret.viewsLeft
    });
    await renegotiatePeerConnection(peerId);

    const playing = session.playing || await new Promise(resolve => {
        session.onPlaying = () => resolve(true);
        setTimeout(() => resolve(false), SECURE_SNAP_STREAM_TIMEOUT_MS);
    });
    if (!playing) {
        await stopSecureSnapStream(secret.snapId, false);
        return false;
    }
    const duration = secret.seconds ? secret.seconds * 1000 : SECURE_SNAP_UNLIMITED_CAP_MS;
    session.endTimer = setTimeout(() => stopSecureSnapStream(secret.snapId, true), duration + 500);
    return true;
}

async function stopSecureSnapStream(snapId, notify) {
    const session = state.outgoingSnapStreams[snapId];
    if (!session) return;
    delete state.outgoingSnapStreams[snapId];
    clearInterval(session.redraw);
    clearTimeout(session.endTimer);
    session.track.stop();
    try {
        session.connection.removeTrack(session.sender);
        await renegotiatePeerConnection(session.peerId);
    } catch (error) {
        logDebug(`Could not remove snap track: ${error.message}`);
    }
    if (notify) sendSecurePayload(session.peerId, { type: 'SNAP_STREAM_END', snapId }).catch(logBackgroundError('stopSecureSnapStream'));
}

function handleSnapStreamPlaying(peerId, payload) {
    const session = state.outgoingSnapStreams[payload.snapId];
    if (session?.peerId === peerId && !session.playing) {
        session.playing = true;
        session.onPlaying?.();
    }
}

function handleSnapViewClosed(peerId, payload) {
    const session = state.outgoingSnapStreams[payload.snapId];
    if (session?.peerId === peerId) stopSecureSnapStream(payload.snapId, false).catch(logBackgroundError('handleSnapViewClosed'));
}

// ----- Empfaenger -----
function waitForSecureChannel(peerId) {
    if (isSecureChannelOpen(peerId)) return Promise.resolve(true);
    initiateP2PConnection(peerId).catch(logBackgroundError('waitForSecureChannel'));
    return new Promise(resolve => {
        const startedAt = Date.now();
        const check = setInterval(() => {
            if (isSecureChannelOpen(peerId)) {
                clearInterval(check);
                resolve(true);
            } else if (Date.now() - startedAt > SECURE_SNAP_CONNECT_TIMEOUT_MS) {
                clearInterval(check);
                resolve(false);
            }
        }, 250);
    });
}

async function requestSecureSnapView(messageId) {
    const peerId = state.activeChatPeerId;
    const message = state.chats[peerId]?.find(item => item.id === messageId);
    const snap = message?.secureSnap;
    if (!snap || snap.expired || !snap.encrypted || message.senderId === state.myProfile.id) return;
    openSecureSnapViewer(t('snaps.connectingToSender'));
    state.secureSnapViewing = { peerId, snapId: snap.snapId, messageId, phase: 'requesting' };
    if (!await waitForSecureChannel(peerId)) {
        if (state.secureSnapViewing?.snapId === snap.snapId) {
            setSecureSnapStatus(t('snaps.senderIsOfflineRightNow'));
            state.secureSnapViewing = null;
        }
        return;
    }
    await sendSecureSnapRequest(state.secureSnapViewing, 1);
}

async function sendSecureSnapRequest(viewing, attempt) {
    if (state.secureSnapViewing !== viewing || viewing.phase !== 'requesting') return;
    setSecureSnapStatus(t('snaps.waitingForApproval'));
    clearTimeout(viewing.requestTimer);
    viewing.requestTimer = setTimeout(() => {
        handleSecureSnapRequestTimeout(viewing, attempt).catch(logBackgroundError('requestSecureSnapView'));
    }, SECURE_SNAP_REQUEST_TIMEOUT_MS);
    await sendSecurePayload(viewing.peerId, { type: 'SNAP_VIEW_REQUEST', snapId: viewing.snapId });
}

async function handleSecureSnapRequestTimeout(viewing, attempt) {
    if (state.secureSnapViewing !== viewing || viewing.phase !== 'requesting') return;
    if (attempt >= 2) {
        setSecureSnapStatus(t('snaps.senderDoesNotAnswer'));
        state.secureSnapViewing = null;
        return;
    }
    logDebug(`Keine Antwort auf SNAP_VIEW_REQUEST von ${viewing.peerId}: Kanal wird neu aufgebaut.`);
    setSecureSnapStatus(t('snaps.connectingToSender'));
    const connection = state.webrtcConnections[viewing.peerId];
    if (connection && typeof cleanupPeerConnection === 'function') cleanupPeerConnection(viewing.peerId, connection);
    if (!await waitForSecureChannel(viewing.peerId)) {
        if (state.secureSnapViewing === viewing) {
            setSecureSnapStatus(t('snaps.senderIsOfflineRightNow'));
            state.secureSnapViewing = null;
        }
        return;
    }
    await sendSecureSnapRequest(viewing, attempt + 1);
}

function isAwaitingSnap(peerId, snapId) {
    const viewing = state.secureSnapViewing;
    return viewing?.peerId === peerId && viewing.snapId === snapId && viewing.phase === 'requesting';
}

async function handleSnapStreamStart(peerId, payload) {
    if (!isAwaitingSnap(peerId, payload.snapId) || typeof payload.streamId !== 'string') {
        // Niemand wartet (Viewer geschlossen): Sender soll sofort aufhoeren.
        sendSecurePayload(peerId, { type: 'SNAP_VIEW_CLOSED', snapId: payload.snapId }).catch(logBackgroundError('handleSnapStreamStart'));
        return;
    }
    Object.assign(state.secureSnapViewing, {
        phase: 'streaming',
        streamId: payload.streamId,
        seconds: Number(payload.seconds) || 0,
        viewsLeft: Number(payload.viewsLeft) || 0
    });
    setSecureSnapStatus(t('snaps.loadingLiveSnap'));
    const pendingTrack = state.pendingSnapTracks[payload.streamId];
    if (pendingTrack) attachSecureSnapStream(pendingTrack);
}

// Wird von ontrack der RTCPeerConnection aufgerufen.
function handleSnapStreamTrack(peerId, event) {
    const stream = event.streams?.[0];
    if (!stream) return;
    const viewing = state.secureSnapViewing;
    if (viewing?.peerId === peerId && viewing.streamId === stream.id && viewing.phase === 'streaming') {
        attachSecureSnapStream(stream);
    } else {
        // Der Track kann vor SNAP_STREAM_START eintreffen.
        state.pendingSnapTracks[stream.id] = stream;
        setTimeout(() => delete state.pendingSnapTracks[stream.id], SECURE_SNAP_STREAM_TIMEOUT_MS);
    }
}

function attachSecureSnapStream(stream) {
    const viewing = state.secureSnapViewing;
    delete state.pendingSnapTracks[stream.id];
    const video = document.getElementById('secure-snap-video');
    video.srcObject = stream;
    video.classList.remove('hidden');
    video.play().catch(logBackgroundError('attachSecureSnapStream'));
    video.onplaying = () => {
        if (state.secureSnapViewing !== viewing || viewing.started) return;
        viewing.started = true;
        setSecureSnapStatus('');
        sendSecurePayload(viewing.peerId, { type: 'SNAP_STREAM_PLAYING', snapId: viewing.snapId }).catch(logBackgroundError('attachSecureSnapStream'));
        startSecureSnapCountdown(viewing.seconds);
        recordSecureSnapView(viewing.peerId, viewing.snapId, viewing.viewsLeft).catch(logBackgroundError('attachSecureSnapStream'));
    };
}

async function handleSnapViewGrant(peerId, payload) {
    const viewing = state.secureSnapViewing;
    // Auch waehrend eines Streams: kam der beim Sender zu spaet an (erste Neuverhandlung dauert), stoppt
    // er ihn und schickt den Schluessel. Lief das Video hier schon, zaehlt die Zeit einfach weiter.
    const awaiting = isAwaitingSnap(peerId, payload.snapId)
        || (viewing?.peerId === peerId && viewing.snapId === payload.snapId && viewing.phase === 'streaming');
    if (!awaiting || typeof payload.key !== 'string') return;
    const alreadyStarted = viewing.started === true;
    const message = (state.chats[peerId] || []).find(item => item.id === viewing.messageId);
    const encrypted = message?.secureSnap?.encrypted;
    if (!encrypted) return;
    viewing.phase = 'granted';
    let bytes = null;
    let blob = null;
    try {
        const rawKey = base64ToBytes(payload.key);
        const key = await window.crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
        rawKey.fill(0);
        bytes = new Uint8Array(await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: base64ToBytes(encrypted.iv) },
            key,
            base64ToBytes(encrypted.ciphertext)
        ));
        blob = new Blob([bytes], { type: 'image/jpeg' });
    } catch (error) {
        logDebug(`Secure snap decryption failed: ${error.message}`);
        setSecureSnapStatus(t('snaps.couldNotBeDecrypted'));
        return;
    } finally {
        // Best effort: den entschluesselten Puffer sofort ueberschreiben.
        bytes?.fill(0);
    }
    const image = document.getElementById('secure-snap-image');
    await drawSecureImage(image, blob);
    if (state.secureSnapViewing !== viewing) {
        clearSecureCanvas(image);
        return;
    }
    const video = document.getElementById('secure-snap-video');
    video.pause();
    video.srcObject = null;
    video.classList.add('hidden');
    image.classList.remove('hidden');
    setSecureSnapStatus('');
    if (alreadyStarted) return;
    viewing.started = true;
    startSecureSnapCountdown(Number(payload.seconds) || 0);
    await recordSecureSnapView(peerId, payload.snapId, Number(payload.viewsLeft) || 0);
}

async function handleSnapViewDenied(peerId, payload) {
    const message = findSecureSnapMessage(peerId, payload.snapId);
    if (message && message.senderId === peerId) {
        message.secureSnap = { ...message.secureSnap, expired: true, encrypted: undefined, viewsLeft: 0 };
        await persistChatMessage(peerId, message);
        if (state.activeChatPeerId === peerId) renderChatHistory();
    }
    if (isAwaitingSnap(peerId, payload.snapId)) {
        setSecureSnapStatus(t('snaps.thisSnapHasExpired'));
        state.secureSnapViewing = null;
    }
}

// Nach der letzten Ansicht wird auch der Ciphertext geloescht.
async function recordSecureSnapView(peerId, snapId, viewsLeft) {
    const message = findSecureSnapMessage(peerId, snapId);
    if (!message) return;
    message.secureSnap = {
        ...message.secureSnap,
        viewsLeft,
        ...(viewsLeft <= 0 ? { expired: true, encrypted: undefined } : {})
    };
    await persistChatMessage(peerId, message);
    if (state.activeChatPeerId === peerId) renderChatHistory();
}

function handleSnapStreamEnd(peerId, payload) {
    const viewing = state.secureSnapViewing;
    if (viewing?.peerId === peerId && viewing.snapId === payload.snapId) closeSecureSnapViewer();
}

// ----- Viewer -----
function openSecureSnapViewer(status) {
    const viewer = document.getElementById('secure-snap-viewer');
    if (viewer.classList.contains('hidden')) {
        viewer.classList.remove('hidden');
        pushModalEntry('securesnap', hideSecureSnapViewer);
    }
    setSecureSnapStatus(status);
}

function setSecureSnapStatus(text) {
    const status = document.getElementById('secure-snap-status');
    status.textContent = text;
    status.classList.toggle('hidden', !text);
}

function startSecureSnapCountdown(seconds) {
    const viewing = state.secureSnapViewing;
    const ring = document.getElementById('secure-snap-countdown');
    const progress = document.getElementById('secure-snap-countdown-progress');
    if (!seconds) {
        ring.classList.add('hidden');
        viewing.timer = setTimeout(closeSecureSnapViewer, SECURE_SNAP_UNLIMITED_CAP_MS);
        return;
    }
    ring.classList.remove('hidden');
    const circumference = 2 * Math.PI * 16;
    progress.style.strokeDasharray = `${circumference}`;
    progress.style.transition = 'none';
    progress.style.strokeDashoffset = '0';
    requestAnimationFrame(() => {
        progress.style.transition = `stroke-dashoffset ${seconds}s linear`;
        progress.style.strokeDashoffset = `${circumference}`;
    });
    viewing.timer = setTimeout(closeSecureSnapViewer, seconds * 1000);
}

function closeSecureSnapViewer() {
    if (document.getElementById('secure-snap-viewer').classList.contains('hidden')) return;
    dismissModalEntry('securesnap', hideSecureSnapViewer);
}

function hideSecureSnapViewer() {
    const viewing = state.secureSnapViewing;
    state.secureSnapViewing = null;
    if (viewing) {
        clearTimeout(viewing.timer);
        clearTimeout(viewing.requestTimer);
        if (viewing.phase === 'streaming') {
            sendSecurePayload(viewing.peerId, { type: 'SNAP_VIEW_CLOSED', snapId: viewing.snapId }).catch(logBackgroundError('hideSecureSnapViewer'));
        }
        if (viewing.mode === 'replay') finishReplaySnapView(viewing).catch(logBackgroundError('hideSecureSnapViewer'));
    }
    document.getElementById('secure-snap-save').classList.add('hidden');
    document.getElementById('secure-snap-queue')?.classList.add('hidden');
    const video = document.getElementById('secure-snap-video');
    video.pause();
    video.srcObject = null;
    video.classList.add('hidden');
    const image = document.getElementById('secure-snap-image');
    clearSecureCanvas(image);
    image.classList.add('hidden');
    document.getElementById('secure-snap-countdown').classList.add('hidden');
    document.getElementById('secure-snap-viewer').classList.add('hidden');
}

// Verlaesst man die App (z. B. App-Wechsler), wird der Snap sofort geschlossen.
// Nach unten wischen schliesst den Snap. touch-action: none am Viewer verhindert, dass der Browser
// die Geste als "Seite neu laden" (Pull-to-Refresh) nimmt.
// Mehrere ungesehene Einmal-Snaps: weiter zum naechsten per Doppeltippen, seitlich wischen oder nach
// oben wischen (Einstellung snapSettings.nextGesture).
const SNAP_VIEWER_CLOSE_SWIPE = 110;
const SNAP_VIEWER_NEXT_SWIPE = 80;
const SNAP_NEXT_GESTURES = ['doubletap', 'swipe', 'swipeup'];

function initSecureSnaps() {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && state.secureSnapViewing) closeSecureSnapViewer();
    });
    const viewer = document.getElementById('secure-snap-viewer');
    if (!viewer) return;
    let swipe = null;
    const content = () => [document.getElementById('secure-snap-image'), document.getElementById('secure-snap-video')];
    viewer.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) return;
        swipe = { pointerId: event.pointerId, startY: event.clientY, startX: event.clientX, deltaY: 0 };
    });
    viewer.addEventListener('pointermove', event => {
        if (!swipe || swipe.pointerId !== event.pointerId) return;
        swipe.deltaY = Math.max(0, event.clientY - swipe.startY);
        content().forEach(element => {
            if (element) element.style.transform = `translate3d(0, ${swipe.deltaY}px, 0)`;
        });
    });
    let lastTap = 0;
    const finish = event => {
        if (!swipe || swipe.pointerId !== event.pointerId) return;
        const { deltaY, startX, startY } = swipe;
        swipe = null;
        content().forEach(element => {
            if (element) element.style.transform = '';
        });
        const deltaX = event.clientX - startX;
        const rawY = event.clientY - startY;
        if (deltaY > SNAP_VIEWER_CLOSE_SWIPE && Math.abs(deltaX) < deltaY) {
            closeSecureSnapViewer();
            return;
        }
        if (state.secureSnapViewing?.mode !== 'replay') return;
        const gesture = state.snapSettings.nextGesture;
        const tapped = Math.hypot(deltaX, rawY) < 10;
        if (gesture === 'swipe' && Math.abs(deltaX) > SNAP_VIEWER_NEXT_SWIPE && Math.abs(deltaX) > Math.abs(rawY)) {
            advanceReplaySnap();
        } else if (gesture === 'swipeup' && -rawY > SNAP_VIEWER_NEXT_SWIPE && Math.abs(rawY) > Math.abs(deltaX)) {
            advanceReplaySnap();
        } else if (gesture === 'doubletap' && tapped) {
            const now = Date.now();
            if (now - lastTap < 300) {
                lastTap = 0;
                advanceReplaySnap();
            } else {
                lastTap = now;
            }
        }
    };
    viewer.addEventListener('pointerup', finish);
    viewer.addEventListener('pointercancel', finish);
}

// ----- Chat-Darstellung -----
function renderSecureSnapMessage(bubble, message, isMine) {
    const snap = message.secureSnap;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'flex items-center gap-3 text-left w-56';
    const icon = document.createElement('span');
    icon.className = `w-10 h-10 shrink-0 rounded-xl flex items-center justify-center text-lg ${snap.expired ? 'bg-slate-700 text-slate-400' : 'bg-amber-500/20 text-amber-300'}`;
    icon.innerHTML = '<i class="fa-solid fa-lock"></i>';
    const details = document.createElement('div');
    details.className = 'min-w-0';
    const title = document.createElement('div');
    title.className = 'font-semibold';
    title.textContent = t('common.secureSnap');
    const meta = document.createElement('div');
    meta.className = 'opacity-75 text-[11px]';
    const views = Number.isInteger(snap.views) ? snap.views : 1;
    if (isMine) {
        const used = snap.viewsUsed || 0;
        meta.textContent = used >= views ? t('snaps.seen', { used, views }) : t('snaps.viewed2', { used, views, duration: secureSnapDurationLabel(snap.seconds) });
        if (used >= views || !snap.encrypted) {
            card.disabled = true;
        } else {
            card.onclick = event => {
                event.stopPropagation();
                openOwnSecureSnap(message.id).catch(logBackgroundError('openOwnSecureSnap'));
            };
        }
    } else if (snap.expired || !snap.encrypted) {
        meta.textContent = t('snaps.expired');
        card.disabled = true;
    } else {
        const left = Number.isInteger(snap.viewsLeft) ? snap.viewsLeft : views;
        meta.textContent = t('snaps.tapToViewXLeft', { left, value: secureSnapDurationLabel(snap.seconds) });
        card.onclick = event => {
            event.stopPropagation();
            requestSecureSnapView(message.id);
        };
    }
    details.append(title, meta);
    card.append(icon, details);
    bubble.appendChild(card);
}
