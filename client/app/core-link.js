// ================= OBERFLAECHE <-> KERN (documentation/ANDROID-APP.md, "Kern im Hintergrund", K2) =================
// In der Android-App laufen zwei Seiten desselben Ursprungs: der Kern (/core.html, Rolle "core") haelt Router-WS,
// P2P, Krypto und Abgleich; die Oberflaeche (Rolle "ui") zeigt an und nimmt Eingaben an. Beide teilen IndexedDB
// (eine Datenquelle) und sprechen ueber BroadcastChannel('opengrid-core') - nur innerhalb des Ursprungs, von
// aussen nicht erreichbar. Ohne Kern (Browser) antwortet niemand: die Seite bleibt "full" wie bisher.
//
// Nachrichten { v, kind, ... }:
//   hello (ui)                     -> welcome { ready } (core): Kern da (ready = hat ein Profil und ist verbunden)
//   call { id, fn, args } (ui)     -> result { id, ok, value | error } (core); Rueckrufe als callback { cb, args }
//   db { store, key, peerId } (beide): eigener Schreibzugriff; die andere Seite liest genau das neu aus der DB
//   live { snapshot } (core)       : Praesenz, offene Kanaele, "tippt", Chat-Fokus, Verbindungsweg
//   ui { visible, chat } (ui)      : Herzschlag der Oberflaeche (abwesend/Benachrichtigungen im Kern)
//   toast { message, type } (core) : Hinweise des Kerns erscheinen in der Oberflaeche
const CORE_CHANNEL_NAME = 'opengrid-core';
const CORE_PROTOCOL = 1;
const CORE_HELLO_TIMEOUT_MS = 800;
const CORE_CALL_TIMEOUT_MS = 60000;
const CORE_UI_HEARTBEAT_MS = 2000;
const CORE_UI_STALE_MS = 7000;
const CORE_LOST_MS = 10000;
const CORE_LIVE_INTERVAL_MS = 300;
const CORE_RELOAD_DELAY_MS = 150;
// Lebenszeichen des Kerns im gemeinsamen localStorage: nur wenn es frisch ist, fragt eine Seite beim Start nach
// (sonst, also im normalen Browser, startet sie ohne Wartezeit als "full").
const CORE_ALIVE_KEY = 'opengrid-core-alive';
const CORE_ALIVE_INTERVAL_MS = 2000;
const CORE_ALIVE_FRESH_MS = 6000;
// Was die Oberflaeche an den Kern weitergibt (Transport); alles andere laeuft in der Oberflaeche selbst.
const CORE_PROXIED_FUNCTIONS = [
    'sendSecurePayload', 'initiateP2PConnection', 'registerWithWorkerGrid', 'subscribePresence',
    'requestMissingProfile', 'requestMissingOriginals', 'checkSignalingHealth', 'reconnectSignaling',
    'scheduleCacheFetch', 'connectGroupMembers', 'finishDevicePairing', 'retryVisiblePeerConnections'
];
// Laeuft in der Oberflaeche selbst UND im Kern (Kern muss seinen Zustand nachziehen, z. B. Sperren trennen Kanaele).
const CORE_ALSO_IN_CORE = ['refreshChatControls'];
// Antworten auf etwas, das die Oberflaeche angestossen hat (Ansehen, Laden): der Kern reicht sie weiter, die
// Oberflaeche zeigt sie an (K3). Ohne Oberflaeche behandelt sie der Kern selbst.
const CORE_FORWARDED_PAYLOADS = [
    'SNAP_VIEW_GRANT', 'SNAP_VIEW_DENIED', 'SNAP_STREAM_START', 'SNAP_STREAM_END',
    'ALBUM_RESPONSE', 'ALBUM_DENIED', 'SWARM_ALBUM_RESPONSE', 'SWARM_ALBUM_IMAGE_RESPONSE',
    'IMAGE_RESPONSE', 'SWARM_IMAGE_RESPONSE', 'PROFILE_RESPONSE', 'SWARM_PROFILE_RESPONSE'
];
const CORE_SNAP_FRAME_MS = 100;
const CORE_SNAP_RELAY_MAX_MS = 5 * 60 * 1000;
// Schreibzugriffe in `keys`, die nur der Kern braucht und die sehr oft passieren (keine Neuladen-Welle).
const CORE_QUIET_KEY_PREFIXES = ['group-keys:', 'prekeys', 'peer-prekey:', 'router-auth', 'device-invites', 'peer-identity:'];

