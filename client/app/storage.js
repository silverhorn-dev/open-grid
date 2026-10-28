// ================= INDEXEDDB =================
function initDatabase() {
    return new Promise((resolve) => {
        const req = indexedDB.open('OpenGridDB_Live', 9);
        let settled = false;
        const finish = (database = null) => {
            if (settled) return;
            settled = true;
            resolve(database);
        };
        req.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains('localProfile')) {
                database.createObjectStore('localProfile', { keyPath: 'slot' });
            }
            if (!database.objectStoreNames.contains('profiles')) database.createObjectStore('profiles', { keyPath: 'id' });
            const gridStore = database.objectStoreNames.contains('gridPeers')
                ? e.target.transaction.objectStore('gridPeers')
                : database.createObjectStore('gridPeers', { keyPath: 'cacheKey' });
            if (!gridStore.indexNames.contains('geohash')) gridStore.createIndex('geohash', 'geohash', { unique: false });

            const messageStore = database.objectStoreNames.contains('messages')
                ? e.target.transaction.objectStore('messages')
                : database.createObjectStore('messages', { keyPath: 'id' });
            if (!messageStore.indexNames.contains('peerId')) messageStore.createIndex('peerId', 'peerId', { unique: false });
            const operationStore = database.objectStoreNames.contains('chatOperations')
                ? e.target.transaction.objectStore('chatOperations')
                : database.createObjectStore('chatOperations', { keyPath: 'operationId' });
            if (!operationStore.indexNames.contains('peerId')) operationStore.createIndex('peerId', 'peerId', { unique: false });
            if (!database.objectStoreNames.contains('keys')) database.createObjectStore('keys', { keyPath: 'id' });
            if (!database.objectStoreNames.contains('media')) {
                database.createObjectStore('media', { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains('albums')) database.createObjectStore('albums', { keyPath: 'id' });
            // Version 9: Status von Freunden und eigene Status (24 h, verschluesselt).
            if (!database.objectStoreNames.contains('statusUpdates')) database.createObjectStore('statusUpdates', { keyPath: 'id' });
        };
        req.onsuccess = (e) => {
            db = e.target.result;
            db.onversionchange = () => {
                db.close();
                db = null;
            };
            finish(db);
        };
        req.onerror = () => {
            console.error('IndexedDB initialization failed.', req.error);
            finish();
        };
        req.onblocked = () => {
            showToast(t('app.pleaseCloseOtherOpengridTabs'), 'warning');
            setTimeout(() => finish(), 3000);
        };
    });
}

function databaseRequest(storeName, mode, operation) {
    if (!db) return Promise.reject(new Error('Local database is unavailable.'));
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function putDatabaseRecord(storeName, value) {
    if (!db) return Promise.resolve();
    return databaseRequest(storeName, 'readwrite', store => store.put(value));
}

function deleteDatabaseRecord(storeName, key) {
    if (!db) return Promise.resolve();
    return databaseRequest(storeName, 'readwrite', store => store.delete(key));
}

function getDatabaseRecordsByIndex(storeName, indexName, value) {
    if (!db) return Promise.resolve([]);
    return databaseRequest(storeName, 'readonly', store => store.index(indexName).getAll(value));
}

function getAllDatabaseRecords(storeName) {
    if (!db) return Promise.resolve([]);
    return databaseRequest(storeName, 'readonly', store => store.getAll());
}

function deleteDatabaseRecordsByPeerBefore(storeName, peerId, cutoff) {
    if (!db) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        const request = transaction.objectStore(storeName).index('peerId').openCursor(IDBKeyRange.only(peerId));
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if ((cursor.value.createdAt || 0) <= cutoff) cursor.delete();
            cursor.continue();
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
}

async function initializeStorageEncryption() {
    if (!db) return;
    try {
        const stored = await databaseRequest('keys', 'readonly', store => store.get('profile-cache'));
        if (stored?.key) {
            state.storageKey = stored.key;
            return;
        }
        const generatedKey = await window.crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
        try {
            await databaseRequest('keys', 'readwrite', store => store.add({
                id: 'profile-cache',
                key: generatedKey
            }));
            state.storageKey = generatedKey;
        } catch (error) {
            if (error?.name !== 'ConstraintError') throw error;
            const concurrentKey = await databaseRequest('keys', 'readonly', store => store.get('profile-cache'));
            if (!concurrentKey?.key) throw new Error('Concurrent profile cache key creation failed.');
            state.storageKey = concurrentKey.key;
        }
    } catch (error) {
        state.storageKey = null;
        console.error('Encrypted profile cache initialization failed.', error);
        showDebugToast('Encrypted profile cache is unavailable in this browser session.', 'warning');
    }
}

async function encryptStoredProfile(profile) {
    if (!state.storageKey) throw new Error('Profile storage encryption is unavailable.');
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        state.storageKey,
        new TextEncoder().encode(JSON.stringify(profile))
    );
    return {
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
}

async function decryptStoredProfile(record) {
    if (!state.storageKey || !record?.ciphertext || !record?.iv) return null;
    const plaintext = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: base64ToBytes(record.iv) },
        state.storageKey,
        base64ToBytes(record.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
}

async function cacheMedia(id, base64, version) {
    return cacheMediaPayload(id, { data: base64, version });
}

// Speichert beliebige Medien-Payloads (z. B. Album-Ciphertext) verschluesselt im Store `media`.
async function cacheMediaPayload(id, payload) {
    if (!state.storageKey) return false;
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        state.storageKey,
        new TextEncoder().encode(JSON.stringify(payload))
    );
    await putDatabaseRecord('media', { id, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) });
    return true;
}

