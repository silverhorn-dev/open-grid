// Zustellung: Chat-Sync, Sende-Queue mit Pfad-C-Fallback und Abruf des Zwischenspeichers.
// Ausgelagert aus p2p.client.js (klassisches Skript, globale Funktionen).
async function beginChatSync(peerId) {
    if (state.chatSyncInProgress[peerId]) return;
    state.chatSyncInProgress[peerId] = true;
    try {
        const operations = await getChatOperations(peerId);
        await sendSecurePayload(peerId, {
            type: 'CHAT_SYNC_HELLO',
            recentOperationIds: operations.slice(0, 20).map(operation => operation.operationId),
            hasMore: operations.length > 20
        });
    } finally {
        delete state.chatSyncInProgress[peerId];
    }
}

async function handleChatSyncHello(peerId, payload) {
    await confirmDeliveredOperations(peerId, payload.recentOperationIds || []);
    const operations = await getChatOperations(peerId);
    const localIds = new Set(operations.map(operation => operation.operationId));
    const missingIds = (payload.recentOperationIds || []).filter(operationId => !localIds.has(operationId));
    if (missingIds.length) {
        await sendSecurePayload(peerId, {
            type: 'CHAT_SYNC_OPERATION_REQUEST',
            operationIds: missingIds
        });
    }
    if (payload.hasMore) {
        await sendSecurePayload(peerId, {
            type: 'CHAT_SYNC_INVENTORY_REQUEST',
            cursor: 20
        });
    }
}

async function sendChatSyncInventory(peerId, cursor) {
    const operations = await getChatOperations(peerId);
    const pageSize = 50;
    await sendSecurePayload(peerId, {
        type: 'CHAT_SYNC_INVENTORY',
        operationIds: operations
            .slice(cursor, cursor + pageSize)
            .map(operation => operation.operationId),
        nextCursor: cursor + pageSize < operations.length ? cursor + pageSize : null
    });
}

async function handleChatSyncInventory(peerId, payload) {
    await confirmDeliveredOperations(peerId, payload.operationIds || []);
    const localIds = new Set(
        (await getChatOperations(peerId)).map(operation => operation.operationId)
    );
    const missingIds = (payload.operationIds || []).filter(operationId => !localIds.has(operationId));
    if (missingIds.length) {
        await sendSecurePayload(peerId, {
            type: 'CHAT_SYNC_OPERATION_REQUEST',
            operationIds: missingIds
        });
    }
    if (payload.nextCursor !== null && payload.nextCursor !== undefined) {
        await sendSecurePayload(peerId, {
            type: 'CHAT_SYNC_INVENTORY_REQUEST',
            cursor: payload.nextCursor
        });
    }
}

async function sendRequestedChatOperations(peerId, operationIds) {
    const requestedIds = new Set(operationIds.slice(0, 50));
    const operations = (await getChatOperations(peerId))
        .filter(operation => requestedIds.has(operation.operationId))
        .map(({peerId: _localPeerId, ...operation}) => operation);
    if (!operations.length) return;
    await sendSecurePayload(peerId, {
        type: 'CHAT_SYNC_OPERATIONS',
        operations
    });
}

async function sendSecurePayload(peerId, payload, onSent = null) {
    if (isPeerBlocked(peerId)) return false;
    const channel = state.dataChannels[peerId];

    // Wenn der P2P/TURN-Kanal offen und sicher ist -> Direkt senden
    if (channel?.readyState === 'open' && state.sessionKeys[peerId]) {
        try {
            channel.send(JSON.stringify(await encryptSecurePayload(peerId, payload)));
            if (onSent) onSent('p2p');
            return true;
        } catch (error) {
            logDebug(`P2P send failed: ${error.message}`);
        }
    }

    // Andernfalls: In die lokale Warteschlange einreihen und Verbindung aufbauen/abwarten
    if (!state.secureMessageQueues[peerId]) {
        state.secureMessageQueues[peerId] = [];
    }

    const item = {payload, onSent, cacheQueued: false};
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
    setTimeout(async () => {
        if (!state.secureMessageQueues[peerId]?.includes(item) || item.cacheQueued || item.discarded) return;
        let queued = false;
        try {
            queued = await queuePayloadInCache(peerId, item);
        } catch (error) {
            logDebug(`Path C fallback for ${peerId} failed: ${error.message}`);
        }
        if (!queued && !item.discarded) item.onSent('pending');
    }, SECURE_QUEUE_FALLBACK_MS);
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

async function queuePayloadInCache(peerId, item) {
    if (item.cacheQueued || item.payload?.type !== 'CHAT_OPERATION') return false;
    if (!state.gridSettings.cacheEnabled) {
        logDebug(`Path C skipped for ${peerId}: message cache is disabled locally.`);
        return false;
    }
    const peerPublicKey = await getPeerIdentityKey(peerId);
    if (!peerPublicKey) {
        logDebug(`Path C skipped for ${peerId}: no trusted peer identity key is cached.`);
        return false;
    }

    const encryptionKey = await deriveCacheEncryptionKey(peerPublicKey);
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
            ciphertextPayload: JSON.stringify({
                version: 1,
                senderPublicKey: state.myKeys.jwkPublic,
                ciphertext: bytesToBase64(new Uint8Array(ciphertext))
            }),
            ivHex: bytesToBase64(iv),
            ttlHours: 24,
            // Nur neue Nachrichten wecken den Empfaenger per Web Push.
            notify: item.payload.operation?.type === 'MESSAGE_PUT'
        })
    });
    if (response.status === 403) {
        item.discarded = true;
        if (item.onSent) item.onSent('rejected');
        logDebug(`Path C delivery to ${peerId} was rejected by the recipient.`);
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

        for (const cachedMessage of messages) {
            try {
                if (isPeerBlocked(cachedMessage.senderId)) throw new Error('Sender is blocked.');
                const envelope = JSON.parse(cachedMessage.ciphertextPayload);
                const trustedSenderKey = await getPeerIdentityKey(cachedMessage.senderId);
                if (!trustedSenderKey || !publicKeysMatch(trustedSenderKey, envelope.senderPublicKey)) {
                    throw new Error('Sender identity key does not match the trusted P2P key.');
                }
                const decryptionKey = await deriveCacheEncryptionKey(envelope.senderPublicKey);
                const plaintext = await window.crypto.subtle.decrypt(
                    {name: 'AES-GCM', iv: base64ToBytes(cachedMessage.ivHex)},
                    decryptionKey,
                    base64ToBytes(envelope.ciphertext)
                );
                const payload = JSON.parse(new TextDecoder().decode(plaintext));
                if (payload.type !== 'CHAT_OPERATION') throw new Error('Unsupported cached payload type.');
                await handleSecurePayload(cachedMessage.senderId, payload, 'Encrypted Path C');
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
