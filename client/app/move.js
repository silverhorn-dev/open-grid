// ================= SIGNIERTER UMZUG (Board T31, Phase 3) =================
// Die privaten Identitaetsschluessel sind non-extractable und koennen nicht mit. Darum:
//   1. Beim Export signiert die alte Kopie mit ihrem Identitaets-Signaturschluessel eine Vollmacht fuer einen
//      frischen Delegations-Schluessel D: "D darf meinen Umzug verkuenden" (30 Tage gueltig). D (privat)
//      reist verschluesselt im Buendel mit.
//   2. Das neue Geraet signiert mit D "<alte ID> ist jetzt <neue ID> mit diesen Schluesseln" und schickt
//      beides E2E an alle Kontakte und an die alte ID (P2P, sonst Pfad C).
//   3. Kontakte pruefen die Vollmacht gegen den gepinnten Schluessel der alten ID und die Ansage gegen D,
//      dazu passen die Schluessel der Ansage zum tatsaechlichen Absender. Dann ziehen sie alles, was an der
//      alten ID haengt (Chat, Freundschaft, Match, Alben, Profil), auf die neue ID um.
//   4. Die alte Kopie sperrt sich, wenn sie die Ansage bekommt: nur noch lesen, kein Senden, kein Signaling.
// Der Router sieht dabei nur normales E2E-Chiffrat mit Routing-IDs.
const MOVE_DELEGATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MOVED_AWAY_RECORD_ID = 'moved-away';
const TRANSFER_IMPORTED_RECORD_ID = 'transfer-imported';
const MOVE_KEY_PATHS = {
    localProfile: 'slot', profiles: 'id', gridPeers: 'cacheKey', messages: 'id', chatOperations: 'operationId',
    keys: 'id', media: 'id', albums: 'id', statusUpdates: 'id'
};
const MOVE_ECDSA = { name: 'ECDSA', hash: 'SHA-256' };

// ----- Signaturen ueber den exakten Text (keine Kanonisierung noetig) -----
async function signMoveText(text, privateKey) {
    const signature = await window.crypto.subtle.sign(MOVE_ECDSA, privateKey, new TextEncoder().encode(text));
    return bytesToBase64(new Uint8Array(signature));
}

async function verifyMoveText(text, signature, publicJwk) {
    try {
        const key = await window.crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        return await window.crypto.subtle.verify(MOVE_ECDSA, key, base64ToBytes(signature), new TextEncoder().encode(text));
    } catch {
        return false;
    }
}

// ----- 1. Alte Kopie: Vollmacht beim Export -----
async function createMoveDelegation() {
    if (!state.myKeys?.ecdsaKeyPair?.privateKey) return null;
    const delegate = await window.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const now = Date.now();
    const delegation = JSON.stringify({
        type: 'opengrid-move-delegation',
        from: state.myProfile.id,
        delegate: await window.crypto.subtle.exportKey('jwk', delegate.publicKey),
        createdAt: now,
        expiresAt: now + MOVE_DELEGATION_TTL_MS
    });
    return {
        delegation,
        delegationSignature: await signMoveText(delegation, state.myKeys.ecdsaKeyPair.privateKey),
        delegatePrivate: await window.crypto.subtle.exportKey('jwk', delegate.privateKey)
    };
}

// Eigene Sperren (beim Router unter der alten ID) muessen unter der neuen ID neu gesetzt werden.
function blockedPeerIds() {
    return Object.keys(state.chatControls || {}).filter(peerId => state.chatControls[peerId]?.blockedAt);
}

// ----- 2. Neues Geraet: Umzug verkuenden (nach dem Start, bis alle erreicht sind) -----
async function moveContacts(oldId) {
    const identities = await getAllDatabaseRecords('keys').catch(() => []);
    const ids = new Set([
        ...identities.filter(record => String(record.id).startsWith('peer-identity:')).map(record => record.id.slice('peer-identity:'.length)),
        ...(state.chatPeerIds || []),
        ...Object.keys(state.friendState || {})
    ]);
    ids.delete(state.myProfile.id);
    ids.delete(oldId);
    // Die alte Kopie bekommt die Ansage auch: daran erkennt sie, dass sie sich sperren soll.
    return [...ids, oldId];
}

