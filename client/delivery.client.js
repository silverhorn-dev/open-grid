// Zustellung: Chat-Sync, Sende-Queue mit Pfad-C-Fallback und Abruf des Zwischenspeichers.
// Ausgelagert aus p2p.client.js (klassisches Skript, globale Funktionen).
async function beginChatSync(peerId) {
    if (state.chatSyncInProgress[peerId]) return;
    state.chatSyncInProgress[peerId] = true;
    try {
        // Geraet eines Kontakts mit mehreren Geraeten: der Chat liegt unter dessen Identitaet (P4c).
        const conversation = typeof identityOf === 'function' && !isOwnNode(peerId) ? identityOf(peerId) : peerId;
        const operations = await getChatOperations(conversation);
        if (typeof sendDeviceListToContact === 'function') sendDeviceListToContact(peerId);
        await sendSecurePayload(peerId, {
            type: 'CHAT_SYNC_HELLO',
            recentOperationIds: operations.slice(0, 20).map(operation => operation.operationId),
            hasMore: operations.length > 20
        });
        // Gemeinsame Gruppen (T36 P2b): je Gruppe derselbe Abgleich mit diesem Mitglied.
        // Eigenes anderes Geraet (T36 P4b): alle Chats abgleichen.
        const groups = typeof isOtherOwnDevice === 'function' && isOtherOwnDevice(peerId)
            ? (state.chatPeerIds || []).filter(id => !isOwnNode(id))
            : typeof sharedActiveGroups === 'function' ? sharedActiveGroups(peerId) : [];
        for (const groupId of groups) {
            const groupOperations = await syncOperationsFor(peerId, groupId);
            await sendSecurePayload(peerId, {
                type: 'CHAT_SYNC_HELLO',
                conversationId: groupId,
                recentOperationIds: groupOperations.slice(0, 20).map(operation => operation.operationId),
                hasMore: groupOperations.length > 20
            });
        }
    } finally {
        delete state.chatSyncInProgress[peerId];
    }
}

// Unterhaltung eines Sync-Pakets: 1:1 = Absender, Gruppe nur, wenn bekannt und beide Mitglied; sonst null.
function syncConversation(peerId, payload) {
    if (payload?.conversationId === undefined || payload?.conversationId === null) {
        return typeof identityOf === 'function' && !(typeof isOtherOwnDevice === 'function' && isOtherOwnDevice(peerId)) ? identityOf(peerId) : peerId;
    }
    // Eigenes Geraet: jeder Chat (T36 P4b).
    if (typeof isOtherOwnDevice === 'function' && isOtherOwnDevice(peerId)) return typeof payload.conversationId === 'string' ? payload.conversationId : null;
    if (typeof resolveIncomingConversation !== 'function') return null;
    return resolveIncomingConversation(peerId, payload.conversationId, { groups: state.groups || {}, myId: selfMemberId(), memberOf: memberIdOf });
}

// Operationen, die dieses Gegenueber im Sync bekommen darf: in Gruppen erst ab seinem `since`.
async function syncOperationsFor(peerId, conversationId) {
    const operations = await getChatOperations(conversationId);
    if (conversationId === peerId || typeof getGroup !== 'function') return operations;
    if (typeof identityOf === 'function' && conversationId === identityOf(peerId)) return operations;
    if (typeof isOtherOwnDevice === 'function' && isOtherOwnDevice(peerId)) return operations;
    const cutoff = groupSyncCutoff(getGroup(conversationId), peerId);
    return operations.filter(operation => (operation.createdAt || 0) >= cutoff);
}

const withConversation = (conversationId, peerId, payload) => (conversationId === peerId || (typeof identityOf === 'function' && conversationId === identityOf(peerId) && !isOwnNode(peerId)) ? payload : { ...payload, conversationId });

async function handleChatSyncHello(peerId, payload) {
    const conversationId = syncConversation(peerId, payload);
    if (!conversationId) return;
    // Eigene Geraete bestaetigen keine Zustellung an den Kontakt.
    if (!(typeof isOtherOwnDevice === 'function' && isOtherOwnDevice(peerId))) await confirmDeliveredOperations(conversationId, payload.recentOperationIds || []);
    const operations = await getChatOperations(conversationId);
    const localIds = new Set(operations.map(operation => operation.operationId));
    const missingIds = (payload.recentOperationIds || []).filter(operationId => !localIds.has(operationId));
    if (missingIds.length) {
        await sendSecurePayload(peerId, withConversation(conversationId, peerId, {
            type: 'CHAT_SYNC_OPERATION_REQUEST',
            operationIds: missingIds
        }));
    }
    if (payload.hasMore) {
        await sendSecurePayload(peerId, withConversation(conversationId, peerId, {
            type: 'CHAT_SYNC_INVENTORY_REQUEST',
            cursor: 20
        }));
    }
}

