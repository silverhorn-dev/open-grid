// OpenGrid Service Worker: App-Shell offline ausliefern und Web Pushes fuer Pfad C empfangen.
// Kein DOM, kein localStorage. Alles Noetige liegt in IndexedDB.
// skipWaiting() wird bewusst nie automatisch aufgerufen (siehe AGENT.md), nur auf Wunsch des Nutzers.

// Vom Server beim Ausliefern eingesetzt (server/app.js).
const ASSET_VERSION = '__ASSET_VERSION__';
const PRECACHE_URLS = __PRECACHE_URLS__;
const CACHE_PREFIX = 'opengrid-shell-';
const SHELL_CACHE = `${CACHE_PREFIX}${ASSET_VERSION}`;
const NAVIGATION_TIMEOUT_MS = 3000;

const DB_NAME = 'OpenGridDB_Live';
const NETWORK_TIMEOUT_MS = 5000;
const PREVIEW_LENGTH = 140;
// Benachrichtigungstexte (Schluessel sw.* aus i18n/*.properties), vom Server eingesetzt.
// Der SW kennt die Spracheinstellung der Seite nicht (localStorage), er nimmt die Browsersprache.
const SW_TEXTS = __SW_TEXTS__;

function swLanguage() {
    const languages = self.navigator?.languages || [self.navigator?.language];
    const device = languages.map(language => String(language || '').slice(0, 2).toLowerCase());
    return device.find(language => SW_TEXTS[language]) || 'de';
}

function swText(key, params = {}) {
    const text = SW_TEXTS[swLanguage()]?.[key] ?? SW_TEXTS.de?.[key] ?? key;
    return String(text).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

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

// Chat-Berechtigungen (P6): die Seite spiegelt Modus und angenommene Peers nach `keys`/`chat-gate`.
// Nachrichten von nicht angenommenen Peers markiert der SW nur; die Seite prueft sie beim Laden.
async function isChatGated(database, peerId) {
    const gate = await getRecord(database, 'keys', 'chat-gate').catch(() => null);
    return Boolean(gate && gate.mode !== 'A' && !(gate.acceptedPeerIds || []).includes(peerId));
}

// Entspricht dem MESSAGE_PUT-Zweig von applyChatOperation in client/app/storage.js.
async function storeMessagePut(database, peerId, operation, gated = false) {
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
            messages.put({
                ...operation.message,
                peerId,
                deliveredVia: 'E2EE Push',
                ...(gated ? { held: true, policyPending: true } : {})
            });
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
        const gated = await isChatGated(database, data.senderId);
        await storeMessagePut(database, data.senderId, payload.operation, gated);
        await acknowledgeQueuedMessage(routerAuth, data.msgId);
        return {
            message: payload.operation.message,
            senderName: await findPeerName(database, data.senderId),
            gated
        };
    } finally {
        database.close();
    }
}

// App-Symbol: Punkt ohne Zahl (die genaue Anzahl setzt die Seite beim naechsten Oeffnen).
function markAppBadge() {
    if ('setAppBadge' in self.navigator) self.navigator.setAppBadge().catch(() => {});
}

function showChatNotification(title, body, senderId) {
    markAppBadge();
    return self.registration.showNotification(title, {
        body,
        tag: senderId ? `chat-${senderId}` : 'chat',
        renotify: true,
        data: { peerId: senderId || null }
    });
}

function showGenericNotification(senderId) {
    return showChatNotification(swText('sw.newMessage'), swText('sw.newMessageBody'), senderId);
}

