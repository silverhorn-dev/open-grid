// ================= ANDROID-APP: BRUECKE (documentation/ANDROID-APP.md, Phase 2) =================
// In der OpenGrid-App gibt es `window.OpenGridNative` (WebViewCompat.addWebMessageListener, nur fuer
// den Ursprung des Routers). Ohne App (Browser, PWA) fehlt das Objekt und hier passiert nichts.
// Nachrichten sind JSON-Texte: Anfrage { v, id, type, data }, Antwort { v, id, ok, result | error },
// Ereignis der App { v, event, data }. Die Liste muss zu android/.../Bridge.kt passen (Test prueft das).
const NATIVE_PROTOCOL_VERSION = 1;
const NATIVE_REQUEST_TYPES = ['capabilities', 'secureScreen', 'takeShare', 'notify', 'notifications', 'background', 'inbox', 'coreStatus', 'replyResult'];
const NATIVE_EVENT_TYPES = ['shareReady', 'openChat', 'notificationReply'];
const NOTIFICATION_REPLY_MAX_LENGTH = 2000;
const NATIVE_CALL_TIMEOUT_MS = 10000;
// Ansichten ohne Bildschirmfotos: markierte Bereiche (Medien, Profile, Flirt-Chat) und sichere Bilder.
const SECURE_SCREEN_SELECTOR = '[data-secure-screen], canvas.secure-image';

const nativeBridge = {
    port: null,
    nextId: 1,
    pending: new Map(),
    secureScreen: false,
    secureScheduled: false,
    capabilities: null
};

function isNativeApp() {
    return Boolean(nativeBridge.port);
}

function nativeCall(type, data = null) {
    if (!nativeBridge.port) return Promise.reject(new Error('No native app'));
    if (!NATIVE_REQUEST_TYPES.includes(type)) return Promise.reject(new Error(`Unknown native call ${type}`));
    const id = nativeBridge.nextId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            nativeBridge.pending.delete(id);
            reject(new Error(`Native call ${type} timed out`));
        }, NATIVE_CALL_TIMEOUT_MS);
        nativeBridge.pending.set(id, { resolve, reject, timer });
        nativeBridge.port.postMessage(JSON.stringify({ v: NATIVE_PROTOCOL_VERSION, id, type, data }));
    });
}

function handleNativeMessage(raw) {
    let message;
    try {
        message = JSON.parse(typeof raw === 'string' ? raw : String(raw ?? ''));
    } catch {
        return;
    }
    if (!message || typeof message !== 'object') return;
    if (Number.isSafeInteger(message.id) && nativeBridge.pending.has(message.id)) {
        const call = nativeBridge.pending.get(message.id);
        nativeBridge.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.ok) call.resolve(message.result ?? null);
        else call.reject(new Error(String(message.error || 'Native call failed')));
        return;
    }
    if (message.event === 'shareReady') {
        handleNativeShare().catch(error => logDebug(`Native share failed: ${error.message}`));
    }
    // Antwort direkt aus der Benachrichtigung (nur der Kern bekommt sie): senden und Ergebnis melden.
    if (message.event === 'notificationReply') {
        handleNotificationReply(message.data).catch(error => logDebug(`Notification reply failed: ${error.message}`));
    }
    // Benachrichtigung angetippt: den Chat oeffnen.
    if (message.event === 'openChat') {
        const peerId = message.data?.peerId;
        if (typeof peerId === 'string' && peerId.length <= 200 && typeof openChatWithPeer === 'function') {
            if (typeof switchTab === 'function') switchTab('chat');
            Promise.resolve(openChatWithPeer(peerId)).catch(error => logDebug(`Open chat from notification failed: ${error.message}`));
        }
    }
}

const NOTIFICATION_REPLY_IDS_KEY = 'opengrid-notification-replies';

function notificationReplyDone(replyId) {
    try {
        return JSON.parse(localStorage.getItem(NOTIFICATION_REPLY_IDS_KEY) || '[]').includes(replyId);
    } catch {
        return false;
    }
}