async function sendChatSyncInventory(peerId, cursor, payload = {}) {
    const conversationId = syncConversation(peerId, payload);
    if (!conversationId) return;
    const operations = await syncOperationsFor(peerId, conversationId);
    const pageSize = 50;
    await sendSecurePayload(peerId, withConversation(conversationId, peerId, {
        type: 'CHAT_SYNC_INVENTORY',
        operationIds: operations
            .slice(cursor, cursor + pageSize)
            .map(operation => operation.operationId),
        nextCursor: cursor + pageSize < operations.length ? cursor + pageSize : null
    }));
}

async function handleChatSyncInventory(peerId, payload) {
    const conversationId = syncConversation(peerId, payload);
    if (!conversationId) return;
    if (!(typeof isOtherOwnDevice === 'function' && isOtherOwnDevice(peerId))) await confirmDeliveredOperations(conversationId, payload.operationIds || []);
    const localIds = new Set(
        (await getChatOperations(conversationId)).map(operation => operation.operationId)
    );
    const missingIds = (payload.operationIds || []).filter(operationId => !localIds.has(operationId));
    if (missingIds.length) {
        await sendSecurePayload(peerId, withConversation(conversationId, peerId, {
            type: 'CHAT_SYNC_OPERATION_REQUEST',
            operationIds: missingIds
        }));
    }
    if (payload.nextCursor !== null && payload.nextCursor !== undefined) {
        await sendSecurePayload(peerId, withConversation(conversationId, peerId, {
            type: 'CHAT_SYNC_INVENTORY_REQUEST',
            cursor: payload.nextCursor
        }));
    }
}

// Ein DataChannel nimmt je Nachricht nur begrenzt viel (Chrome ~256 KB, verschluesselt + Base64 kommt
// ein Drittel dazu). Bilder (~70 KB) und Sprachnachrichten (bis 160 KB) passen einzeln, 50 auf einmal nicht:
// darum in Pakete bis SYNC_BATCH_BYTES (Klartext-JSON) aufteilen; zu Grosses geht allein.
const SYNC_BATCH_BYTES = 96 * 1024;

function batchSyncOperations(operations, limit = SYNC_BATCH_BYTES) {
    const batches = [];
    let current = [];
    let size = 0;
    for (const operation of operations) {
        const bytes = JSON.stringify(operation).length;
        if (current.length && size + bytes > limit) {
            batches.push(current);
            current = [];
            size = 0;
        }
        current.push(operation);
        size += bytes;
    }
    if (current.length) batches.push(current);
    return batches;
}

// Eigene Operation signieren (falls noch nicht); fremde bleiben, wie sie sind.
async function signOwnOperation(operation) {
    if (!operation || operation.sig || operation.actorId !== state.myProfile?.id || !state.myKeys?.ecdsaKeyPair?.privateKey
        || typeof signOperation !== 'function') return operation;
    const { peerId: _localPeerId, ...shared } = operation;
    try {
        return { ...shared, sig: await signOperation(shared, state.myKeys.ecdsaKeyPair.privateKey) };
    } catch (error) {
        logDebug(`Could not sign operation: ${error.message}`);
        return operation;
    }
}

// Signatur pruefen, wenn vorhanden und der Schluessel des Urhebers gepinnt ist. Ohne Signatur (alte Clients)
// oder ohne gepinnten Schluessel gilt vorerst der Kanal als Beleg (Uebergang, T36 P0).
async function operationSignatureAcceptable(operation) {
    if (!operation?.sig) return true;
    const key = (await getPeerIdentity(operation.actorId).catch(() => null))?.profileSigningKey;
    if (!key) return true;
    return verifyOperationSignature(operation, key);
}

