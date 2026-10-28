// ================= SPRACHNACHRICHTEN =================
// Aufnahme per MediaRecorder (Opus, ca. 12 kbit/s). Die ersten VOICE_LIMITS.inlineSeconds gehen als
// Data-URL im verschluesselten MESSAGE_PUT mit (`audioData`), wie ein Bild: P2P oder Pfad C. Ist die
// Aufnahme laenger, startet an dieser Stelle ein zweiter Recorder; der Rest ist eine eigene, abspielbare
// Datei und geht wie ein Originalbild (originals.js) nur ueber den DataChannel (`original`,
// `audioSplitAt` = Sekunde des Wechsels). Der Empfaenger kann den Anfang sofort hoeren, der Rest wird
// geholt, sobald eine direkte Verbindung steht, auch waehrend des Abspielens.
// Am Maximum stoppt die Aufnahme nur; gesendet wird nie automatisch.
// Verschriftlichung nur, wenn der Browser sie lokal auf dem Geraet kann (SpeechRecognition mit
// `processLocally`); nie ueber einen Cloud-Dienst. Der Text geht als `transcript` mit.
const VOICE_LIMITS = { inlineSeconds: 60, maxSeconds: 15 * 60 };
const VOICE_BITRATE = 12000;
const VOICE_MAX_DATA_URL_LENGTH = 160000;
const VOICE_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const TRANSCRIPT_MAX_LENGTH = 2000;
const TRANSCRIPT_FINISH_MS = 1500;

function isSafeInlineAudio(value) {
    return typeof value === 'string'
        && value.length <= VOICE_MAX_DATA_URL_LENGTH
        && /^data:audio\/(?:webm|ogg|mp4|mpeg|aac)(?:;codecs=[a-z0-9.]+)?;base64,[a-z0-9+/=]+$/i.test(value);
}

// Zweiter Teil (ueber P2P): nur Kopf pruefen, die Laenge prueft originals.js gegen `original.size`.
function isSafeAudioPart(value) {
    return typeof value === 'string' && /^data:audio\/(?:webm|ogg|mp4|mpeg|aac)(?:;codecs=[a-z0-9.]+)?;base64,/i.test(value.slice(0, 60));
}

function isVoiceSupported() {
    return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

function formatVoiceDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function mediaBlobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error('Datei nicht lesbar.'));
        reader.readAsDataURL(blob);
    });
}

