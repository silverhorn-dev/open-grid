# Architecture & Implementation Specification: PWA Background Push & Handshake

This document specifies the integration of Web Push Notifications and Service Worker background processing for an existing peer-to-peer (P2P) chat application. 

The main objective is to wake up an inactive/standby PWA client upon an incoming message notification to trigger the established peer-to-peer handshake directly in the background, bypassing the server-side fallback cache whenever possible.

---

## 0. Implementation Plan (decided 2026-10-22)

> The original spec below assumes a P2P handshake inside the Service Worker.
> That is not possible: `RTCPeerConnection` does not exist in Service Workers.
> Instead, the **sender client delivers the message itself through the push**.
> The server only forwards it.

### Flow

1. Peer A sends a chat message, direct P2P fails (`PEER_OFFLINE_FALLBACK`).
2. Peer A encrypts the `CHAT_OPERATION` with the existing Path C key
   (ECDH identity keys -> AES-256-GCM) and posts it to `POST /api/cache`
   with `notify: true` (only for `MESSAGE_PUT`).
3. Server stores it in the queue (fallback) and sends a VAPID Web Push to
   Peer B's push subscription:
   - payload fits (< ~3.8 KB): `{ msgId, senderId, ciphertextPayload, ivHex }`
     -> the ciphertext of Peer A travels inside the push
   - payload too big (e.g. snaps): `{ msgId, senderId }` only
4. Peer B's Service Worker wakes up (`push` event):
   - a visible app window exists -> tell it to fetch the queue, done
   - else: load keys from IndexedDB, take ciphertext from the push (or fetch
     it from `GET /api/cache/:recipientId`), verify the sender key against the
     trusted P2P key, decrypt, store `MESSAGE_PUT` in IndexedDB
     (`messages` + `chatOperations`, idempotent)
5. SW acknowledges: `DELETE /api/cache/:msgId`.
6. SW shows an OS notification; a click opens/focuses the app on that chat.
7. On any error: generic notification, message stays in the queue and the
   app picks it up on next start (existing Path C logic).

### Decisions

- Reuse existing `/api/cache` routes, no `/api/v1/cache/...` routes.
- New routes: `GET /api/push/vapid-public-key`, `POST /api/push/subscribe`,
  `DELETE /api/push/subscribe/:peerId`.
- Web Push via browser vendor push services is OK (payload is Path C
  ciphertext + Web Push encryption, never plaintext).
- No new npm dependency: VAPID (ES256 JWT) and `aes128gcm` (RFC 8291) are
  implemented with `node:crypto` in `server/push.js`.