async function sendRequestedChatOperations(peerId, operationIds, payload = {}) {
    const conversationId = syncConversation(peerId, payload);
    if (!conversationId) return;
    const group = conversationId !== peerId;
    const requestedIds = new Set(operationIds.slice(0, 50));
    const operations = await Promise.all((await syncOperationsFor(peerId, conversationId))
        .filter(operation => requestedIds.has(operation.operationId))
        // In Gruppen gehoert die Gruppe in die (signierte) Operation; fremde gehen unveraendert weiter.
        .map(({peerId: _localPeerId, ...operation}) => signOwnOperation(group && operation.actorId === state.myProfile.id && !operation.conversationId
            ? { ...operation, conversationId, sig: undefined } : operation)));
    for (const batch of batchSyncOperations(operations)) {
        await sendSecurePayload(peerId, withConversation(conversationId, peerId, {
            type: 'CHAT_SYNC_OPERATIONS',
            operations: batch
        }));
    }
}

// Pfad C haelt nur 24 h. Sind beide nie gleichzeitig online (Handy schlaeft), kaeme eine abgelaufene,
// unbestaetigte Nachricht erst beim naechsten direkten Chat-Sync an. Darum: eigene Nachrichten, deren
// Zwischenspeicher-Kopie abgelaufen ist und die noch nicht bestaetigt sind, erneut zustellen (P2P oder Pfad C).
const RESEND_EXPIRED_LIMIT = 20;

function expiredUnconfirmedMessages(messages, myId, now = Date.now()) {
    return messages
        .filter(message => message.senderId === myId && !message.deleted && !message.deliveryConfirmed
            && Number.isFinite(message.cacheExpiresAt) && message.cacheExpiresAt < now)
        .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0))
        .slice(0, RESEND_EXPIRED_LIMIT);
}

async function resendExpiredCacheMessages() {
    if (state.movedAway || !state.myProfile?.id) return 0;
    let sent = 0;
    for (const peerId of state.chatPeerIds || []) {
        if (isPeerBlocked(peerId)) continue;
        const messages = await getDatabaseRecordsByIndex('messages', 'peerId', peerId).catch(() => []);
        const due = expiredUnconfirmedMessages(messages, state.myProfile.id);
        if (!due.length) continue;
        const operations = await getChatOperations(peerId);
        for (const message of due) {
            const operation = operations.find(entry => entry.operationId === `put:${message.id}`);
            if (!operation) continue;
            const { peerId: _localPeerId, ...shared } = operation;
            // Bis zur neuen Zustellung kein zweites Mal anstossen.
            await persistChatMessage(peerId, { ...message, cacheExpiresAt: undefined });
            await sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation: shared }, (path, details = {}) => {
                if (path !== 'cache' || !details.expiresAt) return;
                persistChatMessage(peerId, { ...message, cacheExpiresAt: details.expiresAt }).catch(logBackgroundError('resendExpiredCacheMessages'));
            });
            sent += 1;
        }
    }
    if (sent) logDebug(`Re-sent ${sent} expired, unconfirmed message(s).`);
    return sent;
}