async function loadMedia(id) {
    if (!db || !state.storageKey) return null;
    const record = await databaseRequest('media', 'readonly', store => store.get(id));
    if (!record?.ciphertext || !record?.iv) return null;
    try {
        const plaintext = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(record.iv) }, state.storageKey, base64ToBytes(record.ciphertext));
        return JSON.parse(new TextDecoder().decode(plaintext));
    } catch (e) { return null; }
}

async function loadMyLocalProfile() {
    let record = db
        ? await databaseRequest('localProfile', 'readonly', store => store.get('current'))
        : null;
    let migratedLegacyProfile = false;
    if (!record && db) {
        record = await databaseRequest('profiles', 'readonly', store => store.get(state.nodeId));
        migratedLegacyProfile = Boolean(record);
    }
    const cached = record ? await decryptStoredProfile(record).catch(() => null) : null;
    if (cached?.isMe) state.myProfile = cached;
    state.myProfile.id = state.nodeId;
    if (migratedLegacyProfile && cached?.isMe) {
        const persisted = await cacheOwnProfile();
        if (persisted) await deleteDatabaseRecord('profiles', state.nodeId);
    }
    renderProfileForm();
    return Boolean(cached?.isMe);
}

async function loadCachedGridPeers() {
    if (!db) {
        renderDiscoveryGrid();
        return;
    }
    const cachedProfiles = await databaseRequest('profiles', 'readonly', store => store.getAll());
    const decrypted = await Promise.all(cachedProfiles.map(async record => {
        const profile = await decryptStoredProfile(record).catch(() => null);
        return profile && !profile.isMe ? [record.id, profile] : null;
    }));
    state.cachedProfiles = Object.fromEntries(decrypted.filter(Boolean));
    state.peers = [];
    renderDiscoveryGrid();
}

async function cacheGridPeer(peer) {
    await putDatabaseRecord('gridPeers', {
        cacheKey: `${peer.geohash}:${peer.id}`,
        id: peer.id,
        geohash: peer.geohash,
        name: peer.name,
        avatar: peer.avatar,
        cachedAt: Date.now()
    });
}

async function removeCachedPeer(peerId, geohash) {
    if (peerId === state.myProfile.id) return;
    await deleteDatabaseRecord('gridPeers', `${geohash}:${peerId}`);
}

async function cachePeerProfile(peerId, profile) {
    const current = state.cachedProfiles[peerId];
    // Ein ueber den Swarm bezogenes Profil ist zwar signiert, sein
    // Schluessel aber unbestaetigt. Trifft spaeter dasselbe Profil
    // direkt und gepinnt ein, muss es den Eintrag auch bei gleicher
    // Version und gleichem Zeitstempel ersetzen duerfen.
    const isTrustUpgrade = current?.trustLevel === 'unpinned' && profile.trustLevel === 'trusted';
    // Match/Entmatchen aendert, was der Besitzer zeigt, ohne neue Version.
    const isAudienceChange = Boolean(current) && (current.audience || 'public') !== (profile.audience || 'public');
    if (!isTrustUpgrade && !isAudienceChange) {
        // Aktualisiere, wenn die Version höher ist ODER bei gleicher Version der Zeitstempel neuer ist (z.B. Avatar-Update)
        if (current && (current.version || 0) > (profile.version || 0)) return current;
        if (current && (current.version || 0) === (profile.version || 0) && (current.updatedAt || 0) >= (profile.updatedAt || 0)) return current;
    }

    if (state.storageKey) {
        const encrypted = await encryptStoredProfile(profile);
        await putDatabaseRecord('profiles', {
            id: peerId,
            geohash: state.myProfile.geohash,
            version: profile.version || 1,
            updatedAt: profile.updatedAt || Date.now(),
            ...encrypted
        });
    }
    state.cachedProfiles[peerId] = profile;
    return profile;
}

async function cacheOwnProfile() {
    if (!state.storageKey) return false;
    const encrypted = await encryptStoredProfile(state.myProfile);
    await putDatabaseRecord('localProfile', {
        slot: 'current',
        version: state.myProfile.version,
        updatedAt: state.myProfile.updatedAt,
        ...encrypted
    });
    return true;
}

// Nachrichten, deren Zustellung beim letzten Lauf nie bestaetigt wurde, gelten als ausstehend.
// Ihre Operation liegt im Log und wird beim naechsten Chat-Sync nachgeliefert.
const STALE_SENDING_MS = 15000;