async function finishTransferMove() {
    const record = await databaseRequest('keys', 'readonly', store => store.get(TRANSFER_IMPORTED_RECORD_ID)).catch(() => null);
    if (!record?.move || record.done) return;
    if (!record.blocksApplied) {
        for (const peerId of record.blocked || []) await storeChatControl(peerId, 'block').catch(logBackgroundError('finishTransferMove'));
        record.blocksApplied = true;
    }
    if (!record.announcement) {
        record.announcement = JSON.stringify({
            type: 'opengrid-move',
            from: record.from,
            to: state.myProfile.id,
            keys: { jwkPublic: state.myKeys.jwkPublic, jwkEcdsaPublic: state.myKeys.jwkEcdsaPublic },
            at: Date.now()
        });
        const delegateKey = await window.crypto.subtle.importKey('jwk', record.move.delegatePrivate, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        record.announcementSignature = await signMoveText(record.announcement, delegateKey);
        record.pending = await moveContacts(record.from);
    }
    await putDatabaseRecord('keys', record);
    const payload = {
        type: 'MOVE_ANNOUNCE',
        delegation: record.move.delegation,
        delegationSignature: record.move.delegationSignature,
        announcement: record.announcement,
        announcementSignature: record.announcementSignature
    };
    for (const peerId of [...record.pending]) {
        sendSecurePayload(peerId, payload, via => {
            if (!['p2p', 'cache', 'rejected'].includes(via)) return;
            markMoveDelivered(peerId).catch(logBackgroundError('finishTransferMove'));
        }).catch(logBackgroundError('finishTransferMove'));
    }
}

async function markMoveDelivered(peerId) {
    const record = await databaseRequest('keys', 'readonly', store => store.get(TRANSFER_IMPORTED_RECORD_ID)).catch(() => null);
    if (!record?.pending) return;
    record.pending = record.pending.filter(id => id !== peerId);
    if (!record.pending.length) {
        record.done = true;
        // Der Delegations-Schluessel wird nicht mehr gebraucht.
        delete record.move.delegatePrivate;
    }
    await putDatabaseRecord('keys', record);
}

// ----- 3. Kontakt (oder alte Kopie): Ansage pruefen und umziehen -----
async function handleMoveAnnouncement(senderId, payload, senderPublicKey = null) {
    let delegation;
    let announcement;
    try {
        delegation = JSON.parse(payload.delegation);
        announcement = JSON.parse(payload.announcement);
    } catch {
        return false;
    }
    if (delegation?.type !== 'opengrid-move-delegation' || announcement?.type !== 'opengrid-move') return false;
    if (announcement.to !== senderId || announcement.from !== delegation.from || announcement.from === senderId) return false;
    if (!(Number(delegation.expiresAt) > Date.now())) return false;
    const keys = announcement.keys || {};
    // Die angesagten Schluessel muessen die sein, mit denen der Absender wirklich spricht.
    const senderKey = senderPublicKey || (await getPeerIdentity(senderId))?.jwkPublic;
    if (!senderKey || !keys.jwkPublic || !publicKeysMatch(senderKey, keys.jwkPublic)) return false;
    const pinnedSigning = (await getPeerIdentity(senderId))?.profileSigningKey;
    if (pinnedSigning && !publicJwksMatch(pinnedSigning, keys.jwkEcdsaPublic)) return false;
    const fromIsMe = announcement.from === state.myProfile.id;
    const oldSigningKey = fromIsMe ? state.myKeys?.jwkEcdsaPublic : (await getPeerIdentity(announcement.from))?.profileSigningKey;
    // Unbekannte alte ID: nichts umzuziehen (und keine Vollmacht pruefbar).
    if (!oldSigningKey) return false;
    if (!await verifyMoveText(payload.delegation, payload.delegationSignature, oldSigningKey)) return false;
    if (!await verifyMoveText(payload.announcement, payload.announcementSignature, delegation.delegate)) return false;
    if (fromIsMe) {
        await lockAsMovedAway(announcement.to);
        return true;
    }
    // Gesperrte alte ID bleibt gesperrt, auch unter der neuen.
    if (isPeerBlocked(announcement.from)) {
        await storeChatControl(senderId, 'block').catch(logBackgroundError('handleMoveAnnouncement'));
        return true;
    }
    const name = state.cachedProfiles?.[announcement.from]?.fields?.displayName || '';
    await renamePeerLocally(announcement.from, senderId);
    await persistPeerIdentityKey(senderId, keys.jwkPublic, keys.jwkEcdsaPublic);
    showToast(name ? t('move.contactMovedNamed', { name }) : t('move.contactMoved'), 'info');
    scheduleMoveReload();
    return true;
}

// Alles, was die alte ID enthaelt, auf die neue umschreiben (versiegelte Datensaetze dafuer entsiegeln).
async function renamePeerLocally(oldId, newId) {
    for (const storeName of Object.keys(MOVE_KEY_PATHS)) {
        const keyPath = MOVE_KEY_PATHS[storeName];
        const records = await getAllDatabaseRecords(storeName).catch(() => []);
        for (const record of records) {
            if (storeName === 'keys' && containsCryptoKey(record)) continue;
            const plain = await unsealTransferRecord(storeName, record);
            if (!plain || !JSON.stringify(plain).includes(oldId)) continue;
            if (storeName === 'gridPeers') {
                await deleteDatabaseRecord(storeName, record[keyPath]);
                continue;
            }
            const renamed = await resealTransferRecord(storeName, rewriteTransferIds(plain, oldId, newId));
            if (renamed[keyPath] !== record[keyPath]) await deleteDatabaseRecord(storeName, record[keyPath]);
            await putDatabaseRecord(storeName, renamed);
        }
    }
    for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        const value = key ? window.localStorage.getItem(key) : null;
        if (value && value.includes(oldId) && key !== 'opengrid-node-id') window.localStorage.setItem(key, value.split(oldId).join(newId));
    }
    delete state.peerIdentityKeys?.[oldId];
}