// options.notifyKind: Art fuer den Push beim Empfaenger, falls es ueber Pfad C geht (push.js).
async function sendSecurePayload(peerId, payload, onSent = null, options = {}) {
    // Eigene Chat-Aktion: auch an meine anderen Geraete (devices.js, T36 P4b).
    // (Nicht fuer die Einzelsendungen eines Gruppen-Fan-outs: die Gruppe selbst wurde schon gespiegelt.)
    if (payload?.type === 'CHAT_OPERATION' && !payload.mirrorOf && !payload.conversationId && payload.operation?.actorId === state.myProfile?.id
        && typeof mirrorToOwnDevices === 'function' && !isOwnNode(peerId)) mirrorToOwnDevices(peerId, payload.operation);
    // Gruppe (conversations.js, T36 P1): an alle Mitglieder verteilen.
    if (typeof isGroupId === 'function' && isGroupId(peerId)) return sendGroupPayload(peerId, payload, onSent, options);
    // Person mit mehreren Geraeten (devices.js, T36 P4c): an alle ihre Geraete.
    if (payload?.type === 'CHAT_OPERATION' && !payload.deviceFanout && !payload.mirrorOf && typeof contactDeviceNodes === 'function'
        && contactDeviceNodes(peerId).length > 1) return sendToContactDevices(peerId, payload, onSent, options);
    if (isPeerBlocked(peerId)) return false;
    // Chat-Operationen (auch Loeschen, Bearbeiten, Reaktionen) immer mit ACK-Pruefung und Pfad-C-Fallback:
    // ohne Rueckruf blieben sie bei einem halbtoten Kanal bis zum naechsten Chat-Sync haengen.
    if (!onSent && payload?.type === 'CHAT_OPERATION') onSent = () => {};
    // Umgezogene alte Kopie (move.js): nur noch lesen.
    if (state.movedAway) return false;
    // Eigene Chat-Operationen signiert verschicken (T36 P0); gespeichert bleibt die unsignierte Fassung.
    if (payload?.type === 'CHAT_OPERATION') payload = { ...payload, operation: await signOwnOperation(payload.operation) };
    const channel = state.dataChannels[peerId];

    // Wenn der P2P/TURN-Kanal offen und sicher ist -> Direkt senden
    if (channel?.readyState === 'open' && state.sessionKeys[peerId]) {
        try {
            const encoded = JSON.stringify(await encryptSecurePayload(peerId, payload));
            // Groesser als der Kanal erlaubt: send() wuerde werfen; Chat-Operationen gehen dann ueber Pfad C.
            const limit = state.webrtcConnections?.[peerId]?.sctp?.maxMessageSize;
            if (Number.isFinite(limit) && limit > 0 && encoded.length > limit) throw new Error(`payload ${encoded.length} B exceeds channel limit ${limit} B`);
            channel.send(encoded);
            if (onSent) {
                onSent('p2p');
                awaitP2PAck(peerId, channel, { payload, onSent, cacheQueued: false });
            }
            return true;
        } catch (error) {
            logDebug(`P2P send failed: ${error.message}`);
        }
    }

    // Andernfalls: In die lokale Warteschlange einreihen und Verbindung aufbauen/abwarten
    if (!state.secureMessageQueues[peerId]) {
        state.secureMessageQueues[peerId] = [];
    }

    const item = {payload, onSent, cacheQueued: false, notifyKind: options.notifyKind};
    state.secureMessageQueues[peerId].push(item);
    logDebug(`P2P/TURN-Kanal fuer ${peerId} noch nicht bereit. Nachricht in Queue eingereiht, starte Verbindung...`);
    if (onSent) scheduleQueueFallback(peerId, item);

    initiateP2PConnection(peerId).catch(error => {
        logDebug(`Could not initiate P2P connection: ${error.message}`);
    });

    return false;
}

// Steht der Kanal nach SECURE_QUEUE_FALLBACK_MS noch nicht, geht die Operation ueber Path C.
// Klappt auch das nicht, bleibt sie im Operations-Log und wird beim naechsten Chat-Sync zugestellt.
const SECURE_QUEUE_FALLBACK_MS = 10000;

function scheduleQueueFallback(peerId, item) {
    setTimeout(async function fallback() {
        if (!state.secureMessageQueues[peerId]?.includes(item) || item.cacheQueued || item.discarded) return;
        // Wird gerade geweckt (R1): noch warten, der direkte Kanal kommt gleich.
        if (typeof isPeerWaking === 'function' && isPeerWaking(peerId)) {
            setTimeout(fallback, 2000);
            return;
        }
        let queued = false;
        try {
            queued = await queuePayloadInCache(peerId, item);
        } catch (error) {
            logDebug(`Path C fallback for ${peerId} failed: ${error.message}`);
        }
        if (!queued && !item.discarded) item.onSent('pending');
    }, SECURE_QUEUE_FALLBACK_MS);
}

// Ein offener DataChannel kann halb tot sein: der Partner hat gerade das Netz verloren, ICE merkt es
// erst nach bis zu 30 s. send() klappt dann, kommt aber nie an. Chat-Operationen mit onSent warten
// deshalb auf CHAT_OPERATION_ACK. Fehlt sie nach P2P_ACK_TIMEOUT_MS (und der Kanal sendet nicht mehr
// an einem grossen Paket), gilt der Kanal als tot: neu aufbauen, Operation ueber Pfad C. Kommt sie
// doch doppelt an, ignoriert der Empfaenger sie anhand der operationId.
const P2P_ACK_TIMEOUT_MS = 5000;
const P2P_ACK_MAX_WAIT_MS = 60000;

