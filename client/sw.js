// OpenGrid Service Worker: empfaengt Web Pushes fuer Pfad C.
// Kein DOM, kein localStorage. Alles Noetige liegt in IndexedDB.
// skipWaiting() wird bewusst nie automatisch aufgerufen (siehe AGENT.md).

const DB_NAME = 'OpenGridDB_Live';
const NETWORK_TIMEOUT_MS = 5000;
const PREVIEW_LENGTH = 140;

function base64ToBytes(value) {
    return Uint8Array.from(self.atob(value), character => character.charCodeAt(0));
}

function base64UrlToBytes(value) {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    return base64ToBytes(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
}

function publicKeysMatch(left, right) {
    return Boolean(left && right)
        && left.kty === right.kty
        && left.crv === right.crv
        && left.x === right.x
        && left.y === right.y;
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = self.indexedDB.open(DB_NAME);
        // Ohne vorhandene Datenbank gibt es weder Schluessel noch Chats. Das
        // Schema legt ausschliesslich die App an, daher hier abbrechen.
        request.onupgradeneeded = () => request.transaction.abort();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Local database is unavailable.'));
    });
}

function getRecord(database, storeName, key) {
    return requestToPromise(database.transaction(storeName, 'readonly').objectStore(storeName).get(key));
}

function authHeaders(routerAuth) {
    return { Authorization: `Bearer ${routerAuth.authToken}` };
}

async function fetchQueuedMessage(routerAuth, msgId) {
    const response = await fetch(`/api/cache/${encodeURIComponent(routerAuth.nodeId)}`, {
        cache: 'no-store',
        headers: authHeaders(routerAuth),
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`Cache API returned ${response.status}.`);
    const { messages = [] } = await response.json();
    const message = messages.find(item => item.msgId === msgId);
    if (!message) throw new Error('Queued message is no longer available.');
    return message;
}

async function acknowledgeQueuedMessage(routerAuth, msgId) {
    try {
        const response = await fetch(`/api/cache/${encodeURIComponent(msgId)}`, {
            method: 'DELETE',
            headers: authHeaders(routerAuth),
            signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS)
        });
        if (!response.ok && response.status !== 404) throw new Error(`Cache delete returned ${response.status}.`);
    } catch (error) {
        // Nicht kritisch: die App wendet die Operation spaeter idempotent an
        // und loescht den Eintrag dann selbst.
        console.warn('[SW] Could not acknowledge queued message.', error);
    }
}

async function decryptQueuedOperation(identity, trustedSenderKey, queued) {
    const envelope = JSON.parse(queued.ciphertextPayload);
    if (!publicKeysMatch(trustedSenderKey, envelope.senderPublicKey)) {
        throw new Error('Sender identity key does not match the trusted P2P key.');
    }
    const senderKey = await self.crypto.subtle.importKey(
        'jwk',
        envelope.senderPublicKey,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
    );
    const decryptionKey = await self.crypto.subtle.deriveKey(
        { name: 'ECDH', public: senderKey },
        identity.privateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
    );
    const plaintext = await self.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(queued.ivHex) },
        decryptionKey,
        base64ToBytes(envelope.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
}

function isValidMessagePut(payload, senderId) {
    const operation = payload?.operation;
    return payload?.type === 'CHAT_OPERATION'
        && operation?.type === 'MESSAGE_PUT'
        && operation.actorId === senderId
        && operation.message?.senderId === senderId
        && operation.message.id === operation.messageId
        && operation.operationId === `put:${operation.messageId}`;
}

// Entspricht dem MESSAGE_PUT-Zweig von applyChatOperation in client/app/storage.js.
async function storeMessagePut(database, peerId, operation) {
    const transaction = database.transaction(['messages', 'chatOperations'], 'readwrite');
    const done = new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted.'));
    });
    const messages = transaction.objectStore('messages');
    const operations = transaction.objectStore('chatOperations');
    const existingOperation = await requestToPromise(operations.get(operation.operationId));
    if (!existingOperation) {
        const existingMessage = await requestToPromise(messages.get(operation.messageId));
        if (!existingMessage?.deleted) {
            messages.put({ ...operation.message, peerId, deliveredVia: 'E2EE Push' });
        }
        operations.put({ ...operation, peerId });
    }
    await done;
}

async function findPeerName(database, peerId) {
    try {
        const peers = await requestToPromise(
            database.transaction('gridPeers', 'readonly').objectStore('gridPeers').getAll()
        );
        return peers.find(peer => peer.id === peerId)?.name || null;
    } catch {
        return null;
    }
}