async function loadChatHistory(peerId) {
    const messages = await getDatabaseRecordsByIndex('messages', 'peerId', peerId);
    await resolvePendingPolicyMessages(peerId, messages);
    const staleBefore = Date.now() - STALE_SENDING_MS;
    const staleMessages = messages.filter(message => message.deliveredVia === 'Establishing secure channel...'
        && (message.createdAt || 0) < staleBefore);
    staleMessages.forEach(message => {
        message.deliveredVia = 'Pending';
    });
    await Promise.all(staleMessages.map(message => persistChatMessage(peerId, message)));
    state.chats[peerId] = messages.sort((left, right) => left.createdAt - right.createdAt);
    const operations = await getChatOperations(peerId);
    const operationIds = new Set(operations.map(operation => operation.operationId));
    const missingOperations = messages
        .filter(message => !message.deleted && !operationIds.has(`put:${message.id}`))
        .map(message => createPutOperation(peerId, message));
    await Promise.all(missingOperations.map(persistChatOperation));
}

async function loadChatPeerIds() {
    const [messages, operations] = await Promise.all([
        getAllDatabaseRecords('messages'),
        getAllDatabaseRecords('chatOperations')
    ]);

    // Filtere geloeschte Nachrichten heraus, damit leere Chats nicht in der Liste auftauchen
    const activeMessages = messages.filter(m => !m.deleted);

    state.chatPreviews = {};
    activeMessages.forEach(message => updateChatPreview(message.peerId, message, false));
    // Vom Service Worker gespeicherte Erstnachrichten: Liste des Absenders nachtragen.
    for (const message of activeMessages) {
        if (message.senderId === message.peerId && CHAT_SCOPES.includes(message.scope) && !state.chatScopes[message.peerId]) {
            await setChatScope(message.peerId, message.scope);
        }
    }

    state.chatPeerIds = Array.from(new Set([
        ...activeMessages.map(message => message.peerId),
        ...Object.values(state.chatControls)
            .filter(control => control.blockedAt)

            .map(control => control.peerId)
    ].filter(Boolean)));
    if (typeof recountAllUnread === 'function') recountAllUnread(activeMessages);
    renderActivePeerList();
}

// Neue Chats (z. B. die erste Nachricht ueber den Router-Cache) haben oft noch kein Profil: es kommt
// nur ueber eine P2P-Sitzung (PROFILE_REQUEST). Statt auf den Klick aufs Profil zu warten, aktiv
// anfragen: direkt, sobald der Peer online ist (baut P2P auf), sonst ueber den Schwarm (andere offene
// Kanaele mit gecachtem, signiertem Profil). Je Weg hoechstens einmal pro Minute und Peer.
const PROFILE_REQUEST_INTERVAL_MS = 60 * 1000;

function requestMissingProfile(peerId) {
    if (!peerId || peerId === state.myProfile?.id || state.cachedProfiles?.[peerId] || isPeerBlocked(peerId)) return;
    const now = Date.now();
    const requests = state.profileRequests || (state.profileRequests = {});
    const last = requests[peerId] || { direct: 0, swarm: 0 };
    if (isPeerOnline(peerId) && now - last.direct >= PROFILE_REQUEST_INTERVAL_MS) {
        last.direct = now;
        logDebug(`Profil von ${peerId} fehlt, frage direkt an.`);
        const request = () => sendSecurePayload(peerId, { type: 'PROFILE_REQUEST' }).catch(logBackgroundError('requestMissingProfile'));
        // Fehlt beiden das Profil des anderen, wuerden beide gleichzeitig verbinden. Die hoefliche Seite
        // wartet kurz; steht dann schon eine Verbindung, kommt das Profil ohnehin beim Schluesselaustausch.
        if (typeof isPolitePeer === 'function' && isPolitePeer(peerId)) {
            setTimeout(() => {
                if (state.cachedProfiles?.[peerId]) return;
                if (hasConnectionInProgress(peerId)) return;
                request();
            }, 1500);
        } else {
            request();
        }
    }
    const swarmPeers = Object.keys(state.dataChannels || {})
        .filter(id => id !== peerId && state.dataChannels[id].readyState === 'open' && state.sessionKeys[id]);
    if (swarmPeers.length && now - last.swarm >= PROFILE_REQUEST_INTERVAL_MS) {
        last.swarm = now;
        swarmPeers.forEach(id => sendSecurePayload(id, { type: 'SWARM_PROFILE_REQUEST', targetNodeId: peerId })
            .catch(logBackgroundError('requestMissingProfile')));
    }
    requests[peerId] = last;
}

function rememberChatPeer(peerId) {
    if (!peerId || state.chatPeerIds.includes(peerId)) return;
    state.chatPeerIds.push(peerId);
    renderActivePeerList();
    subscribePresence();
    requestMissingProfile(peerId);
}

function getPeerPresentation(peerId) {
    const activePeer = state.peers.find(peer => peer.id === peerId);
    const profile = state.cachedProfiles[peerId];
    return activePeer || {
        id: peerId,
        name: profile?.fields?.displayName || `Peer ${peerId.slice(-8)}`,
        avatar: profile?.avatar || null,
        fullProfile: profile,
        offline: true
    };
}

