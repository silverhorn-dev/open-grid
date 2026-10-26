// ================= VIDEOS (nur P2P) =================
// Die Nachricht traegt nur ein kleines Vorschaubild (`snapData`, wie "Als Bild senden"), die Laenge
// und Groesse (`video`) sowie `original: { size, sha256, mime }`. Das Video selbst geht wie ein
// Originalbild (originals.js) ausschliesslich ueber den verschluesselten DataChannel (P2P oder TURN),
// nie ueber den Router-Cache. Der Empfaenger prueft den SHA-256 und speichert es verschluesselt.
const VIDEO_MAX_BYTES = 25 * 1024 * 1024;
const VIDEO_POSTER_EDGE = 480;
const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg'];
const VIDEO_POSTER_TIMEOUT_MS = 10000;

function isSafeInlineVideo(value) {
    return typeof value === 'string' && /^data:video\/(?:mp4|webm|quicktime|ogg);base64,/i.test(value.slice(0, 40));
}

function pickChatVideo() {
    const peerId = state.activeChatPeerId;
    if (!peerId) return;
    const allowance = getPeerChatAllowance(peerId);
    if (allowance && (!allowance.allowed || !allowance.images)) {
        showToast(allowance.reason || 'Videos sind erst nach einem Match erlaubt.', 'info');
        return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = VIDEO_MIME_TYPES.join(',');
    input.onchange = () => {
        const file = input.files?.[0];
        if (file) sendVideoFile(file).catch(error => {
            logDebug(`Video senden fehlgeschlagen: ${error.message}`);
            showToast('Video konnte nicht gesendet werden.', 'error');
        });
    };
    input.click();
}

async function sendVideoFile(file) {
    if (!VIDEO_MIME_TYPES.includes(file.type)) {
        showToast('Dieses Videoformat wird nicht unterstuetzt.', 'error');
        return;
    }
    if (file.size > VIDEO_MAX_BYTES) {
        showToast(`Video zu gross (hoechstens ${Math.round(VIDEO_MAX_BYTES / 1024 / 1024)} MB).`, 'error');
        return;
    }
    showToast('Video wird vorbereitet...', 'info');
    const url = URL.createObjectURL(file);
    let poster;
    try {
        poster = await captureVideoPoster(url);
    } finally {
        URL.revokeObjectURL(url);
    }
    const dataUrl = await mediaBlobToDataUrl(file);
    if (!isSafeInlineVideo(dataUrl)) throw new Error('Unerwartetes Videoformat.');
    const meta = { size: dataUrl.length, sha256: await sha256Base64(dataUrl), mime: file.type };
    await sendChatMessage(poster.dataUrl, '', null, null, {
        asImage: true,
        original: { dataUrl, meta },
        video: { duration: Math.round(poster.duration * 10) / 10, w: poster.w, h: poster.h }
    });
}

// Erstes Bild (bei 0,1 s) als JPEG-Vorschau, dazu Laenge und Groesse.
function captureVideoPoster(url) {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        const timer = setTimeout(() => reject(new Error('Video nicht lesbar.')), VIDEO_POSTER_TIMEOUT_MS);
        video.onerror = () => {
            clearTimeout(timer);
            reject(new Error('Video nicht lesbar.'));
        };
        video.onloadedmetadata = () => {
            video.currentTime = Math.min(0.1, (video.duration || 0) / 2);
        };
        video.onseeked = () => {
            clearTimeout(timer);
            const scale = Math.min(1, VIDEO_POSTER_EDGE / Math.max(video.videoWidth, video.videoHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            let quality = 0.75;
            let dataUrl = canvas.toDataURL('image/jpeg', quality);
            while (dataUrl.length > SNAP_MAX_DATA_URL_LENGTH && quality > 0.3) {
                quality -= 0.15;
                dataUrl = canvas.toDataURL('image/jpeg', quality);
            }
            resolve({ dataUrl, duration: Number.isFinite(video.duration) ? video.duration : 0, w: video.videoWidth, h: video.videoHeight });
        };
        video.src = url;
    });
}

function isVideoAvailable(message) {
    return message.senderId === state.myProfile.id || Boolean(message.originalReady);
}

// Vorschaubild mit Abspiel-Symbol und Laenge; ohne Video ein Hinweis auf die direkte Uebertragung.
function renderVideoMessage(bubble, message, isMine) {
    const frame = document.createElement('div');
    frame.className = 'relative cursor-pointer mb-1.5';
    frame.dataset.video = message.id;
    if (isSafeInlineImage(message.snapData)) {
        frame.appendChild(createSecureImage(message.snapData, 'w-48 sm:w-64 rounded-xl border border-slate-900/50', message.imageSize || message.video));
    }
    const overlay = document.createElement('div');
    overlay.className = 'absolute inset-0 flex items-center justify-center pointer-events-none';
    overlay.innerHTML = '<span class="w-12 h-12 rounded-full bg-black/55 text-white flex items-center justify-center"><i class="fa-solid fa-play"></i></span>';
    const duration = document.createElement('span');
    duration.className = 'absolute bottom-1.5 right-2 text-[11px] text-white bg-black/55 rounded px-1 pointer-events-none';
    duration.textContent = formatVoiceDuration(message.video?.duration);
    frame.append(overlay, duration);
    frame.onclick = event => {
        event.stopPropagation();
        openChatVideo(message).catch(logBackgroundError('openChatVideo'));
    };
    bubble.appendChild(frame);
    if (message.text) {
        const caption = document.createElement('div');
        caption.className = 'opacity-90';
        caption.textContent = message.text;
        bubble.appendChild(caption);
    }
    if (!isVideoAvailable(message)) {
        const badge = document.createElement('div');
        badge.className = 'text-[11px] opacity-75';
        badge.dataset.originalBadge = message.id;
        badge.textContent = 'Video kommt bei direkter Verbindung';
        bubble.appendChild(badge);
        renderOriginalProgress(message.id);
    }
}

async function openChatVideo(message) {
    if (!isVideoAvailable(message)) {
        showToast('Das Video wird nur direkt uebertragen und kommt, sobald ihr verbunden seid.', 'info');
        const peerId = state.activeChatPeerId;
        if (peerId) {
            if (!isSecureChannelOpen(peerId)) initiateP2PConnection(peerId).catch(logBackgroundError('openChatVideo'));
            else requestMissingOriginals(peerId).catch(logBackgroundError('openChatVideo'));
        }
        return;
    }
    const data = await loadOriginal(message.id);
    if (!isSafeInlineVideo(data)) {
        showToast('Video nicht gefunden.', 'error');
        return;
    }
    const url = URL.createObjectURL(mediaDataUrlToBlob(data));
    const content = openMediaModal('Video');
    const video = document.createElement('video');
    video.className = 'w-full max-h-[70dvh] rounded-lg bg-black';
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.disablePictureInPicture = true;
    video.setAttribute('controlsList', 'nodownload noremoteplayback');
    video.oncontextmenu = event => event.preventDefault();
    video.src = url;
    content.appendChild(video);
    state.mediaModalCleanup = () => {
        video.pause();
        video.removeAttribute('src');
        URL.revokeObjectURL(url);
    };
}
