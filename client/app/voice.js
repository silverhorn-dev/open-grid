// ================= SPRACHNACHRICHTEN =================
// Aufnahme per MediaRecorder (Opus, ca. 12 kbit/s), hoechstens VOICE_MAX_SECONDS. Die Aufnahme geht
// als Data-URL im verschluesselten MESSAGE_PUT mit (`audioData`, `audioDuration`), wie ein Bild:
// P2P oder Pfad C. So bleibt sie klein genug fuer eine DataChannel-Nachricht und den Router-Cache.
// Verschriftlichung nur, wenn der Browser sie lokal auf dem Geraet kann (SpeechRecognition mit
// `processLocally`); nie ueber einen Cloud-Dienst. Der Text geht als `transcript` mit.
const VOICE_MAX_SECONDS = 60;
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
async function startVoiceRecording() {
    const peerId = state.activeChatPeerId;
    if (state.voiceRecording || !peerId || isPeerBlocked(peerId)) return;
    // Sprachnachrichten zaehlen wie Bilder (Chat-Berechtigungen des anderen).
    const allowance = getPeerChatAllowance(peerId);
    if (allowance && (!allowance.allowed || !allowance.images)) {
        showToast(allowance.reason || 'Sprachnachrichten sind erst nach einem Match erlaubt.', 'info');
        return;
    }
    if (!isVoiceSupported()) {
        showToast('Aufnehmen wird von diesem Browser nicht unterstuetzt.', 'error');
        return;
    }
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
        logDebug(`Mikrofon nicht verfuegbar: ${error.message}`);
        showToast('Kein Zugriff auf das Mikrofon.', 'error');
        return;
    }
    const mimeType = VOICE_MIME_TYPES.find(type => MediaRecorder.isTypeSupported?.(type));
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: VOICE_BITRATE });
    const recording = { peerId, recorder, stream, chunks: [], startedAt: Date.now(), transcript: '', recognition: null };
    recorder.ondataavailable = event => {
        if (event.data?.size) recording.chunks.push(event.data);
    };
    recorder.start(1000);
    recording.timer = setInterval(() => {
        renderVoiceBar();
        if (voiceElapsedSeconds(recording) >= VOICE_MAX_SECONDS) sendVoiceRecording().catch(logBackgroundError('sendVoiceRecording'));
    }, 250);
    state.voiceRecording = recording;
    startLocalTranscript(recording).catch(logBackgroundError('startLocalTranscript'));
    hapticTick();
    renderVoiceBar();
}

function voiceElapsedSeconds(recording) {
    return (Date.now() - recording.startedAt) / 1000;
}

async function stopVoiceRecorder(recording) {
    clearInterval(recording.timer);
    if (recording.recorder.state !== 'inactive') {
        await new Promise(resolve => {
            recording.recorder.onstop = resolve;
            recording.recorder.stop();
        });
    }
    recording.stream.getTracks().forEach(track => track.stop());
    await finishLocalTranscript(recording);
}

async function cancelVoiceRecording() {
    const recording = state.voiceRecording;
    if (!recording) return;
    state.voiceRecording = null;
    renderVoiceBar();
    await stopVoiceRecorder(recording);
}