function rememberNotificationReply(replyId) {
    try {
        const ids = JSON.parse(localStorage.getItem(NOTIFICATION_REPLY_IDS_KEY) || '[]').filter(id => id !== replyId);
        localStorage.setItem(NOTIFICATION_REPLY_IDS_KEY, JSON.stringify([...ids, replyId].slice(-20)));
    } catch {
        // Ohne localStorage: im schlimmsten Fall doppelt nach einem Neustart des Kerns.
    }
}

// Antwort aus der Benachrichtigung (Android, ReplyService -> CoreHost -> Kern): wie eine normale Textnachricht
// senden (gleiche Regeln: Chat-Berechtigungen, Sperren), danach `replyResult` an die App, die die
// Benachrichtigung entfernt bzw. "nicht gesendet" zeigt.
async function handleNotificationReply(data) {
    const replyId = typeof data?.replyId === 'string' ? data.replyId.slice(0, 100) : '';
    const peerId = typeof data?.peerId === 'string' && data.peerId.length <= 200 ? data.peerId : '';
    const text = typeof data?.text === 'string' ? data.text.trim().slice(0, NOTIFICATION_REPLY_MAX_LENGTH) : '';
    let ok = false;
    // Wiederholung nach einem Neustart des Kerns (CoreHost): schon gesendet, nur bestaetigen.
    if (replyId && notificationReplyDone(replyId)) {
        await nativeCall('replyResult', { replyId, ok: true }).catch(() => {});
        return true;
    }
    if (replyId && peerId && text && APP_ROLE !== 'ui' && !(typeof isGroupId === 'function' && isGroupId(peerId))) {
        rememberNotificationReply(replyId);
        if (typeof noteBreadcrumb === 'function') noteBreadcrumb('notification reply: sending');
        ok = (await sendChatMessage(null, '', null, null, { peerId, text }).catch(error => {
            logDebug(`Notification reply could not be sent: ${error.message}`);
            return false;
        })) !== false;
    }
    if (replyId) await nativeCall('replyResult', { replyId, ok }).catch(() => {});
    return ok;
}

// Sichtbar = gerendert und nicht in einem ausgeblendeten Elternteil (auch fuer position: fixed).
function isSecureElementShown(element) {
    if (typeof element.checkVisibility === 'function') return element.checkVisibility();
    return element.getClientRects().length > 0;
}

function secureScreenWanted(root = document) {
    for (const element of root.querySelectorAll(SECURE_SCREEN_SELECTOR)) {
        if (isSecureElementShown(element)) return true;
    }
    return false;
}

// Gebuendelt pro Bild: viele Aenderungen am DOM fuehren zu hoechstens einer Pruefung.
function scheduleSecureScreenUpdate() {
    if (!nativeBridge.port || nativeBridge.secureScheduled) return;
    nativeBridge.secureScheduled = true;
    requestAnimationFrame(() => {
        nativeBridge.secureScheduled = false;
        const wanted = secureScreenWanted();
        if (wanted === nativeBridge.secureScreen) return;
        nativeBridge.secureScreen = wanted;
        nativeCall('secureScreen', { on: wanted }).catch(error => logDebug(`Secure screen failed: ${error.message}`));
    });
}

// Geteilte Inhalte aus anderen Apps: die App haelt sie bereit, die Seite holt sie ab (wie der
// Service Worker beim share_target) und zeigt dieselbe Chatauswahl.
async function handleNativeShare() {
    if (!nativeBridge.port) return;
    const shared = await nativeCall('takeShare');
    if (!shared) return;
    const files = [];
    for (const file of (Array.isArray(shared.files) ? shared.files : []).slice(0, 20)) {
        if (typeof file?.type !== 'string' || !file.type.startsWith('image/') || typeof file.data !== 'string') continue;
        const bytes = Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
        files.push(new Blob([bytes], { type: file.type }));
    }
    const text = sharedText(shared);
    const skipped = (Number(shared.skipped) || 0) + (Array.isArray(shared.files) ? shared.files.length - files.length : 0);
    if (!files.length && !text) {
        showToast(t('share.nothingToSend'), 'info');
        return;
    }
    if (skipped) showToast(t('share.someFilesSkipped', { count: skipped }), 'warning');
    openSharePicker({ text, files, skipped });
}

