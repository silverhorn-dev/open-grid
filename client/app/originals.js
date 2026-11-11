// ================= ORIGINALBILDER (nur P2P/TURN, Schwarm) =================
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

// ----- Schwarm (Board T36, P3) -----
// Ein Original darf jeder liefern, der es hat und die Nachricht sehen darf: der Absender (jedes seiner Geraete),
// meine anderen Geraete und in Gruppen jedes Mitglied (ab seinem Beitritt). Gefragt wird nur ueber offene Kanaele;
// wer es nicht hat, antwortet ORIGINAL_MISSING, dann kommt die naechste Quelle dran. Geprueft wird immer gegen
// Groesse und SHA-256 aus der (in Gruppen signierten) Nachricht, egal wer liefert.
const identityOfNode = nodeId => (typeof identityOf === 'function' ? identityOf(nodeId) : nodeId);
const isOtherOwnNode = nodeId => typeof isOtherOwnDevice === 'function' && isOtherOwnDevice(nodeId);
const isGroupConversation = id => typeof isGroupId === 'function' && isGroupId(id);

function wantsOriginal(conversationId, message) {
    return Boolean(message?.original) && !message.originalReady && !message.deleted && message.senderId !== state.myProfile?.id;
}

function hasOriginal(message) {
    return Boolean(message?.original) && !message.deleted && (message.originalReady || message.senderId === state.myProfile?.id);
}

// Darf diese Node das Original einer Nachricht aus dieser Unterhaltung bekommen?
function mayReceiveOriginal(nodeId, conversationId, message) {
    if (isOtherOwnNode(nodeId)) return true;
    if (isGroupConversation(conversationId)) {
        const group = typeof getGroup === 'function' ? getGroup(conversationId) : null;
        if (!group || !isGroupActive(conversationId) || !group.members.includes(memberIdOf(nodeId))) return false;
        return (message.createdAt || 0) >= groupSyncCutoff(group, nodeId);
    }
    return identityOfNode(nodeId) === conversationId;
}

// Kommt diese Node als Quelle fuer die Nachricht in Frage?
function isOriginalSource(nodeId, conversationId, message) {
    if (!nodeId || nodeId === state.myProfile?.id) return false;
    if (isOtherOwnNode(nodeId)) return true;
    if (identityOfNode(nodeId) === identityOfNode(message.senderId)) return true;
    return isGroupConversation(conversationId) && mayReceiveOriginal(nodeId, conversationId, message);
}

// Unterhaltungen, aus denen diese Node Originale liefern koennte.
function conversationsServedBy(nodeId) {
    if (isOtherOwnNode(nodeId)) return [...new Set(state.chatPeerIds || [])];
    const groups = typeof sharedActiveGroups === 'function' ? sharedActiveGroups(nodeId) : [];
    return [identityOfNode(nodeId), ...groups];
}

function originalRequestPayload(nodeId, conversationId, messageId) {
    // 1:1 mit dem Kontakt selbst: die Unterhaltung ergibt sich aus der Node (wie bisher, ohne Feld).
    return conversationId === identityOfNode(nodeId) && !isOtherOwnNode(nodeId)
        ? { type: 'ORIGINAL_REQUEST', messageId }
        : { type: 'ORIGINAL_REQUEST', messageId, conversationId };
}

// Fehlende Originale anfragen. id = verbundene Node (sie ist Quelle) oder Unterhaltung (alle offenen Quellen).
async function requestMissingOriginals(id, { asSource = false } = {}) {
    if (!id) return;
    if (!asSource) {
        // Als Unterhaltung: alle anderen offenen Quellen (Absender-Geraete, eigene Geraete, Gruppen-Mitglieder).
        const messages = await getDatabaseRecordsByIndex('messages', 'peerId', id).catch(() => []);
        const sources = Object.keys(state.dataChannels || {}).filter(node => node !== id && isSecureChannelOpen(node))
            .filter(node => messages.some(message => wantsOriginal(id, message) && isOriginalSource(node, id, message)));
        for (const node of sources) await requestMissingOriginals(node, { asSource: true });
    }
    if (!isSecureChannelOpen(id)) return;
    const channel = state.dataChannels[id];
    for (const conversationId of conversationsServedBy(id)) {
        const messages = await getDatabaseRecordsByIndex('messages', 'peerId', conversationId).catch(() => []);
        for (const message of messages.filter(entry => wantsOriginal(conversationId, entry) && isOriginalSource(id, conversationId, entry))) {
            // Laufende Uebertragung nicht doppelt anstossen; haengt sie, nach einer Minute neu. Diese Quelle hat es
            // nicht: nicht nochmal fragen (bis zum naechsten Kanal).
            const running = state.originalTransfers[message.id];
            if (running && running.channel === channel && Date.now() - running.startedAt < 60000) continue;
            if (running?.missing?.includes(id) && running.channel === channel) continue;
            state.originalTransfers[message.id] = {
                peerId: id, conversationId, channel, chunks: [], received: 0, total: 0, startedAt: Date.now(),
                missing: running && running.channel === channel ? running.missing || [] : []
            };
            await sendSecurePayload(id, originalRequestPayload(id, conversationId, message.id));
        }
    }
}

