// ================= SPRACHNACHRICHTEN VERSCHRIFTLICHEN (Board T38 C) =================
// Auf Antippen ("Text" an der Sprachnachricht): Audio dekodieren (16 kHz mono), im Worker (stt-worker.js) mit Whisper
// verschriftlichen, Ergebnis nur lokal an der Nachricht speichern (`localTranscript`, wird nicht gesendet). Modell erst
// beim ersten Mal vom eigenen Router laden. Eigene und fremde Sprachnachrichten; der zweite Teil (ueber P2P) zaehlt mit,
// wenn er schon da ist.
const STT_SAMPLE_RATE = 16000;
const STT_MAX_SECONDS = 15 * 60;
let sttWorker = null;
let sttRequests = 0;

function sttConfig() {
    const config = state.appConfig?.stt;
    return config?.model && config.model !== 'off' && config.library ? config : null;
}

function canTranscribe(message) {
    return Boolean(sttConfig()) && typeof message?.audioData === 'string' && !message.transcript && !message.localTranscript;
}

// Sprache als Hinweis: die der App (de/en); Whisper erkennt sonst selbst.
function sttLanguage() {
    return typeof currentLanguage === 'string' && ['de', 'en'].includes(currentLanguage) ? (currentLanguage === 'de' ? 'german' : 'english') : null;
}

async function decodeVoiceToMono16k(dataUrls) {
    const buffers = [];
    for (const dataUrl of dataUrls) {
        const bytes = await mediaDataUrlToBlob(dataUrl).arrayBuffer();
        const context = new OfflineAudioContext(1, 1, STT_SAMPLE_RATE);
        const decoded = await context.decodeAudioData(bytes);
        const length = Math.ceil(decoded.duration * STT_SAMPLE_RATE);
        const offline = new OfflineAudioContext(1, Math.max(1, length), STT_SAMPLE_RATE);
        const source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start();
        buffers.push((await offline.startRendering()).getChannelData(0));
    }
    const total = Math.min(buffers.reduce((sum, buffer) => sum + buffer.length, 0), STT_MAX_SECONDS * STT_SAMPLE_RATE);
    const audio = new Float32Array(total);
    let offset = 0;
    for (const buffer of buffers) {
        const take = Math.min(buffer.length, total - offset);
        audio.set(buffer.subarray(0, take), offset);
        offset += take;
    }
    return audio;
}

function runSttWorker(audio, onStatus) {
    const config = sttConfig();
    if (!sttWorker) sttWorker = new Worker(`/client/app/stt-worker.js?v=${encodeURIComponent(config.library)}`, { type: 'module' });
    const id = ++sttRequests;
    return new Promise((resolve, reject) => {
        const onMessage = event => {
            const data = event.data || {};
            if (data.id !== id) return;
            if (data.progress) return onStatus?.('loading', data.progress);
            if (data.working) return onStatus?.('working');
            sttWorker.removeEventListener('message', onMessage);
            if (data.error) reject(new Error(data.error));
            else resolve(data.text || '');
        };
        sttWorker.addEventListener('message', onMessage);
        sttWorker.postMessage({ id, config: { model: config.model, library: config.library, wasmPaths: config.wasmPaths, modelBase: config.modelBase }, audio, language: sttLanguage() }, [audio.buffer]);
    });
}

function applySttStatus(element, messageId) {
    const status = state.sttStatus?.[messageId];
    element.textContent = status === 'loading' ? t('stt.loadingModel', { size: sttConfig()?.sizeMb || '?' })
        : status === 'working' ? t('stt.working') : '';
    element.classList.toggle('hidden', !status);
}

function renderSttStatus(messageId) {
    document.querySelectorAll(`[data-stt-status="${CSS.escape(messageId)}"]`).forEach(element => applySttStatus(element, messageId));
}

async function transcribeVoiceMessage(peerId, messageId) {
    const message = state.chats[peerId]?.find(item => item.id === messageId);
    if (!message || !canTranscribe(message) || state.sttStatus?.[messageId]) return;
    state.sttStatus = { ...(state.sttStatus || {}), [messageId]: 'working' };
    renderSttStatus(messageId);
    try {
        const parts = [message.audioData];
        // Zweiter Teil (laengere Nachrichten, kommt per P2P): nur, wenn er schon da ist.
        const rest = message.audioSplitAt && typeof loadOriginal === 'function' ? await loadOriginal(message.id) : null;
        if (rest && typeof isSafeAudioPart === 'function' && isSafeAudioPart(rest)) parts.push(rest);
        const audio = await decodeVoiceToMono16k(parts);
        const text = await runSttWorker(audio, status => {
            state.sttStatus[messageId] = status;
            renderSttStatus(messageId);
        });
        message.localTranscript = text || t('stt.nothingRecognised');
        await persistChatMessage(peerId, message);
    } catch (error) {
        logDebug(`Transcription failed: ${error.message}`);
        showToast(t('stt.failed'), 'error');
    } finally {
        delete state.sttStatus[messageId];
        renderSttStatus(messageId);
        if (state.activeChatPeerId === peerId) renderChatHistory();
    }
}

// Knopf + Status an der Sprachnachricht (voice.js renderVoiceMessage).
function renderTranscribeControl(bubble, message) {
    if (!canTranscribe(message)) return;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 mt-1';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'stt-button text-[11px] font-semibold opacity-80 hover:opacity-100 flex items-center gap-1';
    button.dataset.sttButton = message.id;
    button.innerHTML = '<i class="fa-solid fa-closed-captioning"></i>';
    button.append(document.createTextNode(` ${t('stt.transcribe')}`));
    const peerId = state.activeChatPeerId;
    button.onclick = event => {
        event.stopPropagation();
        transcribeVoiceMessage(peerId, message.id).catch(logBackgroundError('transcribeVoiceMessage'));
    };
    const status = document.createElement('span');
    status.className = 'hidden text-[11px] opacity-75';
    status.dataset.sttStatus = message.id;
    row.append(button, status);
    bubble.appendChild(row);
    // Direkt am neuen Element (haengt beim Neuzeichnen noch nicht im Dokument).
    applySttStatus(status, message.id);
}
