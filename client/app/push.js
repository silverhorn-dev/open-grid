// ================= PUSH NOTIFICATIONS =================
function isPushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function base64UrlToBytes(value) {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    return base64ToBytes(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
}

// Der Service Worker hat keinen Zugriff auf localStorage. Er braucht
// Node-ID und Router-Token aber fuer Queue-Abruf und ACK.
function onRouterAuthUpdated() {
    if (!db || !state.routerAuthToken || state.persistedRouterAuthToken === state.routerAuthToken) return;
    const authToken = state.routerAuthToken;
    putDatabaseRecord('keys', { id: 'router-auth', nodeId: state.myProfile.id, authToken })
        .then(() => { state.persistedRouterAuthToken = authToken; })
        .catch(error => logDebug(`Could not store router auth for the service worker: ${error.message}`));
    if (!state.pushSubscriptionSynced) {
        state.pushSubscriptionSynced = true;
        syncPushSubscription().catch(error => logDebug(`Push subscription sync failed: ${error.message}`));
    }
}

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
    navigator.serviceWorker.startMessages();
    try {
        state.serviceWorkerRegistration = await navigator.serviceWorker.register('/sw.js');
        watchServiceWorkerUpdates(state.serviceWorkerRegistration);
    } catch (error) {
        logDebug(`Service worker registration failed: ${error.message}`);
    }
    updatePushStatus();
}

// Neue Version: nie automatisch umschalten (laufende Sitzung bleibt heil), sondern anbieten.
function watchServiceWorkerUpdates(registration) {
    const offerUpdate = () => {
        if (registration.waiting && navigator.serviceWorker.controller) {
            document.getElementById('update-banner')?.classList.remove('hidden');
        }
    };
    offerUpdate();
    registration.addEventListener('updatefound', () => {
        registration.installing?.addEventListener('statechange', offerUpdate);
    });
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!state.updateRequested || reloading) return;
        reloading = true;
        window.location.reload();
    });
}

function activateServiceWorkerUpdate() {
    const waiting = state.serviceWorkerRegistration?.waiting;
    if (!waiting) return;
    state.updateRequested = true;
    waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
}

function handleServiceWorkerMessage(event) {
    const data = event.data || {};
    if (data.type === 'PATH_C_AVAILABLE') {
        fetchQueuedCacheMessages();
    } else if (data.type === 'CHAT_STORE_UPDATED' && typeof data.peerId === 'string') {
        loadChatPeerIds().catch(logBackgroundError('handleServiceWorkerMessage'));
        if (state.activeChatPeerId === data.peerId) {
            loadChatHistory(data.peerId).then(renderChatHistory).catch(logBackgroundError('handleServiceWorkerMessage'));
        }
    } else if (data.type === 'OPEN_CHAT' && typeof data.peerId === 'string') {
        openChatWithPeer(data.peerId);
    }
}

async function getPushSubscription() {
    const registration = state.serviceWorkerRegistration;
    return registration ? registration.pushManager.getSubscription() : null;
}

async function uploadPushSubscription(subscription) {
    const response = await fetch(`${API_BASE}/api/push/subscribe`, {
        method: 'POST',
        headers: peerAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ peerId: state.myProfile.id, subscription: subscription.toJSON() })
    });
    if (!response.ok) throw new Error(`Push API returned ${response.status}.`);
}

// Haelt den Server aktuell, z. B. nach einem Server-Reset oder neuem Token.
async function syncPushSubscription() {
    if (!isPushSupported() || Notification.permission !== 'granted') return;
    const subscription = await getPushSubscription();
    if (subscription) await uploadPushSubscription(subscription);
}

async function setCompactPushNotifications(enabled) {
    try {
        await putDatabaseRecord('keys', { id: 'push-settings', compactNotifications: enabled });
    } catch (error) {
        logDebug(`Could not store push settings: ${error.message}`);
        showToast('Einstellung konnte nicht gespeichert werden.', 'error');
    }
}

async function updatePushStatus() {
    const compactToggle = document.getElementById('push-compact-toggle');
    if (compactToggle && db) {
        const settings = await databaseRequest('keys', 'readonly', store => store.get('push-settings')).catch(() => null);
        compactToggle.checked = settings?.compactNotifications !== false;
    }
    const status = document.getElementById('push-status');
    const button = document.getElementById('push-toggle-btn');
    if (!status || !button) return;
    if (!isPushSupported() || !state.serviceWorkerRegistration) {
        status.textContent = 'Nicht unterstuetzt (auf iOS nur als installierte App).';
        button.disabled = true;
        return;
    }
    const subscription = await getPushSubscription().catch(() => null);
    const active = Boolean(subscription) && Notification.permission === 'granted';
    status.textContent = Notification.permission === 'denied'
        ? 'Im Browser blockiert.'
        : active ? 'Aktiv.' : 'Aus.';
    button.disabled = Notification.permission === 'denied';
    button.textContent = active ? 'Disable Notifications' : 'Enable Notifications';
}

async function togglePushNotifications() {
    const button = document.getElementById('push-toggle-btn');
    button.disabled = true;
    try {
        const existing = await getPushSubscription();
        if (existing && Notification.permission === 'granted') {
            await existing.unsubscribe();
            await fetch(`${API_BASE}/api/push/subscribe/${encodeURIComponent(state.myProfile.id)}`, {
                method: 'DELETE',
                headers: peerAuthHeaders()
            });
            showToast('Push-Benachrichtigungen deaktiviert.', 'info');
            return;
        }
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            showToast('Benachrichtigungen wurden nicht erlaubt.', 'warning');
            return;
        }
        const keyResponse = await fetch(`${API_BASE}/api/push/vapid-public-key`);
        const { publicKey } = await keyResponse.json();
        // subscribe() braucht einen aktiven Worker, nicht nur einen installierten.
        const registration = await navigator.serviceWorker.ready;
        const subscription = existing || await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64UrlToBytes(publicKey)
        });
        await uploadPushSubscription(subscription);
        showToast('Push-Benachrichtigungen aktiviert.', 'success');
    } catch (error) {
        logDebug(`Push toggle failed: ${error.message}`);
        showToast('Push-Benachrichtigungen konnten nicht geaendert werden.', 'error');
    } finally {
        button.disabled = false;
        updatePushStatus();
    }
}