async function sendVoiceRecording() {
    const recording = state.voiceRecording;
    if (!recording) return;
    state.voiceRecording = null;
    renderVoiceBar();
    const duration = Math.min(VOICE_MAX_SECONDS, Math.round(voiceElapsedSeconds(recording)));
    await stopVoiceRecorder(recording);
    if (duration < 1 || !recording.chunks.length) {
        showToast('Zu kurz, nichts gesendet.', 'info');
        return;
    }
    const blob = new Blob(recording.chunks, { type: recording.recorder.mimeType || recording.chunks[0].type || 'audio/webm' });
    const dataUrl = await mediaBlobToDataUrl(blob);
    if (!isSafeInlineAudio(dataUrl)) {
        logDebug(`Sprachnachricht abgelehnt (${dataUrl.length} Zeichen, ${blob.type}).`);
        showToast('Sprachnachricht zu gross oder Format nicht unterstuetzt.', 'error');
        return;
    }
    if (state.activeChatPeerId !== recording.peerId) return;
    await sendChatMessage(null, '', null, null, {
        audio: { data: dataUrl, duration, transcript: recording.transcript.slice(0, TRANSCRIPT_MAX_LENGTH) || undefined }
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
    const elapsed = Math.min(VOICE_MAX_SECONDS, voiceElapsedSeconds(recording));
    document.getElementById('chat-voice-time').textContent = `${formatVoiceDuration(elapsed)} / ${formatVoiceDuration(VOICE_MAX_SECONDS)}`;
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
function renderVoiceMessage(bubble, message, isMine) {
    const player = document.createElement('div');
    player.className = 'flex items-center gap-2 min-w-[11rem] py-0.5';
    player.dataset.voice = message.id;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `voice-play w-9 h-9 shrink-0 rounded-full flex items-center justify-center ${isMine ? 'bg-white/20' : 'bg-slate-700'}`;
    button.setAttribute('aria-label', 'Sprachnachricht abspielen');
    button.innerHTML = '<i class="fa-solid fa-play"></i>';
    button.onclick = event => {
        event.stopPropagation();
        toggleVoicePlayback(message);
    };
    const track = document.createElement('div');
    track.className = `relative flex-1 h-1.5 rounded-full ${isMine ? 'bg-white/30' : 'bg-slate-600'}`;
    const fill = document.createElement('div');
    fill.className = `voice-fill absolute inset-y-0 left-0 rounded-full ${isMine ? 'bg-white' : 'bg-brand-400'}`;
    fill.style.width = '0%';
    track.appendChild(fill);
    const time = document.createElement('span');
    time.className = 'voice-time text-[11px] tabular-nums opacity-80';
    time.textContent = formatVoiceDuration(message.audioDuration);
    player.append(button, track, time);
    bubble.appendChild(player);
    if (message.transcript) {
        const transcript = document.createElement('div');
        transcript.className = 'text-xs opacity-80 mt-1 italic';
        transcript.textContent = message.transcript;
        bubble.appendChild(transcript);
    }
    if (state.voicePlayback?.messageId === message.id) updateVoicePlayer(message.id);
}

function updateVoicePlayer(messageId) {
    const player = document.querySelector(`[data-voice="${messageId}"]`);
    const playback = state.voicePlayback;
    if (!player) return;
    const playing = playback?.messageId === messageId && !playback.audio.paused;
    player.querySelector('.voice-play').innerHTML = `<i class="fa-solid ${playing ? 'fa-pause' : 'fa-play'}"></i>`;
    if (playback?.messageId !== messageId) return;
    const duration = Number.isFinite(playback.audio.duration) ? playback.audio.duration : playback.duration;
    const progress = duration ? Math.min(1, playback.audio.currentTime / duration) : 0;
    player.querySelector('.voice-fill').style.width = `${Math.round(progress * 100)}%`;
    player.querySelector('.voice-time').textContent = formatVoiceDuration(playing ? playback.audio.currentTime : duration);
}

function stopVoicePlayback() {
    const playback = state.voicePlayback;
    if (!playback) return;
    state.voicePlayback = null;
    playback.audio.pause();
    URL.revokeObjectURL(playback.url);
    const player = document.querySelector(`[data-voice="${playback.messageId}"]`);
    if (player) {
        player.querySelector('.voice-play').innerHTML = '<i class="fa-solid fa-play"></i>';
        player.querySelector('.voice-fill').style.width = '0%';
        player.querySelector('.voice-time').textContent = formatVoiceDuration(playback.duration);
    }
}

function toggleVoicePlayback(message) {
    const playback = state.voicePlayback;
    if (playback?.messageId === message.id) {
        if (playback.audio.paused) playback.audio.play().catch(logBackgroundError('toggleVoicePlayback'));
        else playback.audio.pause();
        updateVoicePlayer(message.id);
        return;
    }
    stopVoicePlayback();
    if (!isSafeInlineAudio(message.audioData)) return;
    const url = URL.createObjectURL(mediaDataUrlToBlob(message.audioData));
    const audio = new Audio(url);
    state.voicePlayback = { messageId: message.id, audio, url, duration: message.audioDuration || 0 };
    audio.ontimeupdate = () => updateVoicePlayer(message.id);
    audio.onpause = () => updateVoicePlayer(message.id);
    audio.onended = () => stopVoicePlayback();
    audio.play().catch(error => {
        logDebug(`Wiedergabe fehlgeschlagen: ${error.message}`);
        showToast('Sprachnachricht kann nicht abgespielt werden.', 'error');
        stopVoicePlayback();
    });
    updateVoicePlayer(message.id);
}