function mediaDataUrlToBlob(dataUrl) {
    const separator = dataUrl.indexOf(',');
    const mime = dataUrl.slice(5, separator).replace(/;base64$/, '');
    const binary = atob(dataUrl.slice(separator + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
}

// ----- Eingabeleiste: Mikrofon statt Senden, solange kein Text da ist -----
function updateComposeButtons() {
    const input = document.getElementById('chat-input');
    const voice = document.getElementById('chat-voice-btn');
    const send = document.getElementById('send-chat-btn');
    if (!input || !voice || !send) return;
    const showVoice = isVoiceSupported() && !input.value.trim();
    voice.classList.toggle('hidden', !showVoice);
    send.classList.toggle('hidden', showVoice);
}

// ----- Aufnahme -----
function startVoiceSegment(recording) {
    const segment = { recorder: new MediaRecorder(recording.stream, { ...(recording.mimeType ? { mimeType: recording.mimeType } : {}), audioBitsPerSecond: VOICE_BITRATE }), chunks: [], startedAt: Date.now() };
    segment.recorder.ondataavailable = event => {
        if (event.data?.size) segment.chunks.push(event.data);
    };
    segment.recorder.start(1000);
    recording.segments.push(segment);
    return segment;
}

async function stopVoiceSegment(segment) {
    if (segment.recorder.state !== 'inactive') {
        await new Promise(resolve => {
            segment.recorder.onstop = resolve;
            segment.recorder.stop();
        });
    }
    segment.stoppedAt = segment.stoppedAt || Date.now();
}

function voiceSegmentBlob(segment) {
    return new Blob(segment.chunks, { type: segment.recorder.mimeType || segment.chunks[0]?.type || 'audio/webm' });
}

async function startVoiceRecording() {
    const peerId = state.activeChatPeerId;
    if (state.voiceRecording || !peerId || isPeerBlocked(peerId)) return;
    // Sprachnachrichten zaehlen wie Bilder (Chat-Berechtigungen des anderen).
    const allowance = getPeerChatAllowance(peerId);
    if (allowance && (!allowance.allowed || !allowance.images)) {
        showToast(allowance.reason || t('voice.messagesAreOnlyAllowed'), 'info');
        return;
    }
    if (!isVoiceSupported()) {
        showToast(t('voice.thisBrowserDoesNotSupport'), 'error');
        return;
    }
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
        logDebug(`Mikrofon nicht verfuegbar: ${error.message}`);
        showToast(t('voice.noAccessToMicrophone'), 'error');
        return;
    }
    const recording = {
        peerId,
        stream,
        mimeType: VOICE_MIME_TYPES.find(type => MediaRecorder.isTypeSupported?.(type)),
        segments: [],
        startedAt: Date.now(),
        transcript: '',
        recognition: null,
        finished: false
    };
    startVoiceSegment(recording);
    recording.timer = setInterval(() => tickVoiceRecording(recording).catch(logBackgroundError('tickVoiceRecording')), 250);
    state.voiceRecording = recording;
    startLocalTranscript(recording).catch(logBackgroundError('startLocalTranscript'));
    hapticTick();
    renderVoiceBar();
}

async function tickVoiceRecording(recording) {
    if (state.voiceRecording !== recording || recording.finished || recording.switching) return;
    const elapsed = voiceElapsedSeconds(recording);
    if (elapsed >= VOICE_LIMITS.maxSeconds) {
        // Maximum: nur anhalten, senden entscheidet der Nutzer.
        await finishVoiceCapture(recording);
        hapticTick(20);
        showToast(t('voice.maximumLengthReachedSendOr'), 'info');
    } else if (recording.segments.length === 1 && elapsed >= VOICE_LIMITS.inlineSeconds) {
        // Ab hier ein eigener zweiter Teil (geht nur per P2P).
        recording.switching = true;
        const first = recording.segments[0];
        startVoiceSegment(recording);
        await stopVoiceSegment(first);
        recording.switching = false;
    }
    renderVoiceBar();
}

function voiceElapsedSeconds(recording) {
    return ((recording.finishedAt || Date.now()) - recording.startedAt) / 1000;
}

async function finishVoiceCapture(recording) {
    if (recording.finished) return;
    recording.finished = true;
    recording.finishedAt = Date.now();
    clearInterval(recording.timer);
    for (const segment of recording.segments) await stopVoiceSegment(segment);
    recording.stream.getTracks().forEach(track => track.stop());
    await finishLocalTranscript(recording);
}

async function cancelVoiceRecording() {
    const recording = state.voiceRecording;
    if (!recording) return;
    state.voiceRecording = null;
    renderVoiceBar();
    await finishVoiceCapture(recording);
}

async function sendVoiceRecording() {
    const recording = state.voiceRecording;
    if (!recording) return;
    state.voiceRecording = null;
    renderVoiceBar();
    await finishVoiceCapture(recording);
    const duration = Math.min(VOICE_LIMITS.maxSeconds, Math.round(voiceElapsedSeconds(recording) * 10) / 10);
    const [first, rest] = recording.segments;
    if (duration < 1 || !first?.chunks.length) {
        showToast(t('voice.tooShortNothingSent'), 'info');
        return;
    }
    const dataUrl = await mediaBlobToDataUrl(voiceSegmentBlob(first));
    if (!isSafeInlineAudio(dataUrl)) {
        logDebug(`Sprachnachricht abgelehnt (${dataUrl.length} Zeichen).`);
        showToast(t('voice.messageTooLargeOr'), 'error');
        return;
    }
    let original;
    let splitAt;
    if (rest?.chunks.length) {
        const restBlob = voiceSegmentBlob(rest);
        const restUrl = await mediaBlobToDataUrl(restBlob);
        if (!isSafeAudioPart(restUrl)) throw new Error('Unerwartetes Audioformat.');
        original = { dataUrl: restUrl, meta: { size: restUrl.length, sha256: await sha256Base64(restUrl), mime: restBlob.type.split(';')[0] } };
        splitAt = Math.round(((first.stoppedAt - first.startedAt) / 1000) * 10) / 10;
    }
    if (state.activeChatPeerId !== recording.peerId) return;
    await sendChatMessage(null, '', null, null, {
        audio: { data: dataUrl, duration, splitAt, transcript: recording.transcript.slice(0, TRANSCRIPT_MAX_LENGTH) || undefined },
        original
    });
}

// Aufnahmeleiste ersetzt waehrend der Aufnahme die Eingabezeile.
function renderVoiceBar() {
    const bar = document.getElementById('chat-voice-bar');
    const row = document.getElementById('chat-compose-row');
    if (!bar || !row) return;
    const recording = state.voiceRecording;
    bar.classList.toggle('hidden', !recording);
    row.classList.toggle('hidden', Boolean(recording));
    if (!recording) return;
    const elapsed = Math.min(VOICE_LIMITS.maxSeconds, voiceElapsedSeconds(recording));
    document.getElementById('chat-voice-time').textContent = recording.finished
        ? `${formatVoiceDuration(elapsed)} (Maximum)`
        : formatVoiceDuration(elapsed);
    document.getElementById('chat-voice-dot').classList.toggle('hidden', recording.finished);
    // Ab hier geht der Rest nur direkt (P2P) raus.
    document.getElementById('chat-voice-direct-hint').classList.toggle('hidden', elapsed < VOICE_LIMITS.inlineSeconds);
    document.getElementById('chat-voice-transcript-hint').classList.toggle('hidden', !recording.recognition);
}

// ----- Lokale Verschriftlichung (nur auf dem Geraet) -----
async function startLocalTranscript(recording) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition || typeof Recognition.available !== 'function' || !('processLocally' in Recognition.prototype)) return;
    const lang = navigator.language || 'de-DE';
    let availability = 'unavailable';
    try {
        availability = await Recognition.available({ langs: [lang], processLocally: true });
    } catch {
        return;
    }
    if (availability !== 'available' || state.voiceRecording !== recording) return;
    const recognition = new Recognition();
    recognition.lang = lang;
    recognition.processLocally = true;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = event => {
        recording.transcript = [...event.results]
            .filter(result => result.isFinal)
            .map(result => result[0]?.transcript || '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    };
    recognition.onerror = event => logDebug(`Lokale Verschriftlichung: ${event.error}`);
    recording.recognition = recognition;
    try {
        recognition.start();
    } catch {
        recording.recognition = null;
    }
    renderVoiceBar();
}

async function finishLocalTranscript(recording) {
    const recognition = recording.recognition;
    if (!recognition) return;
    await new Promise(resolve => {
        const timer = setTimeout(resolve, TRANSCRIPT_FINISH_MS);
        recognition.onend = () => {
            clearTimeout(timer);
            resolve();
        };
        try {
            recognition.stop();
        } catch {
            clearTimeout(timer);
            resolve();
        }
    });
}

// ----- Wiedergabe im Chat -----
function hasVoiceRest(message) {
    return Boolean(message.original) && Number.isFinite(message.audioSplitAt);
}

function isVoiceRestAvailable(message) {
    return message.senderId === state.myProfile.id || Boolean(message.originalReady);
}

// Wiedergabe-Geschwindigkeit fuer alle Sprachnachrichten (lokal gemerkt).
const VOICE_RATES = [1, 1.5, 2];
const VOICE_RATE_STORAGE_KEY = 'opengrid-voice-rate';

function voiceRate() {
    try {
        const stored = Number(window.localStorage.getItem(VOICE_RATE_STORAGE_KEY));
        return VOICE_RATES.includes(stored) ? stored : 1;
    } catch {
        return 1;
    }
}

function voiceRateLabel(rate) {
    return `${String(rate).replace('.', t('voice.decimalSeparator'))}×`;
}

function cycleVoiceRate() {
    const next = VOICE_RATES[(VOICE_RATES.indexOf(voiceRate()) + 1) % VOICE_RATES.length];
    try {
        window.localStorage.setItem(VOICE_RATE_STORAGE_KEY, String(next));
    } catch {
        // Ohne Speicher gilt die Wahl nur fuer diese Wiedergabe.
    }
    if (state.voicePlayback?.audio) state.voicePlayback.audio.playbackRate = next;
    document.querySelectorAll('[data-voice] .voice-rate').forEach(button => { button.textContent = voiceRateLabel(next); });
}

function renderVoiceMessage(bubble, message, isMine) {
    const player = document.createElement('div');
    player.className = 'flex items-center gap-2 min-w-50 py-0.5';
    player.dataset.voice = message.id;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `voice-play w-9 h-9 shrink-0 rounded-full flex items-center justify-center ${isMine ? 'bg-white/20' : 'bg-slate-700'}`;
    button.setAttribute('aria-label', t('voice.playVoiceMessage'));
    button.innerHTML = '<i class="fa-solid fa-play"></i>';
    button.onclick = event => {
        event.stopPropagation();
        toggleVoicePlayback(message);
    };
    // Leiste: tippen oder ziehen springt an die Stelle (auch in den Rest, sobald er da ist).
    const track = document.createElement('div');
    track.className = 'voice-track relative flex-1 h-6 flex items-center cursor-pointer touch-none';
    track.dataset.voiceTrack = message.id;
    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', t('voice.position'));
    const rail = document.createElement('div');
    rail.className = `relative w-full h-1.5 rounded-full ${isMine ? 'bg-white/30' : 'bg-slate-600'}`;
    const fill = document.createElement('div');
    fill.className = `voice-fill absolute inset-y-0 left-0 rounded-full ${isMine ? 'bg-white' : 'bg-brand-400'}`;
    fill.style.width = '0%';
    const thumb = document.createElement('div');
    thumb.className = `voice-thumb absolute top-1/2 w-3 h-3 -mt-1.5 -ml-1.5 rounded-full shadow-sm ${isMine ? 'bg-white' : 'bg-brand-400'}`;
    thumb.style.left = '0%';
    rail.append(fill, thumb);
    if (hasVoiceRest(message) && !isVoiceRestAvailable(message)) {
        // Markierung: bis hier ist die Aufnahme da, der Rest kommt direkt.
        const mark = document.createElement('div');
        mark.className = 'absolute inset-y-0 right-0 rounded-r-full bg-[repeating-linear-gradient(90deg,transparent_0_3px,rgb(0_0_0/0.25)_3px_6px)]';
        mark.style.left = `${Math.round((message.audioSplitAt / message.audioDuration) * 100)}%`;
        rail.appendChild(mark);
    }
    track.appendChild(rail);
    attachVoiceSeek(track, message);
    const time = document.createElement('span');
    time.className = 'voice-time text-[11px] tabular-nums opacity-80';
    time.textContent = formatVoiceDuration(message.audioDuration);
    const rate = document.createElement('button');
    rate.type = 'button';
    rate.className = `voice-rate shrink-0 min-w-9 h-6 px-1.5 rounded-full text-[11px] font-semibold tabular-nums ${isMine ? 'bg-white/20' : 'bg-slate-700'}`;
    rate.setAttribute('aria-label', t('voice.playbackSpeed'));
    rate.textContent = voiceRateLabel(voiceRate());
    rate.onclick = event => {
        event.stopPropagation();
        cycleVoiceRate();
    };
    player.append(button, track, time, rate);
    bubble.appendChild(player);
    if (hasVoiceRest(message) && !isVoiceRestAvailable(message)) {
        const badge = document.createElement('div');
        badge.className = 'voice-rest-hint text-[11px] opacity-75 mt-0.5';
        badge.dataset.originalBadge = message.id;
        badge.textContent = t('voice.fromOnRestFollowsOver', { value: formatVoiceDuration(message.audioSplitAt) });
        bubble.appendChild(badge);
        renderOriginalProgress(message.id);
    }
    if (message.transcript) {
        const transcript = document.createElement('div');
        transcript.className = 'text-xs opacity-80 mt-1 italic';
        transcript.textContent = message.transcript;
        bubble.appendChild(transcript);
    }
    // Laufende Wiedergabe direkt am neuen Element zeigen (es haengt noch nicht im DOM; vorher
    // stand bis zum naechsten Zeit-Update "Play" und eine leere Leiste da: das Flackern).
    applyVoicePlayerState(player, message.id);
}

function attachVoiceSeek(track, message) {
    let pointerId = null;
    const seekTo = event => {
        const box = track.getBoundingClientRect();
        const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / (box.width || 1)));
        seekVoicePlayback(message, fraction * (message.audioDuration || 0)).catch(logBackgroundError('seekVoicePlayback'));
    };
    track.addEventListener('pointerdown', event => {
        event.stopPropagation();
        pointerId = event.pointerId;
        track.setPointerCapture?.(event.pointerId);
        seekTo(event);
    });
    track.addEventListener('pointermove', event => {
        if (event.pointerId === pointerId) seekTo(event);
    });
    const release = event => {
        if (event.pointerId === pointerId) pointerId = null;
    };
    track.addEventListener('pointerup', release);
    track.addEventListener('pointercancel', release);
    track.addEventListener('click', event => event.stopPropagation());
}