const coreLink = {
    channel: null,
    nextId: 1,
    pending: new Map(),
    callbacks: new Map(),
    uiSeenAt: 0,
    uiVisible: false,
    uiChat: null,
    lastLive: '',
    coreSeenAt: 0,
    applying: 0,
    reloadTimer: null,
    reload: { chats: new Set(), profiles: new Set(), keys: false, list: false, own: false, albums: false, statuses: false }
};

function corePost(message) {
    coreLink.channel?.postMessage({ v: CORE_PROTOCOL, ...message });
}

// ----- Rolle bestimmen (Oberflaeche) -----
// Antwortet ein Kern mit Profil, wird diese Seite "ui"; sonst bleibt sie "full".
async function detectCoreRole() {
    if (APP_ROLE !== 'full' || typeof BroadcastChannel === 'undefined') return APP_ROLE;
    let alive = 0;
    try {
        alive = Number(window.localStorage.getItem(CORE_ALIVE_KEY)) || 0;
    } catch {
        alive = 0;
    }
    if (Date.now() - alive > CORE_ALIVE_FRESH_MS) return APP_ROLE;
    const channel = new BroadcastChannel(CORE_CHANNEL_NAME);
    const ready = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), CORE_HELLO_TIMEOUT_MS);
        channel.onmessage = event => {
            if (event.data?.v === CORE_PROTOCOL && event.data.kind === 'welcome') {
                clearTimeout(timer);
                resolve(event.data.ready === true);
            }
        };
        channel.postMessage({ v: CORE_PROTOCOL, kind: 'hello' });
    });
    if (!ready) {
        channel.close();
        return APP_ROLE;
    }
    APP_ROLE = 'ui';
    coreLink.channel = channel;
    channel.onmessage = event => handleCoreLinkMessage(event.data);
    installCoreProxies();
    return APP_ROLE;
}

// ----- Kern: Kanal oeffnen (auch ohne Profil, damit die Oberflaeche "nicht bereit" erfaehrt) -----
function initCoreLinkAsCore() {
    if (APP_ROLE !== 'core' || typeof BroadcastChannel === 'undefined' || coreLink.channel) return;
    coreLink.channel = new BroadcastChannel(CORE_CHANNEL_NAME);
    coreLink.channel.onmessage = event => handleCoreLinkMessage(event.data);
    // Hinweise des Kerns zeigt die Oberflaeche.
    const showLocal = window.showToast;
    window.showToast = (message, type = 'info') => {
        showLocal(message, type);
        if (coreUiConnected()) corePost({ kind: 'toast', message: String(message), type });
    };
    setInterval(publishCoreLive, CORE_LIVE_INTERVAL_MS);
    const beat = () => {
        try {
            window.localStorage.setItem(CORE_ALIVE_KEY, String(Date.now()));
        } catch {
            // Ohne localStorage findet die Oberflaeche den Kern nicht (sie arbeitet dann allein).
        }
    };
    beat();
    setInterval(beat, CORE_ALIVE_INTERVAL_MS);
    window.addEventListener('pagehide', () => {
        try {
            window.localStorage.removeItem(CORE_ALIVE_KEY);
        } catch {
            // egal
        }
    });
}

function coreReady() {
    return APP_ROLE === 'core' && Boolean(state.myProfile?.updatedAt) && Boolean(state.ws);
}

function coreUiConnected() {
    return Date.now() - coreLink.uiSeenAt < CORE_UI_STALE_MS;
}

// Kern: ist die Oberflaeche gerade zu sehen? (abwesend melden, Benachrichtigungen)
function coreUiVisible() {
    return coreUiConnected() && coreLink.uiVisible;
}