function isPeerBlocked(peerId) {
    return Boolean(state.chatControls[peerId]?.blockedAt);
}

async function purgeChatBefore(peerId, cutoff) {
    await Promise.all([
        deleteDatabaseRecordsByPeerBefore('messages', peerId, cutoff),
        deleteDatabaseRecordsByPeerBefore('chatOperations', peerId, cutoff)
    ]);
    if (state.chats[peerId]) {
        state.chats[peerId] = state.chats[peerId].filter(message => message.createdAt > cutoff);
    }
}

async function applyChatControls(controls) {
    state.chatControls = Object.fromEntries(controls.map(control => [control.peerId, control]));
    for (const control of controls) {
        if (control.deletedBefore) await purgeChatBefore(control.peerId, control.deletedBefore);
        if (control.blockedAt) {
            state.secureMessageQueues[control.peerId] = [];
            const connection = state.webrtcConnections[control.peerId];
            if (connection) cleanupPeerConnection(control.peerId, connection);
        }
    }
    await loadChatPeerIds();
    renderDiscoveryGrid();
    if (typeof renderBlockedPeers === 'function') renderBlockedPeers();
    if (state.activeChatPeerId) {
        updateChatActionButtons();
        renderChatHistory();
    }
}

async function refreshChatControls() {
    const response = await fetch(
        `${API_BASE}/api/chat-controls/${encodeURIComponent(state.myProfile.id)}`,
        { cache: 'no-store', headers: peerAuthHeaders() }
    );
    if (!response.ok) throw new Error(`Chat control API returned ${response.status}.`);
    const { controls = [] } = await response.json();
    await applyChatControls(controls);
}

async function storeChatControl(peerId, action) {
    const response = await fetch(`${API_BASE}/api/chat-controls`, {
        method: 'POST',
        headers: peerAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            ownerId: state.myProfile.id,
            peerId,
            action
        })
    });
    if (!response.ok) throw new Error(`Chat control API returned ${response.status}.`);
    await refreshChatControls();
    // Blockierte Peers sehen den Status nicht mehr (und umgekehrt).
    subscribePresence();
}

function persistChatMessage(peerId, message) {
    updateChatPreview(peerId, message);
    return putDatabaseRecord('messages', { ...message, peerId });
}

// Merkt sich die neueste sichtbare Nachricht pro Chat (zurueckgehaltene zaehlen nicht).
function updateChatPreview(peerId, message, render = true) {
    if (!peerId || !message || message.held) return;
    const current = state.chatPreviews[peerId];
    const at = message.createdAt || 0;
    if (current && current.id !== message.id && current.at > at) return;
    state.chatPreviews[peerId] = {
        id: message.id,
        at,
        mine: message.senderId === state.myProfile.id,
        text: message.deleted ? t('common.messageDeleted') : messagePreview(message)
    };
    if (render) renderActivePeerList();
}

function getChatOperations(peerId) {
    return getDatabaseRecordsByIndex('chatOperations', 'peerId', peerId)
        .then(operations => operations.sort((left, right) => right.createdAt - left.createdAt));
}

function persistChatOperation(operation) {
    return putDatabaseRecord('chatOperations', operation);
}

async function getPeerIdentity(peerId) {
    if (state.peerIdentityKeys[peerId]) return state.peerIdentityKeys[peerId];
    const record = db
        ? await databaseRequest('keys', 'readonly', store => store.get(`peer-identity:${peerId}`))
        : null;
    if (record?.jwkPublic) state.peerIdentityKeys[peerId] = record;
    return record || null;
}

async function getPeerIdentityKey(peerId) {
    return (await getPeerIdentity(peerId))?.jwkPublic || null;
}

async function persistPeerIdentityKey(peerId, jwkPublic, profileSigningKey) {
    const identity = {
        id: `peer-identity:${peerId}`,
        jwkPublic,
        profileSigningKey
    };
    state.peerIdentityKeys[peerId] = identity;
    await putDatabaseRecord('keys', identity);
}

const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const REPLY_PREVIEW_LENGTH = 80;
const ALBUM_COVER_MAX_LENGTH = 30000;

function sanitizeReplyReference(replyTo) {
    if (!replyTo || typeof replyTo.messageId !== 'string' || typeof replyTo.senderId !== 'string') return undefined;
    return {
        messageId: replyTo.messageId.substring(0, 200),
        senderId: replyTo.senderId.substring(0, 200),
        preview: String(replyTo.preview || '').substring(0, REPLY_PREVIEW_LENGTH + 3)
    };
}

// Album-Verweis in einer Chat-Nachricht: nur der Absender kann eigene Alben teilen.
function sanitizeAlbumReference(album, senderId) {
    if (!album || typeof album.albumId !== 'string' || album.ownerId !== senderId) return undefined;
    return {
        albumId: album.albumId.substring(0, 200),
        ownerId: senderId,
        name: String(album.name || 'Album').substring(0, 80),
        cover: isSafeInlineImage(album.cover) && album.cover.length <= ALBUM_COVER_MAX_LENGTH ? album.cover : undefined,
        count: Number.isInteger(album.count) ? Math.max(0, Math.min(album.count, 999)) : undefined,
        limit: sanitizeAlbumLimit(album.limit)
    };
}