// Kompaktmodus: immer dieselbe Benachrichtigung ohne Name und Text. Der feste
// Tag ersetzt eine vorhandene, auch bei mehreren Absendern bleibt es eine.
function showCompactNotification() {
    markAppBadge();
    return self.registration.showNotification(swText('sw.newMessages'), {
        body: swText('sw.tapToOpen'),
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
    if (message.secureSnap) return 'Secure Snap';
    if (message.album) return 'Album';
    if (message.audioData) return swText('sw.voiceMessage');
    if (message.video) return 'Video';
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
    // Anstupsen: Nachricht kam direkt (P2P) an, die App ist aber im Hintergrund. Kein Inhalt im Push,
    // nur der Absender; bei sichtbarer App nichts zeigen.
    if (data?.type === 'NUDGE' && typeof data.senderId === 'string') {
        const openWindows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (openWindows.some(client => client.visibilityState === 'visible')) return undefined;
        if (compact) return showCompactNotification();
        let senderName = null;
        try {
            const database = await openDatabase();
            try {
                senderName = await findPeerName(database, data.senderId);
            } finally {
                database.close();
            }
        } catch {
            senderName = null;
        }
        return showChatNotification(
            senderName ? swText('sw.newMessageFrom', { name: senderName }) : swText('sw.newMessage'),
            swText('sw.tapToOpen'),
            data.senderId
        );
    }
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
        const { message, senderName, gated } = await receivePathCPush(data);
        windows.forEach(client => client.postMessage({ type: 'CHAT_STORE_UPDATED', peerId: data.senderId }));
        // Moeglicherweise zurueckgehaltene Nachricht: weder Name noch Text zeigen.
        if (compact || gated) return showCompactNotification();
        return showChatNotification(
            senderName ? swText('sw.newMessageFrom', { name: senderName }) : swText('sw.newMessage'),
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

// ================= OFFLINE (App-Shell) =================
// Installation laedt alle Dateien in einen versionierten Cache und prueft jede Antwort.
// Schlaegt eine fehl, scheitert die Installation und der bisherige Worker bleibt aktiv.
async function precacheShell() {
    const cache = await caches.open(SHELL_CACHE);
    try {
        await Promise.all(PRECACHE_URLS.map(async url => {
            const response = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
            if (!response.ok || response.type !== 'basic') throw new Error(`Precache failed for ${url}: ${response.status}`);
            await cache.put(url, response);
        }));
    } catch (error) {
        await caches.delete(SHELL_CACHE);
        throw error;
    }
}

self.addEventListener('install', event => {
    event.waitUntil(precacheShell());
});

// Erst nach der Aktivierung (erste Installation oder Update auf Wunsch) alte Caches entfernen.
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter(name => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

// Der Nutzer hat "Aktualisieren" gewaehlt.
self.addEventListener('message', event => {
    if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});

function withTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Network timeout')), timeoutMs))
    ]);
}

// Seiten (/grid, /chat/..., ...): Netzwerk zuerst, offline die gecachte App-Shell.
async function handleNavigation(request) {
    try {
        return await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
    } catch {
        const cache = await caches.open(SHELL_CACHE);
        const shell = await cache.match('/');
        return shell || Response.error();
    }
}

// Versionierte Dateien: Cache zuerst, sonst Netzwerk.
async function handleAsset(request) {
    const cached = await caches.match(request, { cacheName: SHELL_CACHE });
    return cached || fetch(request);
}

// "Teilen nach OpenGrid" (share_target im Manifest): geteilte Bilder und Text bleiben lokal in einem
// eigenen Cache, bis die App sie einem Chat zuordnet (client/app/share-target.js). Nichts geht an den Server.
const SHARE_INBOX_CACHE = 'opengrid-share-inbox';
const SHARE_MAX_FILES = 20;
const SHARE_MAX_FILE_BYTES = 25 * 1024 * 1024;
const SHARE_MAX_TEXT_LENGTH = 4000;

async function handleShareTarget(request) {
    try {
        const form = await request.formData();
        const files = form.getAll('files')
            .filter(file => typeof file === 'object' && file && String(file.type).startsWith('image/') && file.size <= SHARE_MAX_FILE_BYTES)
            .slice(0, SHARE_MAX_FILES);
        const field = name => String(form.get(name) || '').slice(0, SHARE_MAX_TEXT_LENGTH);
        await caches.delete(SHARE_INBOX_CACHE);
        const cache = await caches.open(SHARE_INBOX_CACHE);
        await Promise.all(files.map((file, index) => cache.put(`/__share/file-${index}`, new Response(file, { headers: { 'Content-Type': file.type } }))));
        await cache.put('/__share/meta', new Response(JSON.stringify({
            title: field('title'),
            text: field('text'),
            url: field('url'),
            files: files.length,
            skipped: form.getAll('files').length - files.length,
            at: Date.now()
        }), { headers: { 'Content-Type': 'application/json' } }));
        return Response.redirect('/chat?share=1', 303);
    } catch (error) {
        console.warn('[SW] Share target failed.', error);
        return Response.redirect('/chat?share=failed', 303);
    }
}

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method === 'POST' && new URL(request.url).pathname === '/share-target') {
        event.respondWith(handleShareTarget(request));
        return;
    }
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    // Nur eigene Seiten und Dateien; API, WebSocket und Fremd-URLs laufen ungecacht durch.
    if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
    if (request.mode === 'navigate') {
        event.respondWith(handleNavigation(request));
    } else if (url.pathname.startsWith('/client/') || url.pathname.startsWith('/vendor/')) {
        event.respondWith(handleAsset(request));
    }
});

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
    const targetUrl = peerId ? `/chat/${encodeURIComponent(peerId)}` : '/grid';

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