function voicePlaybackPosition(playback) {
    if (playback.waiting) return playback.splitAt;
    return (playback.part === 1 ? playback.splitAt : 0) + (playback.audio?.currentTime || 0);
}

function applyVoicePlayerState(player, messageId) {
    if (!player) return;
    const playback = state.voicePlayback;
    const active = playback?.messageId === messageId;
    const playing = active && (playback.waiting || (playback.audio && !playback.audio.paused));
    const icon = playback?.waiting && active ? 'fa-spinner fa-spin' : playing ? 'fa-pause' : 'fa-play';
    const button = player.querySelector('.voice-play');
    // Nur bei Aenderung neu setzen (sonst flackert das Symbol bei jedem Zeit-Update).
    if (button.dataset.icon !== icon) {
        button.dataset.icon = icon;
        button.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    }
    if (!active) return;
    const position = voicePlaybackPosition(playback);
    const percent = `${Math.min(1, position / (playback.duration || 1)) * 100}%`;
    player.querySelector('.voice-fill').style.width = percent;
    player.querySelector('.voice-thumb').style.left = percent;
    player.querySelector('.voice-time').textContent = formatVoiceDuration(position);
}

function updateVoicePlayer(messageId) {
    applyVoicePlayerState(document.querySelector(`[data-voice="${messageId}"]`), messageId);
}