function awaitP2PAck(peerId, channel, item) {
    const operationId = item.payload?.type === 'CHAT_OPERATION' ? item.payload.operation?.operationId : null;
    if (!operationId) return;
    clearTimeout(state.pendingP2PAcks[operationId]?.timer);
    const pending = { peerId, channel, item, sentAt: Date.now(), timer: null };
    const check = () => {
        // Grosse Nachrichten (Bilder) sind evtl. noch unterwegs: weiter warten, solange gepuffert wird.
        if (channel.readyState === 'open' && channel.bufferedAmount > 0 && Date.now() - pending.sentAt < P2P_ACK_MAX_WAIT_MS) {
            pending.timer = setTimeout(check, P2P_ACK_TIMEOUT_MS);
            return;
        }
        handleMissingP2PAck(operationId).catch(error => logDebug(`P2P ack fallback failed: ${error.message}`));
    };
    pending.timer = setTimeout(check, P2P_ACK_TIMEOUT_MS);
    state.pendingP2PAcks[operationId] = pending;
}

function handleP2PAck(peerId, operationId) {
    const pending = state.pendingP2PAcks[operationId];
    if (!pending || pending.peerId !== peerId) return;
    clearTimeout(pending.timer);
    delete state.pendingP2PAcks[operationId];
}

async function handleMissingP2PAck(operationId) {
    const pending = state.pendingP2PAcks[operationId];
    if (!pending) return;
    clearTimeout(pending.timer);
    delete state.pendingP2PAcks[operationId];
    const { peerId, channel, item } = pending;
    logDebug(`Keine Empfangsbestaetigung von ${peerId} fuer ${operationId}: Kanal gilt als tot, nutze Pfad C.`);
    // Toten Kanal schliessen, damit die naechsten Nachrichten nicht auch hineinlaufen.
    if (state.dataChannels[peerId] === channel) {
        const connection = state.webrtcConnections[peerId];
        if (connection) cleanupPeerConnection(peerId, connection);
        else channel.close();
    }
    let queued = false;
    try {
        queued = await queuePayloadInCache(peerId, item);
    } catch (error) {
        logDebug(`Path C fallback for ${peerId} failed: ${error.message}`);
    }
    if (queued || item.discarded) return;
    // Auch Pfad C geht nicht: beim naechsten Verbindungsaufbau erneut senden.
    item.onSent('pending');
    (state.secureMessageQueues[peerId] = state.secureMessageQueues[peerId] || []).push(item);
}

// Partner laut Server offline: Unbestaetigtes und Wartendes sofort ueber Pfad C.
function flushUnconfirmedToCache(peerId) {
    Object.entries(state.pendingP2PAcks)
        .filter(([, pending]) => pending.peerId === peerId)
        .forEach(([operationId]) => handleMissingP2PAck(operationId).catch(error => logDebug(`P2P ack fallback failed: ${error.message}`)));
    if (state.secureMessageQueues[peerId]?.some(item => item.onSent && !item.cacheQueued)) {
        flushPeerQueueToCache(peerId).catch(error => logDebug(`Path C fallback failed: ${error.message}`));
    }
}

async function flushSecureMessageQueue(peerId) {
    const queue = state.secureMessageQueues[peerId] || [];
    state.secureMessageQueues[peerId] = [];
    for (const item of queue) {
        if (item.cacheQueued) continue;
        await sendSecurePayload(peerId, item.payload, item.onSent);
    }
}

async function deriveCacheEncryptionKey(publicJwk) {
    const publicKey = await window.crypto.subtle.importKey(
        'jwk',
        publicJwk,
        {name: 'ECDH', namedCurve: 'P-256'},
        false,
        []
    );
    return window.crypto.subtle.deriveKey(
        {name: 'ECDH', public: publicKey},
        state.myKeys.keyPair.privateKey,
        {name: 'AES-GCM', length: 256},
        false,
        ['encrypt', 'decrypt']
    );
}

function cacheNotifyKind(item) {
    const operation = item.payload?.operation;
    if (item.notifyKind) return item.notifyKind;
    if (operation?.type === 'MESSAGE_PUT') return operation.message?.scope === 'discovery' ? 'discovery' : 'chat';
    if (operation?.type === 'PROFILE_VIEW') return 'profileView';
    return null;
}

