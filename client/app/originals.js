// ================= ORIGINALBILDER (nur P2P/TURN) =================
// "Als Bild senden" mit "Original": die Nachricht traegt wie immer eine kleine Vorschau (passt in den
// Router-Cache), dazu `original: { size, sha256, mime }`. Das Originalbild selbst geht ausschliesslich
// ueber den verschluesselten DataChannel (P2P oder TURN), nie ueber den Cache: der Empfaenger fragt es
// mit ORIGINAL_REQUEST an, der Absender schickt es in ORIGINAL_CHUNK-Stuecken (mit Gegendruck auf den
// DataChannel). Der Empfaenger prueft den SHA-256 und speichert es verschluesselt (media/orig_<id>).
// Neu kodiert per Canvas (JPEG 0.95, max. ORIGINAL_MAX_EDGE): keine EXIF-/Standortdaten.
const ORIGINAL_MAX_EDGE = 4096;
const ORIGINAL_MAX_LENGTH = 15 * 1024 * 1024;
// Videos (video.js) nutzen denselben Weg; als Data-URL bis 25 MB Datei.
const ORIGINAL_VIDEO_MAX_LENGTH = 36 * 1024 * 1024;
const ORIGINAL_CHUNK_LENGTH = 64 * 1024;
const ORIGINAL_MAX_CHUNKS = Math.ceil(ORIGINAL_VIDEO_MAX_LENGTH / ORIGINAL_CHUNK_LENGTH);
const ORIGINAL_BUFFER_LIMIT = 1024 * 1024;
const ORIGINAL_QUALITY = 0.95;

function originalMediaId(messageId) {
    return `orig_${messageId}`;
}

// Absender: Original aus dem bearbeiteten Bild, mit Wasserzeichen des Empfaengers (wenn eingeschaltet).
async function createOriginalImage(canvas, peerId) {
    let dataUrl = canvas.toDataURL('image/jpeg', ORIGINAL_QUALITY);
    if (isTraceWatermarkEnabled() && typeof embedWatermark === 'function') {
        dataUrl = await embedWatermark(dataUrl, peerId, ORIGINAL_QUALITY);
    }
    if (dataUrl.length > ORIGINAL_MAX_LENGTH) return null;
    return { dataUrl, meta: { size: dataUrl.length, sha256: await sha256Base64(dataUrl), mime: 'image/jpeg' } };
}

// Nach dem Senden: Original lokal halten, damit der Absender es ausliefern kann.
async function storeOwnOriginal(messageId, dataUrl) {
    await cacheMedia(originalMediaId(messageId), dataUrl, 1);
}

async function loadOriginal(messageId) {
    const media = await loadMedia(originalMediaId(messageId)).catch(() => null);
    return isSafeInlineImage(media?.data) || isSafeInlineVideo(media?.data) || isSafeAudioPart(media?.data) ? media.data : null;
}

// ----- Empfaenger -----
function wantsOriginal(peerId, message) {
    return Boolean(message?.original) && message.senderId === peerId && !message.originalReady && !message.deleted;
}

// Fragt fehlende Originale eines Chats an, wenn ein direkter Kanal besteht (nie ueber Pfad C).
async function requestMissingOriginals(peerId) {
    if (!isSecureChannelOpen(peerId)) return;
    const messages = await getDatabaseRecordsByIndex('messages', 'peerId', peerId).catch(() => []);
    for (const message of messages.filter(entry => wantsOriginal(peerId, entry))) {
        // Laufende Uebertragung nicht doppelt anstossen; haengt sie, nach einer Minute neu. Auf einem
        // neuen Kanal (Verbindung neu aufgebaut) sofort neu: die alte Anfrage ging mit dem Kanal verloren.
        const channel = state.dataChannels[peerId];
        const running = state.originalTransfers[message.id];
        if (running && running.channel === channel && Date.now() - running.startedAt < 60000) continue;
        state.originalTransfers[message.id] = { peerId, channel, chunks: [], received: 0, total: 0, startedAt: Date.now() };
        await sendSecurePayload(peerId, { type: 'ORIGINAL_REQUEST', messageId: message.id });
    }
}