// Begrenzung eines geteilten Albums (Anzeige auf der Karte; durchgesetzt wird beim Besitzer).
function sanitizeAlbumLimit(limit) {
    if (limit?.kind === 'views' && [1, 2, 3].includes(limit.views)) return { kind: 'views', views: limit.views };
    if (limit?.kind === 'time' && Number.isFinite(limit.until) && limit.until > 0) return { kind: 'time', until: limit.until };
    return undefined;
}

function sanitizeSecureSnap(snap) {
    if (!snap || typeof snap.snapId !== 'string' || snap.snapId.length > 100) return undefined;
    const encrypted = snap.encrypted;
    if (typeof encrypted?.iv !== 'string' || typeof encrypted?.ciphertext !== 'string'
        || encrypted.iv.length > 40 || encrypted.ciphertext.length > 120000) return undefined;
    return {
        snapId: snap.snapId,
        views: [1, 2, 3].includes(snap.views) ? snap.views : 1,
        seconds: [5, 10, 30, 0].includes(snap.seconds) ? snap.seconds : 10,
        encrypted: { iv: encrypted.iv, ciphertext: encrypted.ciphertext }
    };
}

// Bildgroesse einer Nachricht ({ w, h }), damit der Platz vor dem Zeichnen reserviert werden kann.
function isValidImageSize(size) {
    return Boolean(size) && Number.isInteger(size.w) && Number.isInteger(size.h) && size.w > 0 && size.h > 0 && size.w <= 10000 && size.h <= 10000;
}

// Originale: Bilder (Standard), Videos (video.js) und der zweite Teil langer Sprachnachrichten (voice.js).
const ORIGINAL_MEDIA_MIME_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg', 'audio/webm', 'audio/ogg', 'audio/mp4'];

function sanitizeOriginalMeta(original) {
    if (!original || !Number.isInteger(original.size) || typeof original.sha256 !== 'string') return undefined;
    const mime = ORIGINAL_MEDIA_MIME_TYPES.includes(original.mime) ? original.mime : 'image/jpeg';
    return { size: original.size, sha256: original.sha256.substring(0, 64), mime };
}

function createPutOperation(peerId, message) {
    return {
        operationId: `put:${message.id}`,
        peerId,
        type: 'MESSAGE_PUT',
        messageId: message.id,
        actorId: message.senderId,
        createdAt: message.createdAt,
        message: {
            id: message.id,
            senderId: message.senderId,
            text: message.text,
            snapData: message.snapData,
            snapMode: message.snapMode,
            snapExpiry: message.snapExpiry,
            album: message.album,
            secureSnap: message.secureSnap ? {
                snapId: message.secureSnap.snapId,
                views: message.secureSnap.views,
                seconds: message.secureSnap.seconds,
                encrypted: message.secureSnap.encrypted
            } : undefined,
            replyTo: message.replyTo,
            original: message.original,
            imageSize: message.imageSize,
            audioData: message.audioData,
            audioDuration: message.audioDuration,
            audioSplitAt: message.audioSplitAt,
            transcript: message.transcript,
            video: message.video,
            downloadable: message.downloadable,
            scope: message.scope,
            timestamp: message.timestamp,
            createdAt: message.createdAt
        }
    };
}

