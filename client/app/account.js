// ================= PROFIL LOESCHEN =================
// Der Nutzer loescht sein Profil: alle Kontakte (Chats, Freunde, Matches) bekommen die Chat-Operation
// PROFILE_DELETED (direkt, wenn verbunden, und immer ueber Pfad C, damit sie auch offline ankommt). Dann
// loescht der Router alles zu diesem Peer (DELETE /api/account; die eben verschickten Hinweise bleiben
// bis zur Abholung), danach das Geraet (IndexedDB, localStorage, Caches) und die App startet neu.
//
// Beim Kontakt: Verlauf, Bilder, Alben, Status und das gespeicherte Profil verschwinden; der Chat bleibt
// in der Liste mit der Zeile "Profil wurde geloescht", schreiben geht nicht mehr.
const PROFILE_DELETED_SYSTEM = 'profileDeleted';
const APP_DATABASE_NAME = 'OpenGridDB_Live';

function profileDeletionContacts() {
    const me = state.myProfile?.id;
    return [...new Set([
        ...(state.chatPeerIds || []),
        ...Object.keys(state.friendState || {}),
        ...Object.keys(state.matchState || {})
    ])].filter(peerId => peerId && peerId !== me);
}

async function notifyProfileDeleted(peerId) {
    const operation = {
        operationId: `profiledeleted:${window.crypto.randomUUID()}`,
        type: 'PROFILE_DELETED',
        actorId: state.myProfile.id,
        createdAt: Date.now()
    };
    const payload = { type: 'CHAT_OPERATION', operation };
    const channel = state.dataChannels[peerId];
    if (channel?.readyState === 'open' && state.sessionKeys[peerId]) {
        await sendSecurePayload(peerId, payload).catch(logBackgroundError('notifyProfileDeleted'));
    }
    await queuePayloadInCache(peerId, { payload, cacheQueued: false }).catch(logBackgroundError('notifyProfileDeleted'));
}

async function deleteMyProfile() {
    if (!window.confirm(t('account.confirmDelete'))) return;
    if (!window.confirm(t('account.confirmDeleteFinal'))) return;
    showToast(t('account.deleting'), 'info');
    for (const peerId of profileDeletionContacts()) {
        await notifyProfileDeleted(peerId);
    }
    try {
        const response = await fetch(`${API_BASE}/api/account/${encodeURIComponent(state.myProfile.id)}`, {
            method: 'DELETE',
            headers: peerAuthHeaders()
        });
        if (!response.ok) throw new Error(`Account API returned ${response.status}`);
    } catch (error) {
        // Ohne Router-Loeschung nichts lokal loeschen: sonst bliebe ein Konto zurueck, das niemand mehr steuert.
        logDebug(`Account deletion failed: ${error.message}`);
        showToast(t('account.deleteFailed'), 'error');
        return;
    }
    await wipeLocalData();
    window.location.replace('/');
}

async function wipeLocalData() {
    state.shouldReconnect = false;
    try {
        state.ws?.close();
    } catch {
        // Bereits zu.
    }
    try {
        db?.close();
    } catch {
        // Bereits zu.
    }
    await new Promise(resolve => {
        const request = indexedDB.deleteDatabase(APP_DATABASE_NAME);
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
    try {
        window.localStorage.clear();
        window.sessionStorage.clear();
    } catch {
        // Ohne Speicherzugriff bleibt nichts zu loeschen.
    }
    if ('caches' in window) {
        const names = await caches.keys().catch(() => []);
        await Promise.all(names.map(name => caches.delete(name).catch(() => false)));
    }
}

// Empfaenger: der Kontakt hat sein Profil geloescht.
async function handleProfileDeleted(peerId) {
    const messages = await getDatabaseRecordsByIndex('messages', 'peerId', peerId).catch(() => []);
    await Promise.all(messages.map(message => Promise.all([
        deleteDatabaseRecord('messages', message.id),
        deleteDatabaseRecord('media', `orig_${message.id}`).catch(() => {})
    ])));
    const operations = await getDatabaseRecordsByIndex('chatOperations', 'peerId', peerId).catch(() => []);
    await Promise.all(operations.map(operation => deleteDatabaseRecord('chatOperations', operation.operationId)));
    for (const album of Object.values(state.albums || {}).filter(entry => entry.ownerId === peerId)) {
        await forgetReceivedAlbum(peerId, album.id).catch(logBackgroundError('handleProfileDeleted'));
    }
    if (typeof forgetStatusesOf === 'function') await forgetStatusesOf(peerId).catch(logBackgroundError('handleProfileDeleted'));
    await deleteDatabaseRecord('profiles', peerId).catch(() => {});
    delete state.cachedProfiles[peerId];
    if (state.interactions?.items) {
        state.interactions = { ...state.interactions, items: state.interactions.items.filter(item => item.peerId !== peerId) };
        saveInteractions();
    }
    // Der Chat bleibt in der Liste, mit einer Zeile statt des Verlaufs.
    const note = {
        id: `profile-deleted:${peerId}`,
        peerId,
        senderId: peerId,
        system: PROFILE_DELETED_SYSTEM,
        text: t('chat.profileDeleted'),
        createdAt: Date.now(),
        timestamp: formatClockTime(Date.now())
    };
    state.chats[peerId] = [note];
    await persistChatMessage(peerId, note);
    rememberChatPeer(peerId);
    renderActivePeerList();
    if (state.activeChatPeerId === peerId) {
        renderChatHistory();
        renderChatAllowance();
    }
}

function isProfileDeleted(peerId) {
    return (state.chats[peerId] || []).some(message => message.system === PROFILE_DELETED_SYSTEM);
}