async function receivePathCPush(data) {
    const database = await openDatabase();
    try {
        const [identity, routerAuth, peerIdentity] = await Promise.all([
            getRecord(database, 'keys', 'identity-key'),
            getRecord(database, 'keys', 'router-auth'),
            getRecord(database, 'keys', `peer-identity:${data.senderId}`)
        ]);
        if (!identity?.privateKey || !routerAuth?.authToken || !peerIdentity?.jwkPublic) {
            throw new Error('Keys for background delivery are missing.');
        }
        const queued = data.ciphertextPayload ? data : await fetchQueuedMessage(routerAuth, data.msgId);
        const payload = await decryptQueuedOperation(identity, peerIdentity.jwkPublic, queued);
        if (!isValidMessagePut(payload, data.senderId)) {
            throw new Error('Push payload is not a valid chat message.');
        }
        await storeMessagePut(database, data.senderId, payload.operation);
        await acknowledgeQueuedMessage(routerAuth, data.msgId);
        return {
            message: payload.operation.message,
            senderName: await findPeerName(database, data.senderId)
        };
    } finally {
        database.close();
    }
}

function showChatNotification(title, body, senderId) {
    return self.registration.showNotification(title, {
        body,
        tag: senderId ? `chat-${senderId}` : 'chat',
        renotify: true,
        data: { peerId: senderId || null }
    });
}

function showGenericNotification(senderId) {
    return showChatNotification('Neue Nachricht', 'Du hast eine neue Nachricht erhalten. Tippe zum Oeffnen.', senderId);
}

// Kompaktmodus: immer dieselbe Benachrichtigung ohne Name und Text. Der feste
// Tag ersetzt eine vorhandene, auch bei mehreren Absendern bleibt es eine.
function showCompactNotification() {
    return self.registration.showNotification('Neue Nachrichten', {
        body: 'Tippe zum Oeffnen.',
        tag: 'opengrid-messages',
        renotify: true,
        data: { peerId: null }
    });
}

async function loadCompactSetting() {
    try {
        const database = await openDatabase();
        try {
            // Standard ist der Kompaktmodus, nur ein explizites false zeigt Vorschauen.
            return (await getRecord(database, 'keys', 'push-settings'))?.compactNotifications !== false;
        } finally {
            database.close();
        }
    } catch {
        return true;
    }
}

function previewText(message) {
    if (message.snapData) return 'Snap';
    const text = String(message.text || '');
    return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}...` : text;
}

async function handlePush(event) {
    let data = null;
    try {
        data = event.data ? event.data.json() : null;
    } catch {
        data = null;
    }
    const compact = await loadCompactSetting();
    if (data?.type !== 'PATH_C' || typeof data.msgId !== 'string' || typeof data.senderId !== 'string') {
        return compact ? showCompactNotification() : showGenericNotification(null);
    }

    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visibleWindow = windows.find(client => client.visibilityState === 'visible');
    if (visibleWindow) {
        // Die offene App hat Live-State und wendet die Queue selbst an.
        visibleWindow.postMessage({ type: 'PATH_C_AVAILABLE' });
        return undefined;
    }

    try {
        const { message, senderName } = await receivePathCPush(data);
        windows.forEach(client => client.postMessage({ type: 'CHAT_STORE_UPDATED', peerId: data.senderId }));
        if (compact) return showCompactNotification();
        return showChatNotification(
            senderName ? `Neue Nachricht von ${senderName}` : 'Neue Nachricht',
            previewText(message),
            data.senderId
        );
    } catch (error) {
        console.warn('[SW] Background delivery failed, message stays in the queue.', error);
        return compact ? showCompactNotification() : showGenericNotification(data.senderId);
    }
}

async function resubscribe(event) {
    const database = await openDatabase();
    let routerAuth;
    try {
        routerAuth = await getRecord(database, 'keys', 'router-auth');
    } finally {
        database.close();
    }
    if (!routerAuth?.authToken) return;

    let subscription = event.newSubscription;
    if (!subscription) {
        const keyResponse = await fetch('/api/push/vapid-public-key', { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
        const { publicKey } = await keyResponse.json();
        subscription = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64UrlToBytes(publicKey)
        });
    }
    await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { ...authHeaders(routerAuth), 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: routerAuth.nodeId, subscription: subscription.toJSON() }),
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS)
    });
}

self.addEventListener('push', event => {
    event.waitUntil(handlePush(event));
});

self.addEventListener('pushsubscriptionchange', event => {
    event.waitUntil(resubscribe(event).catch(error => {
        console.warn('[SW] Push resubscription failed.', error);
    }));
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    const peerId = event.notification.data?.peerId || null;
    const targetUrl = peerId ? `/?chat=${encodeURIComponent(peerId)}` : '/';

    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existing = windows.find(client => 'focus' in client);
        if (existing) {
            await existing.focus();
            if (peerId) existing.postMessage({ type: 'OPEN_CHAT', peerId });
            return;
        }
        if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
    })());
});