// ----- Nachrichten -----
function handleCoreLinkMessage(message) {
    if (!message || message.v !== CORE_PROTOCOL || typeof message.kind !== 'string') return;
    if (APP_ROLE === 'core') {
        if (message.kind === 'hello') corePost({ kind: 'welcome', ready: coreReady() });
        else if (message.kind === 'call') runCoreCall(message);
        else if (message.kind === 'ui') updateCoreUiPresence(message);
        else if (message.kind === 'db') scheduleCoreReload(message);
        else if (message.kind === 'also' && CORE_ALSO_IN_CORE.includes(message.fn) && typeof window[message.fn] === 'function') {
            window[message.fn]().catch?.(error => logDebug(`${message.fn} in core failed: ${error.message}`));
        }
        return;
    }
    if (APP_ROLE !== 'ui') return;
    coreLink.coreSeenAt = Date.now();
    if (message.kind === 'result') {
        const call = coreLink.pending.get(message.id);
        if (!call) return;
        coreLink.pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.ok) call.resolve(message.value);
        else call.reject(new Error(message.error || 'Core call failed'));
    } else if (message.kind === 'callback') {
        coreLink.callbacks.get(message.cb)?.(...(message.args || []));
    } else if (message.kind === 'live') {
        applyCoreLive(message.snapshot);
    } else if (message.kind === 'db') {
        scheduleCoreReload(message);
    } else if (message.kind === 'toast') {
        showToast(message.message, message.type);
    } else if (message.kind === 'payload') {
        // Weitergereichte Antwort (schon im Kern entschluesselt und geprueft).
        Promise.resolve(handleSecurePayload(message.peerId, message.payload, message.via))
            .catch(error => logDebug(`Forwarded ${message.payload?.type} failed: ${error.message}`));
    } else if (message.kind === 'snapframe') {
        receiveCoreSnapFrame(message.streamId, message.bitmap);
    } else if (message.kind === 'original-ready') {
        if (typeof onVoiceRestReady === 'function') onVoiceRestReady(message.messageId);
    }
}

// ----- Oberflaeche: Transport an den Kern -----
function coreCall(fn, args) {
    const id = coreLink.nextId++;
    // Funktionen (z. B. onSent) lassen sich nicht verschicken: als Rueckruf-Nummer, der Kern meldet zurueck.
    const callbackIds = [];
    const plainArgs = args.map(arg => {
        if (typeof arg !== 'function') return arg;
        const cb = `cb${coreLink.nextId++}`;
        coreLink.callbacks.set(cb, arg);
        callbackIds.push(cb);
        return { __coreCallback: cb };
    });
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            coreLink.pending.delete(id);
            reject(new Error(`Core call ${fn} timed out`));
        }, CORE_CALL_TIMEOUT_MS);
        coreLink.pending.set(id, {
            resolve: value => { setTimeout(() => callbackIds.forEach(cb => coreLink.callbacks.delete(cb)), CORE_CALL_TIMEOUT_MS); resolve(value); },
            reject: error => { callbackIds.forEach(cb => coreLink.callbacks.delete(cb)); reject(error); },
            timer
        });
        corePost({ kind: 'call', id, fn, args: plainArgs });
    });
}

function installCoreProxies() {
    for (const name of CORE_PROXIED_FUNCTIONS) {
        if (typeof window[name] !== 'function') continue;
        window[name] = (...args) => coreCall(name, args);
    }
    for (const name of CORE_ALSO_IN_CORE) {
        const local = window[name];
        if (typeof local !== 'function') continue;
        window[name] = async (...args) => {
            const result = await local(...args);
            corePost({ kind: 'also', fn: name });
            return result;
        };
    }
    // Die Oberflaeche baut selbst keine Router-Verbindung auf.
    window.connectWorkerWebSocket = () => {};
    window.reportAway = () => sendCoreUiHeartbeat();
    sendCoreUiHeartbeat();
    setInterval(sendCoreUiHeartbeat, CORE_UI_HEARTBEAT_MS);
    document.addEventListener('visibilitychange', sendCoreUiHeartbeat);
    // Kern weg (z. B. beendet): neu laden, dann arbeitet die Seite wieder allein ("full").
    coreLink.coreSeenAt = Date.now();
    setInterval(() => {
        if (Date.now() - coreLink.coreSeenAt > CORE_LOST_MS) window.location.reload();
    }, 2000);
}