async function handleOriginalChunk(peerId, payload) {
    const transfer = state.originalTransfers[payload.messageId];
    if (!transfer || transfer.peerId !== peerId) return;
    if (!Number.isInteger(payload.total) || payload.total < 1 || payload.total > ORIGINAL_MAX_CHUNKS
        || !Number.isInteger(payload.index) || payload.index < 0 || payload.index >= payload.total) return;
    if (transfer.total && transfer.total !== payload.total) return;
    transfer.total = payload.total;
    if (transfer.chunks[payload.index] === undefined) transfer.received += 1;
    transfer.chunks[payload.index] = payload.data;
    renderOriginalProgress(payload.messageId);
    if (transfer.received < transfer.total) return;
    delete state.originalTransfers[payload.messageId];
    await finishOriginal(peerId, payload.messageId, transfer.chunks.join(''));
}

async function finishOriginal(peerId, messageId, dataUrl) {
    const message = (state.chats[peerId] || []).find(entry => entry.id === messageId)
        || await databaseRequest('messages', 'readonly', store => store.get(messageId)).catch(() => null);
    if (!message || !wantsOriginal(peerId, message)) return;
    const safe = message.video ? isSafeInlineVideo(dataUrl)
        : message.audioData ? isSafeAudioPart(dataUrl)
            : isSafeInlineImage(dataUrl);
    if (!safe || dataUrl.length !== message.original.size || await sha256Base64(dataUrl) !== message.original.sha256) {
        logDebug(`Original ${messageId} von ${peerId} passt nicht zur Vorschau, verworfen.`);
        return;
    }
    await cacheMedia(originalMediaId(messageId), dataUrl, 1);
    message.originalReady = true;
    await persistChatMessage(peerId, message);
    if (state.activeChatPeerId === peerId) renderChatHistory();
    // Wartet die Wiedergabe einer Sprachnachricht auf den Rest, geht es jetzt weiter.
    if (message.audioData) onVoiceRestReady(messageId);
}

function renderOriginalProgress(messageId) {
    const badge = document.querySelector(`[data-original-badge="${messageId}"]`);
    const transfer = state.originalTransfers[messageId];
    if (!badge || !transfer?.total) return;
    badge.textContent = t('snaps.original', { value: Math.floor((transfer.received / transfer.total) * 100) });
}

// ----- Absender -----
async function handleOriginalRequest(peerId, payload) {
    // Nur Nachrichten aus dem Chat mit genau diesem Peer (im Speicher ohne peerId, gespeichert mit).
    const loaded = (state.chats[peerId] || []).find(entry => entry.id === payload.messageId);
    const message = loaded || await databaseRequest('messages', 'readonly', store => store.get(payload.messageId)).catch(() => null);
    if (!message || (!loaded && message.peerId !== peerId) || message.senderId !== state.myProfile.id || !message.original || message.deleted) return;
    const dataUrl = await loadOriginal(message.id);
    if (!dataUrl) return;
    const total = Math.ceil(dataUrl.length / ORIGINAL_CHUNK_LENGTH);
    for (let index = 0; index < total; index++) {
        const channel = state.dataChannels[peerId];
        // Nur ueber einen offenen Kanal; bricht er ab, fragt der Empfaenger spaeter erneut an.
        if (channel?.readyState !== 'open') return;
        while (channel.bufferedAmount > ORIGINAL_BUFFER_LIMIT) {
            await new Promise(resolve => setTimeout(resolve, 20));
            if (channel.readyState !== 'open') return;
        }
        await sendSecurePayload(peerId, {
            type: 'ORIGINAL_CHUNK',
            messageId: message.id,
            index,
            total,
            data: dataUrl.slice(index * ORIGINAL_CHUNK_LENGTH, (index + 1) * ORIGINAL_CHUNK_LENGTH)
        });
    }
}

// Bildbetrachter: Original statt Vorschau, wenn vorhanden.
async function bestImageFor(message) {
    // Bei Videos ist das "Original" das Video selbst, im Bildbetrachter bleibt die Vorschau.
    if (message.video) return message.snapData;
    if (message.original && (message.originalReady || message.senderId === state.myProfile.id)) {
        const original = await loadOriginal(message.id);
        if (original) return original;
    }
    return message.snapData;
}
