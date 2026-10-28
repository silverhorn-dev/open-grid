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

// Direkt (P2P) zugestellt, der Partner ist aber abwesend: Server um einen Push ohne Inhalt bitten, sonst
// bekommt er keine Benachrichtigung (es lief kein Push ueber den Zwischenspeicher). Hoechstens alle 15 s
// pro Partner; der Server prueft selbst, ob der Partner wirklich abwesend/offline ist.
const PUSH_NUDGE_INTERVAL_MS = 15000;
const lastPushNudges = {};

function nudgeAwayPeer(peerId, kind = 'chat') {
    if (!peerId || !isPeerAway(peerId)) return;
    const now = Date.now();
    const key = `${peerId}:${kind}`;
    if (now - (lastPushNudges[key] || 0) < PUSH_NUDGE_INTERVAL_MS) return;
    lastPushNudges[key] = now;
    fetch(`${API_BASE}/api/push/nudge`, {
        method: 'POST',
        headers: peerAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ senderId: state.myProfile.id, recipientId: peerId, kind })
    }).catch(error => logDebug(`Push nudge failed: ${error.message}`));
}

// ----- Benachrichtigungen je Art (Einstellungen > Chat > Benachrichtigungen) -----
// Ein Schalter pro Art steuert Push und Hinweis in der App. Arten mit Push melden wir dem Router als
// "stumm" (`/api/push/settings`), damit er dafuer gar nicht erst pusht. Chat-Ereignisse gibt es nur in
// der App. Profilbesuche sind standardmaessig aus (und werden nur gesendet, wenn der Besucher es erlaubt).
const NOTIFICATION_KINDS = ['match', 'flame', 'add', 'discovery', 'chat', 'profileView', 'chatEvents'];
const PUSH_NOTIFICATION_KINDS = ['match', 'flame', 'add', 'discovery', 'chat', 'profileView'];
const NOTIFICATION_SETTINGS_RECORD_ID = 'notification-settings';
const NOTIFICATION_DEFAULTS = { match: true, flame: true, add: true, discovery: true, chat: true, profileView: false, chatEvents: true };

async function loadNotificationSettings() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(NOTIFICATION_SETTINGS_RECORD_ID)).catch(() => null);
    state.notificationSettings = Object.fromEntries(NOTIFICATION_KINDS.map(kind => [kind,
        typeof stored?.kinds?.[kind] === 'boolean' ? stored.kinds[kind] : NOTIFICATION_DEFAULTS[kind]]));
    state.shareProfileViews = stored?.shareProfileViews === true;
    renderNotificationSettings();
}

function notificationEnabled(kind) {
    return state.notificationSettings?.[kind] ?? NOTIFICATION_DEFAULTS[kind] ?? true;
}

async function saveNotificationSettings() {
    try {
        await putDatabaseRecord('keys', { id: NOTIFICATION_SETTINGS_RECORD_ID, kinds: state.notificationSettings, shareProfileViews: state.shareProfileViews });
    } catch (error) {
        logDebug(`Could not store notification settings: ${error.message}`);
        showToast(t('common.settingCouldNotBeSaved'), 'error');
    }
}

async function updateNotificationSetting(kind, enabled) {
    if (!NOTIFICATION_KINDS.includes(kind)) return;
    state.notificationSettings = { ...state.notificationSettings, [kind]: Boolean(enabled) };
    await saveNotificationSettings();
    syncPushMutedKinds().catch(error => logDebug(`Push settings sync failed: ${error.message}`));
}

async function updateProfileViewSharing(enabled) {
    state.shareProfileViews = Boolean(enabled);
    await saveNotificationSettings();
}

function renderNotificationSettings() {
    NOTIFICATION_KINDS.forEach(kind => {
        const toggle = document.getElementById(`notify-${kind}-toggle`);
        if (toggle) toggle.checked = notificationEnabled(kind);
    });
    const share = document.getElementById('share-profile-views-toggle');
    if (share) share.checked = state.shareProfileViews;
}