function sendCoreUiHeartbeat() {
    corePost({ kind: 'ui', visible: document.visibilityState === 'visible', chat: state.activeChatPeerId || null });
}

// ----- Kern: Aufrufe der Oberflaeche ausfuehren -----
async function runCoreCall(message) {
    const { id, fn, args = [] } = message;
    if (!CORE_PROXIED_FUNCTIONS.includes(fn) || typeof window[fn] !== 'function') {
        corePost({ kind: 'result', id, ok: false, error: `Unknown core function ${fn}` });
        return;
    }
    const realArgs = args.map(arg => (arg && typeof arg === 'object' && typeof arg.__coreCallback === 'string'
        ? (...callbackArgs) => corePost({ kind: 'callback', cb: arg.__coreCallback, args: callbackArgs })
        : arg));
    try {
        const value = await window[fn](...realArgs);
        corePost({ kind: 'result', id, ok: true, value: value === undefined ? null : value });
    } catch (error) {
        corePost({ kind: 'result', id, ok: false, error: error?.message || String(error) });
    }
}

function updateCoreUiPresence(message) {
    const wasVisible = coreUiVisible();
    coreLink.uiSeenAt = Date.now();
    coreLink.uiVisible = message.visible === true;
    coreLink.uiChat = typeof message.chat === 'string' ? message.chat : null;
    if (wasVisible === coreUiVisible()) return;
    // Sichtbar/unsichtbar: Praesenz melden, eigenes Geraet als zuletzt aktiv.
    if (typeof reportAway === 'function') reportAway();
    if (coreUiVisible() && typeof markThisDeviceActive === 'function') markThisDeviceActive();
}

// ----- Kern: Live-Zustand spiegeln -----
function coreLiveSnapshot() {
    const channels = Object.keys(state.dataChannels || {}).filter(peerId => typeof isSecureChannelOpen === 'function' && isSecureChannelOpen(peerId));
    return {
        presence: state.peerPresence || {},
        away: state.peerAway || {},
        focus: state.peerChatFocus || {},
        typing: state.peerTyping || {},
        transport: state.peerTransport || {},
        // Fortschritt der Originale (Anzeige "Original 40 %").
        originals: Object.fromEntries(Object.entries(state.originalTransfers || {})
            .map(([messageId, transfer]) => [messageId, { received: transfer.received || 0, total: transfer.total || 0 }])),
        channels,
        connected: state.ws?.readyState === 1
    };
}

function publishCoreLive() {
    if (!coreUiConnected()) return;
    const snapshot = coreLiveSnapshot();
    const text = JSON.stringify(snapshot);
    // Unveraendert: nur ab und zu als Lebenszeichen.
    if (text === coreLink.lastLive && Date.now() - coreLink.lastLiveAt < 3000) return;
    coreLink.lastLive = text;
    coreLink.lastLiveAt = Date.now();
    corePost({ kind: 'live', snapshot });
}

// Oberflaeche: Spiegel uebernehmen. Offene Kanaele als Platzhalter, damit vorhandene Pruefungen (Kanal offen?)
// unveraendert funktionieren; gesendet wird trotzdem nur ueber den Kern.
function applyCoreLive(snapshot) {
    if (!snapshot) return;
    state.peerPresence = { ...snapshot.presence };
    state.peerAway = { ...snapshot.away };
    state.peerChatFocus = { ...snapshot.focus };
    state.peerTyping = { ...snapshot.typing };
    state.peerTransport = { ...snapshot.transport };
    const open = new Set(snapshot.channels || []);
    state.dataChannels = Object.fromEntries([...open].map(peerId => [peerId, { readyState: 'open', bufferedAmount: 0, coreMirror: true, send() {} }]));
    state.sessionKeys = Object.fromEntries([...open].map(peerId => [peerId, true]));
    state.coreConnected = snapshot.connected === true;
    state.originalTransfers = { ...(snapshot.originals || {}) };
    if (typeof renderOriginalProgress === 'function') Object.keys(state.originalTransfers).forEach(renderOriginalProgress);
    if (typeof renderActivePeerList === 'function') renderActivePeerList();
    if (typeof renderChatPeerIndicator === 'function') renderChatPeerIndicator();
}