async function applyChatOperation(peerId, operation, deliveredVia = 'E2EE P2P') {
    if (!operation?.operationId) return false;
    const control = state.chatControls[peerId];
    if (control?.blockedAt || (control?.deletedBefore && (operation.createdAt || 0) <= control.deletedBefore)) {
        return false;
    }
    const localOperation = { ...operation, peerId };
    const existingOperation = await databaseRequest(
        'chatOperations',
        'readonly',
        store => store.get(localOperation.operationId)
    );
    if (existingOperation) return false;

    if (localOperation.type === 'MESSAGE_PUT' && localOperation.message) {
        if (localOperation.message.senderId !== localOperation.actorId) return false;
        const existingMessage = await databaseRequest(
            'messages',
            'readonly',
            store => store.get(localOperation.messageId)
        );
        if (!existingMessage?.deleted) {
            const message = {
                ...localOperation.message,
                replyTo: sanitizeReplyReference(localOperation.message.replyTo),
                album: sanitizeAlbumReference(localOperation.message.album, localOperation.actorId),
                secureSnap: sanitizeSecureSnap(localOperation.message.secureSnap),
                original: sanitizeOriginalMeta(localOperation.message.original),
                imageSize: isValidImageSize(localOperation.message.imageSize)
                    ? { w: localOperation.message.imageSize.w, h: localOperation.message.imageSize.h } : undefined,
                // Ein Secure Snap darf nie zusaetzlich als Klartext-Snap ankommen.
                snapData: localOperation.message.secureSnap ? undefined : localOperation.message.snapData,
                snapMode: localOperation.message.snapMode === 'replay' ? 'replay' : undefined,
                downloadable: ['friends', 'all', 'none'].includes(localOperation.message.downloadable) ? localOperation.message.downloadable : undefined,
                snapExpiry: localOperation.message.snapMode === 'replay' && ['15m', '30m', '60m', 'off'].includes(localOperation.message.snapExpiry)
                    ? localOperation.message.snapExpiry : undefined,
                peerId,
                deliveredVia
            };
            // Chat-Berechtigungen: ohne Match ggf. zurueckhalten (wird beim Match freigegeben).
            if (await shouldHoldIncomingMessage(peerId, message)) message.held = true;
            // Original folgt nur ueber P2P: anfragen, sobald ein Kanal offen ist.
            if (message.original && message.senderId === peerId && typeof requestMissingOriginals === 'function') {
                setTimeout(() => requestMissingOriginals(peerId).catch(logBackgroundError('applyChatOperation')), 0);
            }
            // Liste des Absenders (Grid & Event oder Chat & Freunde), wenn der Chat noch keine hat.
            if (message.senderId === peerId && CHAT_SCOPES.includes(message.scope)) await ensureChatScope(peerId, message.scope);
            else if (message.senderId !== peerId) await ensureChatScope(peerId, currentChatScope());
            await persistChatMessage(peerId, message);
            if (!state.chats[peerId]) state.chats[peerId] = [];
            const index = state.chats[peerId].findIndex(item => item.id === message.id);
            if (index >= 0) state.chats[peerId][index] = message;
            else state.chats[peerId].push(message);
        }
    } else if (localOperation.type === 'MESSAGE_DELETE') {
        const existingMessage = await databaseRequest(
            'messages',
            'readonly',
            store => store.get(localOperation.messageId)
        );
        const originalSenderId = existingMessage?.senderId || localOperation.originalSenderId;
        if (!originalSenderId || originalSenderId !== localOperation.actorId) return false;
        const deletedMessage = {
            id: localOperation.messageId,
            peerId,
            senderId: originalSenderId,
            text: '',
            timestamp: existingMessage?.timestamp || localOperation.timestamp || '',
            createdAt: existingMessage?.createdAt || localOperation.messageCreatedAt || localOperation.createdAt,
            deleted: true,
            deletedAt: localOperation.createdAt,
            deliveredVia: 'Deleted'
        };
        await persistChatMessage(peerId, deletedMessage);
        if (!state.chats[peerId]) state.chats[peerId] = [];
        const index = state.chats[peerId].findIndex(item => item.id === localOperation.messageId);
        if (index >= 0) state.chats[peerId][index] = deletedMessage;
        else state.chats[peerId].push(deletedMessage);
    } else if (localOperation.type === 'STATUS_POST' || localOperation.type === 'STATUS_DELETE') {
        // Status gehoeren nicht ins Chat-Log (wie Album-Schluessel).
        return handleStatusOperation(peerId, localOperation);
    } else if (localOperation.type === 'ALBUM_REVOKE') {
        // Entzug durch den Besitzer (auch ueber Pfad C): Album, Bilder und Schluessel weg.
        if (localOperation.actorId !== peerId) return false;
        await forgetReceivedAlbum(peerId, localOperation.albumId);
        return true;
    } else if (localOperation.type === 'ALBUM_VIEW_CLOSED') {
        // Betrachter hat eine begrenzte Ansicht beendet (auch ueber Pfad C). Nicht im Log.
        if (localOperation.actorId !== peerId) return false;
        await handleAlbumViewClosed(peerId, { albumId: localOperation.albumId });
        return true;
    } else if (localOperation.type === 'ALBUM_KEYS') {
        // Schluessel-Buendel werden separat gespeichert und nicht im Operations-Log synchronisiert.
        if (localOperation.actorId !== peerId) return false;
        return handleAlbumKeysOperation(peerId, localOperation);
    } else if (localOperation.type === 'SNAP_CONSUMED') {
        // Nur der Empfaenger eines eigenen Einmal-Snaps darf ihn als verbraucht melden.
        if (localOperation.actorId !== peerId) return false;
        const ownMessage = await databaseRequest('messages', 'readonly', store => store.get(localOperation.messageId));
        if (!ownMessage || ownMessage.peerId !== peerId || ownMessage.senderId !== state.myProfile.id
            || ownMessage.snapMode !== 'replay') return false;
        const loaded = state.chats[peerId]?.find(item => item.id === ownMessage.id);
        const target = loaded || ownMessage;
        target.snapConsumed = true;
        if (!target.snapSaved) {
            // Eigene Frist: der Absender behaelt den Snap noch eine Weile (ansehen, speichern).
            const keepMs = typeof ownSnapKeepMs === 'function' ? ownSnapKeepMs() : 0;
            if (keepMs) {
                target.ownKeepUntil = target.ownKeepUntil || Date.now() + keepMs;
            } else {
                target.snapData = undefined;
                await removeSnapFromOperation(target.id);
            }
        }
        await persistChatMessage(peerId, target);
        if (typeof scheduleReplaySnapExpiry === 'function') scheduleReplaySnapExpiry(peerId);
    } else if (localOperation.type === 'SNAP_SAVED') {
        // Der Empfaenger meldet: er hat meinen Snap gespeichert.
        if (localOperation.actorId !== peerId) return false;
        const ownMessage = await databaseRequest('messages', 'readonly', store => store.get(localOperation.messageId));
        if (!ownMessage || ownMessage.peerId !== peerId || ownMessage.senderId !== state.myProfile.id || !ownMessage.snapMode) return false;
        const target = state.chats[peerId]?.find(item => item.id === ownMessage.id) || ownMessage;
        target.savedByPeer = true;
        await persistChatMessage(peerId, target);
        showToast(t('app.savedYourSnap', { name: getPeerPresentation(peerId).name || t('app.someone') }), 'info');
    } else if (localOperation.type === 'MATCH_PING' || localOperation.type === 'MATCH_RESET') {
        if (!await applyMatchOperation(peerId, localOperation)) return false;
    } else if (localOperation.type === 'FRIEND_PING' || localOperation.type === 'FRIEND_RESET') {
        if (!await applyFriendOperation(peerId, localOperation)) return false;
    } else if (localOperation.type === 'MESSAGE_REACT') {
        // Pro Absender gilt die neueste Reaktion; null entfernt sie.
        const emoji = localOperation.emoji === null ? null : localOperation.emoji;
        if (emoji !== null && !REACTION_EMOJIS.includes(emoji)) return false;
        if (typeof localOperation.actorId !== 'string') return false;
        const existingMessage = await databaseRequest(
            'messages',
            'readonly',
            store => store.get(localOperation.messageId)
        );
        if (!existingMessage || existingMessage.deleted || existingMessage.peerId !== peerId) return false;
        const current = existingMessage.reactions?.[localOperation.actorId];
        if (!current || (current.at || 0) < (localOperation.createdAt || 0)) {
            const reactions = { ...(existingMessage.reactions || {}) };
            if (emoji) reactions[localOperation.actorId] = { emoji, at: localOperation.createdAt || 0 };
            else delete reactions[localOperation.actorId];
            const updated = { ...existingMessage, reactions };
            await persistChatMessage(peerId, updated);
            const index = (state.chats[peerId] || []).findIndex(item => item.id === updated.id);
            // Objekt mutieren statt ersetzen: offene Sende-Callbacks halten dieselbe Referenz.
            if (index >= 0) state.chats[peerId][index].reactions = reactions;
        }
    } else if (localOperation.type === 'CHAT_WIPE') {
        if (localOperation.actorId !== peerId) return false;
        // Derselbe Wipe kommt oft zweimal (direkt und ueber Path C). Ein spaeter Doppelgaenger wuerde
        // sonst auch die seither geschriebenen Nachrichten loeschen.
        if (typeof localOperation.operationId !== 'string') return false;
        const appliedWipes = JSON.parse(localStorage.getItem('appliedChatWipes') || '[]');
        if (appliedWipes.includes(localOperation.operationId)) return true;
        localStorage.setItem('appliedChatWipes', JSON.stringify([...appliedWipes, localOperation.operationId].slice(-100)));
        await storeChatControl(peerId, 'DELETE_CHAT');

        if (localOperation.hidePeer) {
            const hidden = JSON.parse(localStorage.getItem('hiddenByPeers') || '[]');
            if (!hidden.includes(peerId)) {
                hidden.push(peerId);
                localStorage.setItem('hiddenByPeers', JSON.stringify(hidden));
            }
            renderDiscoveryGrid();
        }

        if (state.activeChatPeerId === peerId) {
            resetActiveChat('Der Chat wurde vom Chat-Partner geloescht.');
        }
        showToast(t('app.chatPartnerDeletedChatHistory'), 'info');
        return true; // Return true, damit der Wipe nicht als endloser Sync gespeichert wird
    } else if (localOperation.type === 'PEER_UNHIDE') {
        if (localOperation.actorId !== peerId) return false;
        const hidden = JSON.parse(localStorage.getItem('hiddenByPeers') || '[]');
        const updated = hidden.filter(id => id !== peerId);
        localStorage.setItem('hiddenByPeers', JSON.stringify(updated));
        renderDiscoveryGrid();
        return true; // Return true, um den Wipe nicht als dauerhafte Sync-Operation in die DB zu legen
    } else {
        return false;
    }

    await persistChatOperation(localOperation);
    if (localOperation.type === 'MESSAGE_DELETE') await trimChatDeleteOperations(peerId);
    if (localOperation.type === 'MESSAGE_REACT') await trimReactionOperations(peerId, localOperation);
    if (!state.chats[peerId]) state.chats[peerId] = [];
    state.chats[peerId].sort((left, right) => left.createdAt - right.createdAt);
    rememberChatPeer(peerId);
    if (state.activeChatPeerId === peerId) renderChatHistory();
    if (typeof refreshUnread === 'function') refreshUnread(peerId).catch(logBackgroundError('applyChatOperation'));
    return true;
}