// Dem Router sagen, welche Arten er nicht pushen soll (nur mit eingerichtetem Push).
async function syncPushMutedKinds() {
    if (!isPushSupported() || Notification.permission !== 'granted' || !state.myProfile?.id) return;
    const mutedKinds = PUSH_NOTIFICATION_KINDS.filter(kind => !notificationEnabled(kind));
    const response = await fetch(`${API_BASE}/api/push/settings`, {
        method: 'POST',
        headers: peerAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ peerId: state.myProfile.id, mutedKinds })
    });
    if (!response.ok) throw new Error(`Push settings API returned ${response.status}.`);
}

// Profilbesuch melden: nur wenn man es selbst erlaubt (Standard aus), nur in "Entdecken" (nicht bei
// Freunden oder Chats aus "Chat & Freunde") und hoechstens alle 6 Stunden pro Person. Geht als
// verschluesselte Chat-Operation (direkt, sonst Pfad C mit Push "Profilbesuch"); der andere sieht den
// Hinweis nur, wenn er Profilbesuche eingeschaltet hat.
const PROFILE_VIEW_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PROFILE_VIEWS_SENT_KEY = 'opengrid-profile-views-sent';

function shouldSendProfileView(peerId, now = Date.now()) {
    if (!state.shareProfileViews || !peerId || peerId === state.myProfile?.id || isPeerBlocked(peerId)) return false;
    if (!scopeIncludes('discovery') || isSocialMode() || isFriend(peerId) || chatScopeOf(peerId) === 'social') return false;
    let sent = {};
    try {
        sent = JSON.parse(localStorage.getItem(PROFILE_VIEWS_SENT_KEY) || '{}') || {};
    } catch {
        sent = {};
    }
    if (now - (Number(sent[peerId]) || 0) < PROFILE_VIEW_INTERVAL_MS) return false;
    // Alte Eintraege aufraeumen, damit die Liste nicht waechst.
    const fresh = Object.fromEntries(Object.entries(sent).filter(([, at]) => now - at < PROFILE_VIEW_INTERVAL_MS).slice(-200));
    localStorage.setItem(PROFILE_VIEWS_SENT_KEY, JSON.stringify({ ...fresh, [peerId]: now }));
    return true;
}

function sendProfileView(peerId) {
    if (!shouldSendProfileView(peerId)) return;
    const operation = {
        operationId: `view:${window.crypto.randomUUID()}`,
        type: 'PROFILE_VIEW',
        actorId: state.myProfile.id,
        createdAt: Date.now()
    };
    sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation }, path => {
        if (path === 'p2p') nudgeAwayPeer(peerId, 'profileView');
    }).catch(logBackgroundError('sendProfileView'));
}

// Hinweis in der App nur, wenn die Art eingeschaltet ist.
function notifyInApp(kind, message, type = 'info') {
    if (notificationEnabled(kind)) showToast(message, type);
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
    if (subscription) {
        await uploadPushSubscription(subscription);
        await syncPushMutedKinds();
    }
}

async function setCompactPushNotifications(enabled) {
    try {
        await putDatabaseRecord('keys', { id: 'push-settings', compactNotifications: enabled });
    } catch (error) {
        logDebug(`Could not store push settings: ${error.message}`);
        showToast(t('common.settingCouldNotBeSaved'), 'error');
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
        status.textContent = t('push.notSupportedOnIosOnly');
        button.disabled = true;
        return;
    }
    const subscription = await getPushSubscription().catch(() => null);
    const active = Boolean(subscription) && Notification.permission === 'granted';
    status.textContent = Notification.permission === 'denied'
        ? t('push.blockedInBrowser')
        : active ? t('push.active') : t('push.off');
    button.disabled = Notification.permission === 'denied';
    button.textContent = active ? t('push.turnOffNotifications') : t('common.turnOnNotifications');
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
            showToast(t('push.notificationsTurnedOff'), 'info');
            return;
        }
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            showToast(t('push.notificationsWereNotAllowed'), 'warning');
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
        showToast(t('push.notificationsTurnedOn'), 'success');
    } catch (error) {
        logDebug(`Push toggle failed: ${error.message}`);
        showToast(t('push.notificationsCouldNotBe'), 'error');
    } finally {
        button.disabled = false;
        updatePushStatus();
    }
}