// ----- Beide: eigene Schreibzugriffe melden, fremde neu lesen -----
function coreLinkNotifyWrite(store, valueOrKey, op = 'put') {
    if (!coreLink.channel || coreLink.applying > 0 || !['core', 'ui'].includes(APP_ROLE)) return;
    const key = op === 'put' && valueOrKey && typeof valueOrKey === 'object'
        ? valueOrKey.id ?? valueOrKey.operationId ?? valueOrKey.slot ?? valueOrKey.cacheKey ?? null
        : valueOrKey;
    const peerId = op === 'put' && valueOrKey && typeof valueOrKey === 'object' && typeof valueOrKey.peerId === 'string' ? valueOrKey.peerId : null;
    if (store === 'keys' && typeof key === 'string' && CORE_QUIET_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) return;
    if (store === 'gridPeers' || store === 'media') return;
    corePost({ kind: 'db', store, key: typeof key === 'string' || typeof key === 'number' ? key : null, peerId, op });
}

function scheduleCoreReload(message) {
    const pending = coreLink.reload;
    if (message.store === 'messages' || message.store === 'chatOperations') {
        if (message.peerId) pending.chats.add(message.peerId);
        pending.list = true;
    } else if (message.store === 'profiles') {
        if (message.key) pending.profiles.add(String(message.key));
    } else if (message.store === 'localProfile') {
        pending.own = true;
    } else if (message.store === 'keys') {
        pending.keys = true;
        pending.list = true;
    } else if (message.store === 'albums') {
        pending.albums = true;
    } else if (message.store === 'statusUpdates') {
        pending.statuses = true;
    }
    clearTimeout(coreLink.reloadTimer);
    coreLink.reloadTimer = setTimeout(() => applyCoreReload().catch(error => logDebug(`Core reload failed: ${error.message}`)), CORE_RELOAD_DELAY_MS);
}

// Genau das Geaenderte aus der gemeinsamen DB lesen; eigene Schreibzugriffe dabei nicht zurueckmelden.
async function applyCoreReload() {
    const pending = coreLink.reload;
    coreLink.reload = { chats: new Set(), profiles: new Set(), keys: false, list: false, own: false, albums: false, statuses: false };
    coreLink.applying += 1;
    try {
        if (pending.own && typeof loadMyLocalProfile === 'function') await loadMyLocalProfile();
        if (pending.keys) {
            for (const loader of ['loadChatScopes', 'loadFriendState', 'loadGroups', 'loadGroupCards', 'loadDevices', 'loadContactDevices', 'loadChatReads', 'loadMatchState', 'loadInteractions']) {
                if (typeof window[loader] === 'function') await window[loader]().catch(error => logDebug(`${loader} failed: ${error.message}`));
            }
        }
        for (const peerId of pending.profiles) await reloadCachedProfile(peerId);
        for (const peerId of pending.chats) {
            if (state.chats[peerId] || state.activeChatPeerId === peerId) await loadChatHistory(peerId);
        }
        if (pending.list && typeof loadChatPeerIds === 'function') await loadChatPeerIds();
        if (pending.albums && typeof loadAlbums === 'function') await loadAlbums().catch(() => {});
        if (pending.statuses && typeof loadStatuses === 'function') await loadStatuses().catch(() => {});
    } finally {
        coreLink.applying -= 1;
    }
    if (typeof renderActivePeerList === 'function') renderActivePeerList();
    if (state.activeChatPeerId && (pending.chats.has(state.activeChatPeerId) || pending.keys) && typeof renderChatHistory === 'function') renderChatHistory();
    if (pending.profiles.size && typeof renderDiscoveryGrid === 'function') renderDiscoveryGrid();
}