// Aeltere Reaktionen desselben Absenders auf dieselbe Nachricht werden fuer den Sync nicht mehr gebraucht.
async function trimReactionOperations(peerId, latest) {
    const outdated = (await getChatOperations(peerId)).filter(operation => operation.type === 'MESSAGE_REACT'
        && operation.messageId === latest.messageId
        && operation.actorId === latest.actorId
        && operation.operationId !== latest.operationId
        && (operation.createdAt || 0) <= (latest.createdAt || 0));
    await Promise.all(outdated.map(operation => deleteDatabaseRecord('chatOperations', operation.operationId)));
}

// Abgelaufene Einmal-Snaps auch aus dem Operations-Log entfernen, sonst laege das Bild dort weiter.
async function removeSnapFromOperation(messageId) {
    const operation = await databaseRequest('chatOperations', 'readonly', store => store.get(`put:${messageId}`));
    if (!operation?.message?.snapData) return;
    operation.message = { ...operation.message, snapData: undefined };
    await persistChatOperation(operation);
}

// Taucht eine eigene Put-Operation im Inventar des Peers auf, hat er die Nachricht sicher erhalten.
async function confirmDeliveredOperations(peerId, operationIds) {
    const messageIds = operationIds
        .filter(operationId => typeof operationId === 'string' && operationId.startsWith('put:'))
        .map(operationId => operationId.slice(4));
    for (const messageId of messageIds) {
        const stored = await databaseRequest('messages', 'readonly', store => store.get(messageId));
        if (!stored || stored.peerId !== peerId || stored.senderId !== state.myProfile.id || stored.deliveryConfirmed) continue;
        const loaded = state.chats[peerId]?.find(item => item.id === messageId);
        if (loaded) loaded.deliveryConfirmed = true;
        await persistChatMessage(peerId, { ...stored, ...(loaded || {}), deliveryConfirmed: true });
    }
    if (state.activeChatPeerId === peerId && messageIds.length) renderChatHistory();
}