function releaseVoiceAudio(playback) {
    if (!playback?.audio) return;
    playback.audio.onended = null;
    playback.audio.pause();
    URL.revokeObjectURL(playback.url);
    playback.audio = null;
}

function stopVoicePlayback() {
    const playback = state.voicePlayback;
    if (!playback) return;
    state.voicePlayback = null;
    releaseVoiceAudio(playback);
    const player = document.querySelector(`[data-voice="${playback.messageId}"]`);
    if (player) {
        applyVoicePlayerState(player, playback.messageId);
        player.querySelector('.voice-fill').style.width = '0%';
        player.querySelector('.voice-thumb').style.left = '0%';
        player.querySelector('.voice-time').textContent = formatVoiceDuration(playback.duration);
    }
}

function playVoicePart(playback, dataUrl, part, startAt = 0, { paused = false } = {}) {
    releaseVoiceAudio(playback);
    playback.part = part;
    playback.waiting = false;
    playback.url = URL.createObjectURL(mediaDataUrlToBlob(dataUrl));
    const audio = new Audio(playback.url);
    playback.audio = audio;
    audio.playbackRate = voiceRate();
    if (startAt > 0) {
        audio.addEventListener('loadedmetadata', () => {
            audio.currentTime = startAt;
            updateVoicePlayer(playback.messageId);
        }, { once: true });
    }
    audio.ontimeupdate = () => updateVoicePlayer(playback.messageId);
    audio.onpause = () => updateVoicePlayer(playback.messageId);
    audio.onended = () => continueVoicePlayback(playback).catch(logBackgroundError('continueVoicePlayback'));
    if (paused) {
        updateVoicePlayer(playback.messageId);
        return;
    }
    audio.play().catch(error => {
        logDebug(`Wiedergabe fehlgeschlagen: ${error.message}`);
        showToast(t('voice.messageCannotBePlayed'), 'error');
        stopVoicePlayback();
    });
    updateVoicePlayer(playback.messageId);
}