async function reloadCachedProfile(peerId) {
    const record = await databaseRequest('profiles', 'readonly', store => store.get(peerId)).catch(() => null);
    const profile = record ? await decryptStoredProfile(record).catch(() => null) : null;
    if (profile && !profile.isMe) state.cachedProfiles[peerId] = profile;
    else if (!record) delete state.cachedProfiles[peerId];
}

// ----- K3: Antworten weiterreichen, Secure-Snap-Stream als Einzelbilder -----
// Kern: true = an die Oberflaeche gegeben (der Kern behandelt die Nachricht dann nicht selbst).
function coreForwardToUi(peerId, payload, deliveredVia) {
    if (APP_ROLE !== 'core' || !coreUiConnected() || !CORE_FORWARDED_PAYLOADS.includes(payload?.type)) return false;
    corePost({ kind: 'payload', peerId, payload, via: deliveredVia });
    return true;
}

// Kern: den Video-Track eines Secure-Snap-Streams unsichtbar abspielen und Einzelbilder weitergeben. Bilddaten
// bleiben im Arbeitsspeicher (wie beim Abspielen im Video-Element); gespeichert wird nichts.
function relayCoreSnapStream(stream) {
    if (APP_ROLE !== 'core' || !coreUiConnected() || !stream) return false;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.play().catch(() => {});
    const startedAt = Date.now();
    const timer = setInterval(async () => {
        const ended = !stream.active || stream.getVideoTracks().every(track => track.readyState === 'ended');
        if (ended || Date.now() - startedAt > CORE_SNAP_RELAY_MAX_MS || !coreUiConnected()) {
            clearInterval(timer);
            video.srcObject = null;
            corePost({ kind: 'snapframe', streamId: stream.id, bitmap: null });
            return;
        }
        if (video.readyState < 2 || !video.videoWidth) return;
        try {
            corePost({ kind: 'snapframe', streamId: stream.id, bitmap: await createImageBitmap(video) });
        } catch (error) {
            logDebug(`Snap frame failed: ${error.message}`);
        }
    }, CORE_SNAP_FRAME_MS);
    return true;
}

// Oberflaeche: Einzelbild in den Betrachter zeichnen; das erste startet die Anzeige (wie "playing" beim Video).
function receiveCoreSnapFrame(streamId, bitmap) {
    const viewing = state.secureSnapViewing;
    if (!viewing || viewing.streamId !== streamId || viewing.phase !== 'streaming') {
        // Kann vor SNAP_STREAM_START kommen: das letzte Bild aufheben.
        if (bitmap) state.pendingSnapFrames = { ...(state.pendingSnapFrames || {}), [streamId]: bitmap };
        else if (state.pendingSnapFrames) delete state.pendingSnapFrames[streamId];
        return;
    }
    if (!bitmap) return;
    const canvas = document.getElementById('secure-snap-image');
    if (!canvas) return;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
    }
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    canvas.classList.remove('hidden');
    document.getElementById('secure-snap-video')?.classList.add('hidden');
    if (typeof startSecureSnapPlayback === 'function') startSecureSnapPlayback(viewing);
}

// Oberflaeche: SNAP_STREAM_START angenommen; ein schon angekommenes Bild sofort zeigen.
function takePendingCoreSnapFrame(streamId) {
    const bitmap = state.pendingSnapFrames?.[streamId];
    if (!bitmap) return;
    delete state.pendingSnapFrames[streamId];
    receiveCoreSnapFrame(streamId, bitmap);
}

// Kern: Sprach-Rest (Original) fertig -> die wartende Wiedergabe in der Oberflaeche geht weiter.
function notifyCoreOriginalReady(messageId) {
    if (APP_ROLE === 'core' && coreUiConnected()) corePost({ kind: 'original-ready', messageId });
}