async function queuePayloadInCache(peerId, item) {
    // Umzugs-Ansagen (move.js) gehen auch ueber Pfad C: Kontakte koennen gerade offline sein.
    // Gruppen-Zustand und Austritt (T36) ebenfalls, sonst erfaehrt ein offline Mitglied nichts von der Gruppe.
    if (item.cacheQueued || !['CHAT_OPERATION', 'MOVE_ANNOUNCE', 'GROUP_STATE', 'GROUP_LEAVE', 'GROUP_SENDER_KEY', 'GROUP_MEMBER_CARD', 'DEVICE_JOIN', 'DEVICE_LIST'].includes(item.payload?.type)) return false;
    if (!state.gridSettings.cacheEnabled) {
        logDebug(`Path C skipped for ${peerId}: message cache is disabled locally.`);
        return false;
    }
    const peerPublicKey = await getPeerIdentityKey(peerId);
    if (!peerPublicKey) {
        logDebug(`Path C skipped for ${peerId}: no trusted peer identity key is cached.`);
        return false;
    }

    // Forward Secrecy (T36 P5): Wegwerf-Schluessel + Prekey des Empfaengers (Umschlag v3).
    const sealed = typeof sealPathCKey === 'function' ? await sealPathCKey(peerId, peerPublicKey) : null;
    const encryptionKey = sealed ? sealed.key : await deriveCacheEncryptionKey(peerPublicKey);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt(
        {name: 'AES-GCM', iv},
        encryptionKey,
        new TextEncoder().encode(JSON.stringify(item.payload))
    );
    const response = await fetch(`${API_BASE}/api/cache`, {
        method: 'POST',
        headers: peerAuthHeaders({'Content-Type': 'application/json'}),
        body: JSON.stringify({
            recipientId: peerId,
            senderId: state.myProfile.id,
            ciphertextPayload: JSON.stringify(sealed
                ? { ...sealed.envelope, ciphertext: bytesToBase64(new Uint8Array(ciphertext)) }
                : { version: 1, senderPublicKey: state.myKeys.jwkPublic, ciphertext: bytesToBase64(new Uint8Array(ciphertext)) }),
            ivHex: bytesToBase64(iv),
            ttlHours: 24,
            // Nur neue Nachrichten, Flammen/Matches, Anfragen und Profilbesuche wecken den Empfaenger per
            // Web Push; die Art filtert der Router nach den Einstellungen des Empfaengers.
            notify: Boolean(cacheNotifyKind(item)),
            notifyKind: cacheNotifyKind(item) || undefined
        })
    });
    if (response.status === 403) {
        item.discarded = true;
        if (item.onSent) item.onSent('rejected');
        logDebug(`Path C delivery to ${peerId} was rejected by the recipient.`);
        return false;
    }
    if (response.status === 410) {
        // Empfaenger ist umgezogen (server/move.js): Chat auf die neue ID umziehen; die Operation bleibt im
        // Log und geht beim naechsten Chat-Sync an die neue ID.
        item.discarded = true;
        const moved = await response.json().catch(() => null);
        if (item.onSent) item.onSent(item.payload?.type === 'MOVE_ANNOUNCE' ? 'moved' : 'pending');
        if (typeof handleRouterMove === 'function') await handleRouterMove(peerId, moved).catch(logBackgroundError('queuePayloadInCache'));
        return false;
    }
    if (!response.ok) throw new Error(`Cache API returned ${response.status}.`);
    item.cacheQueued = true;
    const queued = await response.json().catch(() => ({}));
    if (item.onSent) item.onSent('cache', { expiresAt: queued.expiresAt });
    return true;
}

async function flushPeerQueueToCache(peerId) {
    const queue = state.secureMessageQueues[peerId] || [];
    try {
        for (const item of queue) {
            try {
                await queuePayloadInCache(peerId, item);
            } catch (error) {
                logDebug(`Could not queue operation for ${peerId}: ${error.message}`);
            }
        }
    } finally {
        state.secureMessageQueues[peerId] = queue.filter(item => !item.cacheQueued && !item.discarded);
    }
}

function publicKeysMatch(left, right) {
    return Boolean(left && right)
        && left.kty === right.kty
        && left.crv === right.crv
        && left.x === right.x
        && left.y === right.y;
}

// Mehrere Hinweise kurz hintereinander (z. B. mehrere Nachrichten) loesen nur einen Abruf aus.
function scheduleCacheFetch(delayMs = 300) {
    if (state.cacheFetchTimer) return;
    state.cacheFetchTimer = setTimeout(() => {
        state.cacheFetchTimer = null;
        fetchQueuedCacheMessages().catch(logBackgroundError('scheduleCacheFetch'));
    }, delayMs);
}