// Ende des ersten Teils: weiter mit dem Rest, sonst warten, bis er ueber P2P da ist.
async function continueVoicePlayback(playback) {
    if (state.voicePlayback !== playback) return;
    const message = findChatMessage(playback.messageId);
    if (playback.part === 1 || !message || !hasVoiceRest(message)) {
        stopVoicePlayback();
        return;
    }
    const rest = isVoiceRestAvailable(message) ? await loadOriginal(message.id) : null;
    if (state.voicePlayback !== playback) return;
    if (isSafeAudioPart(rest)) {
        playVoicePart(playback, rest, 1);
        return;
    }
    releaseVoiceAudio(playback);
    playback.part = 0;
    playback.waiting = true;
    requestVoiceRest(message);
    updateVoicePlayer(playback.messageId);
}

function requestVoiceRest(message) {
    const peerId = message.peerId || state.activeChatPeerId;
    if (!peerId || message.senderId !== peerId) return;
    if (isSecureChannelOpen(peerId)) requestMissingOriginals(peerId).catch(logBackgroundError('requestVoiceRest'));
    else initiateP2PConnection(peerId).catch(logBackgroundError('requestVoiceRest'));
}

// Von originals.js: Rest ist angekommen. Wartet die Wiedergabe darauf, geht es direkt weiter.
function onVoiceRestReady(messageId) {
    const playback = state.voicePlayback;
    if (playback?.messageId === messageId && playback.waiting) {
        continueVoicePlayback(playback).catch(logBackgroundError('onVoiceRestReady'));
    }
}