// Neu laden, damit alles aus dem umgeschriebenen Speicher kommt; nicht mitten im Tippen.
function scheduleMoveReload() {
    if (state.moveReloadScheduled) return;
    state.moveReloadScheduled = true;
    const reload = () => window.location.reload();
    setTimeout(() => {
        const typing = document.activeElement?.matches?.('input, textarea') && document.activeElement.value;
        if (!typing || document.hidden) reload();
        else document.addEventListener('visibilitychange', () => document.hidden && reload(), { once: true });
    }, 1500);
}

// ----- 4. Alte Kopie: gesperrt, nur lesen -----
async function lockAsMovedAway(newId) {
    await putDatabaseRecord('keys', { id: MOVED_AWAY_RECORD_ID, to: newId, at: Date.now() });
    applyMovedAway(true);
}

async function loadMovedAway() {
    const record = await databaseRequest('keys', 'readonly', store => store.get(MOVED_AWAY_RECORD_ID)).catch(() => null);
    if (record?.to) applyMovedAway(false);
}

function applyMovedAway(fresh) {
    state.movedAway = true;
    try {
        state.ws?.close();
    } catch {
        // Schon zu.
    }
    Object.keys(state.webrtcConnections || {}).forEach(peerId => {
        try {
            cleanupPeerConnection(peerId, state.webrtcConnections[peerId]);
        } catch {
            // Egal, die Kopie ist gesperrt.
        }
    });
    document.getElementById('moved-away-bar')?.classList.remove('hidden');
    if (fresh || !state.movedAwayNoticeSeen) document.getElementById('moved-away-modal')?.classList.remove('hidden');
}

function dismissMovedAwayNotice() {
    state.movedAwayNoticeSeen = true;
    document.getElementById('moved-away-modal')?.classList.add('hidden');
}

// Nach dem Start: erst ansagen, wenn das Signaling steht (sonst kein P2P-Aufbau, Pfad C geht trotzdem).
async function finishTransferMoveWhenOnline() {
    if (state.movedAway) return;
    const startedAt = Date.now();
    while (state.ws?.readyState !== WebSocket.OPEN && Date.now() - startedAt < 10000) {
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    await finishTransferMove();
}
