// ================= ANDROID-APP: BRUECKE (documentation/ANDROID-APP.md, Phase 2) =================
// In der OpenGrid-App gibt es `window.OpenGridNative` (WebViewCompat.addWebMessageListener, nur fuer
// den Ursprung des Routers). Ohne App (Browser, PWA) fehlt das Objekt und hier passiert nichts.
// Nachrichten sind JSON-Texte: Anfrage { v, id, type, data }, Antwort { v, id, ok, result | error },
// Ereignis der App { v, event, data }. Die Liste muss zu android/.../Bridge.kt passen (Test prueft das).
const NATIVE_PROTOCOL_VERSION = 1;
const NATIVE_REQUEST_TYPES = ['capabilities', 'secureScreen', 'takeShare'];
const NATIVE_EVENT_TYPES = ['shareReady'];
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
        })
        .catch(error => logDebug(`Native capabilities failed: ${error.message}`));
}