// ----- Benachrichtigungen ueber die App (T4, ANDROID-APP.md) -----
// Die WebView kennt weder Web Push noch die Notification-API: die App zeigt sie nativ an. Nur wenn die Seite
// nicht sichtbar ist (im Hintergrund, KeepAliveService haelt sie aktiv), nach denselben Schaltern je Art wie der
// Push und mit "Kompakte Meldung" (Standard an) nur "Neue Nachrichten".
async function nativeCompactNotifications() {
    if (typeof state.compactNotifications === 'boolean') return state.compactNotifications;
    const settings = typeof databaseRequest === 'function'
        ? await databaseRequest('keys', 'readonly', store => store.get('push-settings')).catch(() => null) : null;
    state.compactNotifications = settings?.compactNotifications !== false;
    return state.compactNotifications;
}

function nativeNotificationsUsable() {
    // Kern: Benachrichtigung, solange die Oberflaeche nicht zu sehen ist; Oberflaeche selbst meldet nichts (der Kern tut es).
    const pageVisible = APP_ROLE === 'core' ? typeof coreUiVisible === 'function' && coreUiVisible() : document.visibilityState === 'visible';
    return isNativeApp() && APP_ROLE !== 'ui' && nativeBridge.capabilities?.notifications === true && !pageVisible;
}

async function notifyNative(kind, { title, body, peerId = null }) {
    if (!nativeNotificationsUsable()) return;
    if (typeof notificationEnabled === 'function' && !notificationEnabled(kind)) return;
    const compact = await nativeCompactNotifications();
    const data = compact
        ? { title: t('sw.newMessages'), body: t('sw.tapToOpen'), tag: 'opengrid-messages', peerId }
        : {
            title: String(title || 'OpenGrid'), body: String(body || ''), tag: peerId ? `chat-${peerId}` : `opengrid-${kind}`, peerId,
            // "Antworten" direkt in der Benachrichtigung: nur mit Vorschau (man sieht, wem man antwortet), nicht in Gruppen.
            reply: Boolean(peerId) && !(typeof isGroupId === 'function' && isGroupId(peerId))
        };
    await nativeCall('notify', data).catch(error => logDebug(`Native notification failed: ${error.message}`));
}

// Neue Nachricht von jemand anderem (storage.js): Name und Vorschau, Art "discovery" bzw. "chat".
function notifyNativeMessage(peerId, message) {
    if (!nativeNotificationsUsable() || !message || message.held || message.deleted) return;
    if (Date.now() - (Number(message.createdAt) || 0) > 24 * 60 * 60 * 1000) return;
    const kind = typeof chatScopeOf === 'function' && chatScopeOf(peerId) === 'discovery' ? 'discovery' : 'chat';
    const presentation = typeof getPeerPresentation === 'function' ? getPeerPresentation(peerId) : null;
    const sender = typeof getPeerPresentation === 'function' && message.senderId !== peerId ? getPeerPresentation(message.senderId)?.name : null;
    const title = presentation?.name || t('sw.newMessage');
    const preview = typeof messagePreview === 'function' ? messagePreview(message) : (message.text || '');
    notifyNative(kind, { title, body: sender ? `${sender}: ${preview}` : preview, peerId }).catch(() => {});
}

// Einstellungen: "Im Hintergrund erreichbar" (Posteingang + Kern auf Abruf, nur in der App sichtbar).
async function renderNativeAppSettings() {
    if (!isNativeApp()) return;
    const toggle = document.getElementById('native-reachable-toggle');
    const battery = document.getElementById('native-battery-hint');
    const result = await nativeCall('background').catch(() => null);
    if (toggle && result) toggle.checked = result.enabled !== false;
    battery?.classList.toggle('hidden', !result || result.enabled === false || result.batteryUnrestricted === true);
}