async function trimChatDeleteOperations(peerId) {
    const deleteOperations = (await getChatOperations(peerId))
        .filter(operation => operation.type === 'MESSAGE_DELETE');
    await Promise.all(
        deleteOperations.slice(100).map(operation => {
            return deleteDatabaseRecord('chatOperations', operation.operationId);
        })
    );
}

// ================= SPEICHERPLATZ =================
const STORAGE_WARNING_RATIO = 0.8;

// Bittet den Browser, die Daten nicht bei Platzmangel zu loeschen (Chats, Schluessel, Medien).
async function requestPersistentStorage() {
    try {
        if (navigator.storage?.persisted && !await navigator.storage.persisted()) await navigator.storage.persist();
    } catch (error) {
        logDebug(`Persistent storage request failed: ${error.message}`);
    }
}

async function renderStorageUsage(warn = false) {
    const output = document.getElementById('storage-usage');
    if (!navigator.storage?.estimate) {
        if (output) output.textContent = t('app.thisBrowserDoesNotReport');
        return;
    }
    try {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        const persisted = await navigator.storage.persisted?.().catch(() => false);
        const ratio = quota ? usage / quota : 0;
        const megabytes = value => (value / (1024 * 1024)).toFixed(1);
        if (output) {
            output.textContent = t('app.mbOfMbUsed', { value: megabytes(usage), value2: megabytes(quota), value3: Math.round(ratio * 100) })
                + (persisted ? t('app.storedPermanently') : t('app.mayBeClearedByBrowser'));
            output.classList.toggle('text-amber-400', ratio >= STORAGE_WARNING_RATIO);
        }
        if (warn && ratio >= STORAGE_WARNING_RATIO) {
            showToast(t('app.storageIsAlmostFullYou'), 'warning');
        }
    } catch (error) {
        logDebug(`Storage estimate failed: ${error.message}`);
    }
}

// IDs aller Medien, die noch gebraucht werden. Alles andere im Store `media` kann weg.
async function collectReferencedMediaIds() {
    const referenced = new Set((state.myProfile.gallery || []).map(item => item.id));
    Object.values(state.cachedProfiles).forEach(profile => (profile.gallery || []).forEach(item => referenced.add(item.id)));
    Object.values(state.albums).forEach(album => (album.items || []).forEach(item => referenced.add(item.id)));
    // Schluessel noch offener Secure Snaps des Senders.
    const messages = await getAllDatabaseRecords('messages').catch(() => []);
    messages.forEach(message => {
        if (message.secureSnap?.snapId && message.secureSnap.encrypted) referenced.add(`ssnap_${message.secureSnap.snapId}`);
        if (message.original && !message.deleted) referenced.add(`orig_${message.id}`);
    });
    return referenced;
}

async function cleanupUnusedMedia() {
    const button = document.getElementById('storage-cleanup-btn');
    if (button) button.disabled = true;
    try {
        const referenced = await collectReferencedMediaIds();
        const keys = await databaseRequest('media', 'readonly', store => store.getAllKeys());
        const unused = keys.filter(key => !referenced.has(key));
        await Promise.all(unused.map(key => deleteDatabaseRecord('media', key)));
        showToast(unused.length ? t('app.removedMediaFilesThatWere', { length: unused.length }) : t('app.nothingToCleanUp'), 'success');
        await renderStorageUsage();
    } catch (error) {
        showToast(t('app.cleanUpFailed', { message: error.message }), 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