async function fetchQueuedCacheMessages() {
    if (state.cacheFetchInFlight || !state.myKeys) return;
    state.cacheFetchInFlight = true;
    try {
        const response = await fetch(`${API_BASE}/api/cache/${encodeURIComponent(state.myProfile.id)}`, {
            cache: 'no-store',
            headers: peerAuthHeaders()
        });
        if (!response.ok) throw new Error(`Cache API returned ${response.status}.`);
        const {messages = []} = await response.json();

        // Gruppen-Buendel zuletzt: ein Absender-Schluessel aus demselben Abruf ist dann schon gespeichert.
        const isGroupBundle = message => {
            try {
                return JSON.parse(message.ciphertextPayload)?.kind === 'group';
            } catch {
                return false;
            }
        };
        const ordered = [...messages.filter(message => !isGroupBundle(message)), ...messages.filter(isGroupBundle)];
        for (const cachedMessage of ordered) {
            try {
                if (isPeerBlocked(cachedMessage.senderId)) throw new Error('Sender is blocked.');
                const envelope = JSON.parse(cachedMessage.ciphertextPayload);
                // Gebuendelte Gruppen-Nachricht (T36 P2c): mit dem Absender-Schluessel des Mitglieds. Fehlt er noch,
                // bleibt sie liegen (kein ACK) und wird beim naechsten Abruf erneut versucht.
                if (envelope?.kind === 'group') {
                    const groupPayload = typeof openGroupEnvelope === 'function' ? await openGroupEnvelope(cachedMessage.senderId, envelope, cachedMessage.ivHex) : null;
                    if (!groupPayload) throw new Error('Group sender key not known yet.');
                    if (groupPayload.type !== 'CHAT_OPERATION' || groupPayload.conversationId !== envelope.groupId) throw new Error('Unexpected group payload.');
                    await handleSecurePayload(cachedMessage.senderId, groupPayload, 'Group Path C');
                    const groupDelete = await fetch(`${API_BASE}/api/cache/${encodeURIComponent(cachedMessage.msgId)}`, {method: 'DELETE', headers: peerAuthHeaders()});
                    if (!groupDelete.ok) throw new Error(`Cache delete returned ${groupDelete.status}.`);
                    continue;
                }
                const trustedSenderKey = await getPeerIdentityKey(cachedMessage.senderId);
                const trusted = Boolean(trustedSenderKey) && publicKeysMatch(trustedSenderKey, envelope.senderPublicKey);
                // Unbekannter Absender: nur eine signierte Umzugs-Ansage (move.js), die sich selbst belegt.
                if (!trusted && trustedSenderKey) {
                    throw new Error('Sender identity key does not match the trusted P2P key.');
                }
                const decryptionKey = envelope.version === 3
                    ? await openPathCKey(cachedMessage.senderId, envelope)
                    : await deriveCacheEncryptionKey(envelope.senderPublicKey);
                const plaintext = await window.crypto.subtle.decrypt(
                    {name: 'AES-GCM', iv: base64ToBytes(cachedMessage.ivHex)},
                    decryptionKey,
                    base64ToBytes(envelope.ciphertext)
                );
                const payload = JSON.parse(new TextDecoder().decode(plaintext));
                if (!trusted) {
                    if (payload.type !== 'MOVE_ANNOUNCE' || !isValidSecurePayload(payload)) throw new Error('Sender identity key is unknown.');
                    await handleMoveAnnouncement(cachedMessage.senderId, payload, envelope.senderPublicKey);
                } else {
                    if (!['CHAT_OPERATION', 'MOVE_ANNOUNCE', 'GROUP_STATE', 'GROUP_LEAVE', 'GROUP_SENDER_KEY', 'GROUP_MEMBER_CARD', 'DEVICE_JOIN', 'DEVICE_LIST'].includes(payload.type)) throw new Error('Unsupported cached payload type.');
                    await handleSecurePayload(cachedMessage.senderId, payload, 'Encrypted Path C');
                }
                const deleteResponse = await fetch(
                    `${API_BASE}/api/cache/${encodeURIComponent(cachedMessage.msgId)}`,
                    {method: 'DELETE', headers: peerAuthHeaders()}
                );
                if (!deleteResponse.ok) throw new Error(`Cache delete returned ${deleteResponse.status}.`);
            } catch (error) {
                logDebug(`Rejected Path C message ${cachedMessage.msgId}: ${error.message}`);
            }
        }
    } catch (error) {
        logDebug(`Path C retrieval failed: ${error.message}`);
    } finally {
        state.cacheFetchInFlight = false;
    }
}