function findChatMessage(messageId) {
    return Object.values(state.chats).flat().find(message => message.id === messageId) || null;
}

// Springen: innerhalb des ersten Teils direkt, in den Rest nur, wenn er schon da ist (sonst bis zur
// Grenze und den Rest anfragen). Laeuft nichts, startet die Wiedergabe an der Stelle.
async function seekVoicePlayback(message, seconds) {
    if (!isSafeInlineAudio(message.audioData)) return;
    const duration = message.audioDuration || 0;
    let target = Math.min(duration, Math.max(0, seconds));
    let playback = state.voicePlayback;
    const wasPaused = playback?.messageId === message.id && playback.audio?.paused && !playback.waiting;
    if (playback?.messageId !== message.id) {
        stopVoicePlayback();
        playback = { messageId: message.id, duration, splitAt: message.audioSplitAt || 0, part: 0, audio: null, url: null, waiting: false };
        state.voicePlayback = playback;
    }
    if (hasVoiceRest(message) && target >= playback.splitAt) {
        const rest = isVoiceRestAvailable(message) ? await loadOriginal(message.id) : null;
        if (state.voicePlayback !== playback) return;
        if (isSafeAudioPart(rest)) {
            if (playback.part === 1 && playback.audio) playback.audio.currentTime = target - playback.splitAt;
            else playVoicePart(playback, rest, 1, target - playback.splitAt, { paused: wasPaused });
            updateVoicePlayer(message.id);
            return;
        }
        requestVoiceRest(message);
        target = Math.max(0, playback.splitAt - 0.05);
    }
    if (playback.part === 0 && playback.audio && !playback.waiting) playback.audio.currentTime = target;
    else playVoicePart(playback, message.audioData, 0, target, { paused: wasPaused });
    updateVoicePlayer(message.id);
}

function toggleVoicePlayback(message) {
    const playback = state.voicePlayback;
    if (playback?.messageId === message.id) {
        if (playback.waiting) {
            stopVoicePlayback();
            return;
        }
        if (playback.audio.paused) playback.audio.play().catch(logBackgroundError('toggleVoicePlayback'));
        else playback.audio.pause();
        updateVoicePlayer(message.id);
        return;
    }
    stopVoicePlayback();
    if (!isSafeInlineAudio(message.audioData)) return;
    const next = { messageId: message.id, duration: message.audioDuration || 0, splitAt: message.audioSplitAt || 0, part: 0, audio: null, url: null, waiting: false };
    state.voicePlayback = next;
    playVoicePart(next, message.audioData, 0);
    // Rest schon mal holen, waehrend der Anfang laeuft.
    if (hasVoiceRest(message) && !isVoiceRestAvailable(message)) requestVoiceRest(message);
}