- VAPID keys from env (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT`) or generated once and persisted in SQLite.
- Service Worker never calls `skipWaiting()` automatically (AGENT.md rule).
- SW has no DOM access; router auth token + node ID are mirrored from
  `localStorage` into IndexedDB (`keys` store, id `router-auth`) for the SW.
- Network calls in the SW use a 5 s timeout.
- Only `MESSAGE_PUT` triggers a push. Deletes/wipes stay in the queue for the
  app and the normal delta sync.

### Tasks

- [x] `server/push.js`: VAPID JWT + aes128gcm encryption + send
- [x] SQLite: `push_subscriptions`, `server_settings` (VAPID keys)
- [x] push routes + push trigger in `POST /api/cache`
- [x] `client/sw.js` served at `/sw.js`
- [x] page: SW registration, enable-notifications button, subscription upload
- [x] page: mirror auth token to IndexedDB, handle SW messages, `?chat=` deep link
- [x] tests (encryption roundtrip, routes, push trigger)
- [x] docs: README, SPECE, USE-CASE
- [ ] test on real devices (Android Chrome, Firefox, iOS Safari as installed PWA)

---

## 1. Flow Overview & Fallback Strategy

```
+-------------------+                 +------------------------+                 +-------------------+
|  Sender Client    |                 | Serverless Push / Relay|                 |  Receiver Client  |
|     (Peer A)      |                 |        Backend         |                 |  (Peer B - Standby)
+---------+---------+                 +-----------+------------+                 +---------+---------+
          |                                       |                                       |
          | 1. Direct Peer-to-Peer Handshake      |                                       |
          |    (Fails: Peer B is Offline/Standby) |                                       |
          | X---------------------------------------------------------------------------> |
          |                                       |                                       |
          | 2. Push Trigger & Encrypted Cache     |                                       |
          |    POST /push/notify ---------------->| 3. Send VAPID Web Push                 |
          |    (Stores in Server-Cache as fallback)|   to Receiver Endpoint                |
          |                                       +-------------------------------------> | (OS/Browser Wakeup)
          |                                                                               |
          |                                                                               | 4. Service Worker
          |                                                                               |    `push` Event
          |                                                                               |
          | 5. Direct Background Handshake & Key Exchange                                 |
          | <---------------------------------------------------------------------------> | 6. Decrypt Message
          |                                                                               | 7. Clear Server Cache
          |                                                                               | 8. Show OS Notification
          |                                                                               | 9. Save to IndexedDB
```

---

## 2. Push Event Processing (`sw.js`)

When a Web Push payload reaches the client, the operating system wakes up the Service Worker. The Service Worker attempts to execute the P2P handshake directly with the sender before falling back to fetching the message from the server-side cache.

```javascript
// public/sw.js

self.addEventListener('push', (event) => {
  event.waitUntil(handleIncomingPush(event));
});

async function handleIncomingPush(event) {
  let pushData = {};
  if (event.data) {
    try {
      pushData = event.data.json();
    } catch (err) {
      pushData = { senderId: null, title: 'Neue Nachricht' };
    }
  }

  const { senderId, messageId, sessionId } = pushData;

  try {
    // 1. Attempt direct Peer-to-Peer handshake via background signaling
    const message = await attemptBackgroundP2PHandshake(senderId, sessionId, messageId);

    // 2. Persist decrypted message into local IndexedDB
    await saveMessageToIndexedDB(message);

    // 3. Notify server that direct handshake succeeded (clear cache entry)
    await ackServerCache(messageId);

    // 4. Display UI Notification
    return showChatNotification(pushData.title || 'Neue Nachricht', message.text, senderId);

  } catch (handshakeError) {
    console.warn('[SW] Direct P2P background handshake failed. Falling back to Server Cache.', handshakeError);

    try {
      // Fallback: Fetch cached message from Server Cache
      const cachedMessage = await fetchFromServerCache(messageId);
      await saveMessageToIndexedDB(cachedMessage);

      return showChatNotification(pushData.title || 'Neue Nachricht', cachedMessage.text, senderId);
    } catch (cacheError) {
      console.error('[SW] Both P2P Handshake and Server Cache retrieval failed:', cacheError);

      // Generic fallback notification to open the app
      return showChatNotification('Neue Nachricht', 'Du hast eine neue Nachricht erhalten. Tippe zum Oeffnen.', senderId);
    }
  }
}

function showChatNotification(title, body, senderId) {
  const options = {
    body: body,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    tag: `chat-${senderId}`,
    renotify: true,
    data: {
      url: `/chat/${senderId}`
    }
  };

  return self.registration.showNotification(title, options);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
```

---

## 3. Background P2P Handshake & Storage Logic

```javascript
// Functionality executed within Service Worker context

async function attemptBackgroundP2PHandshake(senderId, sessionId, messageId) {
  // Initiate ephemeral signal handshake using existing crypto/WebRTC signaling routines
  // Timeout added to ensure SW does not hang if sender is temporarily unreachable
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Handshake Timeout')), 5000)
  );

  const handshakePromise = async () => {
    // 1. Re-establish ephemeral key exchange with sender
    const session = await initEphemeralSession(senderId, sessionId);
    
    // 2. Perform key derivation & handshake
    const decryptedPayload = await session.receiveHandshakeAndDecrypt(messageId);
    return decryptedPayload;
  };

  return Promise.race([handshakePromise(), timeoutPromise]);
}

async function fetchFromServerCache(messageId) {
  const response = await fetch(`/api/v1/cache/messages/${messageId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  });

  if (!response.ok) {
    throw new Error(`Server cache fetch failed with status ${response.status}`);
  }

  const data = await response.json();
  // Decrypt payload fetched from server-side cache
  return await decryptCachedPayload(data.encryptedPayload);
}

async function ackServerCache(messageId) {
  try {
    await fetch(`/api/v1/cache/messages/${messageId}/ack`, { method: 'DELETE' });
  } catch (err) {
    console.warn('[SW] Failed to acknowledge/clear server cache:', err);
  }
}
```

---

## 4. Key Implementation Rules for Copilot

1. **No DOM API Usage:** Ensure all Service Worker helper functions use `self`, `IndexedDB`, `CacheStorage`, or `crypto.subtle`. Do not access `window` or `document`.
2. **Handshake Timeout:** Always wrap the background P2P handshake in a timeout (e.g., 5 seconds) so the Service Worker can quickly fall back to the server-side cache if the sender drops offline.
3. **Cache Acknowledgment:** Once a background handshake succeeds, trigger an `ACK` call to the server-side cache to remove the temporary payload and save storage resources.