// Quelle hat es nicht: naechste offene Quelle fragen.
async function handleOriginalMissing(peerId, payload) {
    const transfer = state.originalTransfers[payload.messageId];
    if (!transfer || transfer.peerId !== peerId) return;
    transfer.missing = [...new Set([...(transfer.missing || []), peerId])];
    transfer.startedAt = 0;
    const messages = await getDatabaseRecordsByIndex('messages', 'peerId', transfer.conversationId).catch(() => []);
    const message = messages.find(entry => entry.id === payload.messageId);
    if (!message) return;
    const next = Object.keys(state.dataChannels || {}).find(node => isSecureChannelOpen(node) && !transfer.missing.includes(node)
        && isOriginalSource(node, transfer.conversationId, message));
    if (!next) return;
    state.originalTransfers[message.id] = { ...transfer, peerId: next, channel: state.dataChannels[next], chunks: [], received: 0, total: 0, startedAt: Date.now() };
    await sendSecurePayload(next, originalRequestPayload(next, transfer.conversationId, message.id));
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
    await finishOriginal(transfer.conversationId || peerId, payload.messageId, transfer.chunks.join(''));
}

async function finishOriginal(conversationId, messageId, dataUrl) {
    const message = (state.chats[conversationId] || []).find(entry => entry.id === messageId)
        || await databaseRequest('messages', 'readonly', store => store.get(messageId)).catch(() => null);
    if (!message || !wantsOriginal(conversationId, message)) return;
    const safe = message.video ? isSafeInlineVideo(dataUrl)
        : message.audioData ? isSafeAudioPart(dataUrl)
            : isSafeInlineImage(dataUrl);
    if (!safe || dataUrl.length !== message.original.size || await sha256Base64(dataUrl) !== message.original.sha256) {
        logDebug(`Original ${messageId} in ${conversationId} passt nicht zur Vorschau, verworfen.`);
        return;
    }
    await cacheMedia(originalMediaId(messageId), dataUrl, 1);
    message.originalReady = true;
    await persistChatMessage(conversationId, message);
    if (state.activeChatPeerId === conversationId) renderChatHistory();
    // Wartet die Wiedergabe einer Sprachnachricht auf den Rest, geht es jetzt weiter.
    if (message.audioData) onVoiceRestReady(messageId);
    // Kern der App: die Oberflaeche wartet ggf. auf den Rest (core-link.js).
    if (message.audioData && typeof notifyCoreOriginalReady === 'function') notifyCoreOriginalReady(messageId);
}

function renderOriginalProgress(messageId) {
    const badge = document.querySelector(`[data-original-badge="${messageId}"]`);
    const transfer = state.originalTransfers[messageId];
    if (!badge || !transfer?.total) return;
    badge.textContent = t('snaps.original', { value: Math.floor((transfer.received / transfer.total) * 100) });
}

// ----- Liefern (Absender oder jeder, der es hat) -----
async function handleOriginalRequest(peerId, payload) {
    const conversationId = payload.conversationId || identityOfNode(peerId);
    // Nur Nachrichten aus genau dieser Unterhaltung (im Speicher ohne peerId, gespeichert mit).
    const loaded = (state.chats[conversationId] || []).find(entry => entry.id === payload.messageId);
    const message = loaded || await databaseRequest('messages', 'readonly', store => store.get(payload.messageId)).catch(() => null);
    if (!message || (!loaded && message.peerId !== conversationId) || !message.original || message.deleted) return;
    if (!mayReceiveOriginal(peerId, conversationId, message)) return;
    const dataUrl = hasOriginal(message) ? await loadOriginal(message.id) : null;
    if (!dataUrl) {
        await sendSecurePayload(peerId, { type: 'ORIGINAL_MISSING', messageId: message.id }).catch(() => {});
        return;
    }
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
    if (message.original && (message.originalReady || (typeof isOwnNode === 'function' ? isOwnNode(message.senderId) : message.senderId === state.myProfile.id))) {
        const original = await loadOriginal(message.id);
        if (original) return original;
    }
    return message.snapData;
}