async function setNativeReachable(enabled) {
    // An: Android soll die App im Ruhezustand nicht vom Netz trennen -> Systemdialog Akku-Optimierung.
    await nativeCall('background', { enabled: Boolean(enabled), askBattery: Boolean(enabled) }).catch(error => logDebug(`Native background failed: ${error.message}`));
    renderNativeAppSettings().catch(() => {});
}

// Zugangsdaten fuer den Posteingang der App (Node-ID + Router-Token); bleiben in der App.
function sendNativeInboxCredentials() {
    if (!isNativeApp() || nativeBridge.capabilities?.core !== true) return;
    const authToken = state.routerAuthToken || window.localStorage.getItem('opengrid-router-auth-token');
    if (!state.myProfile?.id || !authToken || !state.myProfile.updatedAt) return;
    nativeCall('inbox', { nodeId: state.myProfile.id, authToken }).catch(error => logDebug(`Native inbox failed: ${error.message}`));
}

function nativeAskBatteryExemption() {
    nativeCall('background', { askBattery: true }).catch(() => {});
}

function initNativeBridge() {
    const port = window.OpenGridNative;
    if (!port || typeof port.postMessage !== 'function') return;
    nativeBridge.port = port;
    port.onmessage = event => handleNativeMessage(event?.data);
    document.documentElement.classList.add('is-native-app');
    new MutationObserver(scheduleSecureScreenUpdate).observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'hidden', 'style', 'data-secure-screen']
    });
    scheduleSecureScreenUpdate();
    nativeCall('capabilities', { protocol: NATIVE_PROTOCOL_VERSION })
        .then(result => {
            nativeBridge.capabilities = result;
            logDebug(`Native app ${result?.versionName || '?'} (protocol ${result?.protocol ?? '?'})`);
            // Version der App neben der Web-Version (Menue).
            const version = document.getElementById('native-app-version');
            if (version && result?.versionName) {
                version.textContent = ` · ${t('native.appVersion', { version: result.versionName })}`;
                version.classList.remove('hidden');
            }
            // Letzter Ausfall des WebView-Renderers (Absturz/Speicher), zur Fehlersuche ohne Logcat.
            if (result?.rendererGone) {
                const gone = result.rendererGone;
                logDebug(`WebView renderer gone (${gone.where}, ${gone.crashed ? 'crash' : 'killed for memory'}) at ${new Date(gone.at).toISOString()}`);
                // Was davor passierte (Spur aus config.js, ueberlebt den Neustart).
                const before = typeof takeBreadcrumbsBefore === 'function' ? takeBreadcrumbsBefore(gone.at) : [];
                logDebug(before.length ? `Before the renderer was gone:\n  ${before.join('\n  ')}` : 'Before the renderer was gone: no steps recorded.');
                if (gone.availMb !== undefined) logDebug(`Device memory at that time: ${gone.availMb} of ${gone.totalMb} MB free${gone.lowMemory ? ' (low memory)' : ''}, renderer priority ${gone.priority}`);
                // Native Spur der App (Lebenszyklus, Rechte-Dialoge, Antworten aus Benachrichtigungen).
                const events = Array.isArray(result.nativeEvents) ? result.nativeEvents : [];
                if (events.length) logDebug(`App events:\n  ${events.map(entry => `${new Date(entry.at).toISOString()} ${String(entry.text).slice(0, 200)}`).join('\n  ')}`);
            }
            if (typeof updatePushStatus === 'function') updatePushStatus().catch(() => {});
            renderNativeAppSettings().catch(() => {});
            sendNativeInboxCredentials();
        })
        .catch(error => logDebug(`Native capabilities failed: ${error.message}`));
}
