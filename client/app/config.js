const DEBUG_MODE_STORAGE_KEY = 'opengrid-debug-mode';

// Lokaler Platzhalter statt externer Bild-Dienste (offline nutzbar, keine IP an Dritte).
const AVATAR_PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1e293b"/>'
    + '<circle cx="50" cy="38" r="18" fill="#475569"/><path d="M16 92c4-20 18-30 34-30s30 10 34 30z" fill="#475569"/></svg>'
);

// Alte Profile koennen noch eine externe Platzhalter-URL als Avatar haben.
function localAvatar(avatar) {
    return typeof avatar === 'string' && avatar.startsWith('data:image/') ? avatar : AVATAR_PLACEHOLDER;
}
const CONFIG = { DEBUG_MODE: loadDebugModePreference(), DEFAULT_GEOHASH: 'u10j2k' };
document.documentElement.classList.toggle('debug-on', CONFIG.DEBUG_MODE);

// Schriftgroesse der Chatnachrichten, pro Geraet (wie der Debug-Modus).
const CHAT_FONT_SIZES = { small: 13, normal: 15, large: 17, xlarge: 19 };
const CHAT_FONT_SIZE_STORAGE_KEY = 'opengrid-chat-font-size';

function loadChatFontSize() {
    try {
        const stored = window.localStorage.getItem(CHAT_FONT_SIZE_STORAGE_KEY);
        return CHAT_FONT_SIZES[stored] ? stored : 'normal';
    } catch {
        return 'normal';
    }
}

function applyChatFontSize(size) {
    document.documentElement.style.setProperty('--chat-font-size', `${CHAT_FONT_SIZES[size] || CHAT_FONT_SIZES.normal}px`);
}

applyChatFontSize(loadChatFontSize());

const DEFAULT_PROFILE_SCHEMA = [
    { key: 'displayName', label: 'Display Name', type: 'string', required: true, default: 'Alex' },
    { key: 'age', label: 'Age', type: 'number', min: 18, max: 99, default: 26 },
    { key: 'role', label: 'Position / Role', type: 'select', options: ['Top', 'Bottom', 'Versatile', 'Side'], default: 'Versatile' },
    { key: 'bio', label: 'About Me', type: 'description', default: 'Privacy-first tech enthusiast!' }
];
let PROFILE_SCHEMA = loadInjectedProfileSchema();

const state = {
    nodeId: getOrCreateNodeId(),
    registrationId: window.crypto.randomUUID(),
    routerAuthToken: window.localStorage.getItem('opengrid-router-auth-token'),
    tabStartedAt: Date.now(),
    myProfile: {
        id: null,
        geohash: CONFIG.DEFAULT_GEOHASH,
        avatar: null,
        fields: { displayName: 'Alex', age: 26, role: 'Versatile', bio: 'Privacy-first tech enthusiast!' },
        gallery: [],
        version: 1,
        updatedAt: Date.now(),
        isMe: true
    },
    myKeys: null,
    storageKey: null,
    cachedProfiles: {},
    peers: [],
    activeChatPeerId: null,
    activeModalPeerId: null,
    chats: {},
    ws: null,
    shouldReconnect: true,
    tabChannel: null,
    gridFetchInFlight: false,
    webrtcConnections: {},
    dataChannels: {},
    pendingIceCandidates: {},
    connectionAttempts: {},
    makingOffer: {},
    ignoreOffer: {},
    disconnectTimers: {},
    connectionRetryCounts: {},
    sessionKeys: {},
    secureMessageQueues: {},
    presenceProbes: {},
    peerChatFocus: {},
    // Match-Zustand pro Peer (aus MATCH_PING/MATCH_RESET, siehe matching.js). Muss vor dem
    // ersten Rendern der Chatliste existieren.
    matchState: {},
    // App-Modus (P8): vom Server erlaubte Modi, gewaehlter Modus und Event-Daten.
    appConfig: { modes: ['discovery', 'chat', 'friends', 'event'], defaultMode: 'discovery' },
    appMode: 'discovery',
    appModeSettings: {},
    eventExpiryTimer: null,
    pendingInvite: null,
    // Online-Status der Chat-Partner (nur gegenseitig, vom Server per PRESENCE gemeldet).
    peerPresence: {},
    presenceSubscription: [],
    // Sichtbarkeit und Speicher. Fehlender Datensatz = Standardwerte.
    gridSettings: { silent: false, ttlMinutes: 10, liveGrid: false, cacheEnabled: true, useLocation: false, safeZones: [], locationLabel: null },
    gridRing: 0,
    routePath: null,
    applyingRoute: false,
    modalStack: [],
    replyToMessageId: null,
    chatSearch: '',
    chatStarredOnly: false,
    gridHasMore: false,
    chatFocusPeerId: null,
    chatSyncInProgress: {},
    peerIdentityKeys: {},
    cacheFetchInFlight: false,
    chatPeerIds: [],
    // Letzte sichtbare Nachricht pro Chat fuer die Chatliste: { text, at, mine }.
    chatPreviews: {},
    chatControls: {},
    pendingImageRequests: {},
    debugLogBuffer: [],
    mediaStream: null,
    snapFacingMode: 'user',
    snapDraft: null,
    albums: {},
    albumViewer: null,
    pendingAlbumRequests: {},
    mediaOverviewFilter: 'all',
    albumKeys: {},
    pendingAlbumKeyRequests: {},
    snapSettings: { secureSnaps: false, views: 1, seconds: 10 },
    secureSnapViewing: null,
    outgoingSnapStreams: {},
    pendingSnapTracks: {},
    serverTime: null,
    serviceWorkerRegistration: null,
    updateRequested: false,
    offlineBannerTimer: null,
    persistedRouterAuthToken: null,
    pushSubscriptionSynced: false
};

let db = null;
const API_BASE = window.location.origin;
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${window.location.host}/ws`;

function peerAuthHeaders(headers = {}) {
    return state.routerAuthToken
        ? { ...headers, Authorization: `Bearer ${state.routerAuthToken}` }
        : headers;
}

// Debug ist standardmaessig aus und wird pro Browser in localStorage gemerkt.
function loadDebugModePreference() {
    try {
        return window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY) === 'on';
    } catch {
        return false;
    }
}

function loadInjectedProfileSchema() {
    try {
        const rawSchema = document.getElementById('profile-schema-data')?.textContent.trim();
        if (!rawSchema || rawSchema.startsWith('{{')) return DEFAULT_PROFILE_SCHEMA;
        const schema = JSON.parse(rawSchema);
        return validateProfileSchema(schema);
    } catch (error) {
        console.error('Could not parse injected profile schema.', error);
        return DEFAULT_PROFILE_SCHEMA;
    }
}

function validateProfileSchema(schema) {
    if (!Array.isArray(schema) || schema.length === 0) {
        throw new Error('Profile schema must be a non-empty array.');
    }

    const supportedTypes = new Set(['string', 'number', 'select', 'multiselect', 'description', 'tag']);
    schema.forEach((field) => {
        if (!field || typeof field.key !== 'string' || typeof field.label !== 'string') {
            throw new Error('Each schema field requires a key and label.');
        }
        if (field.type && !supportedTypes.has(field.type)) {
            throw new Error(`Unsupported field type: ${field.type}`);
        }
        if (['select', 'multiselect'].includes(field.type) && !Array.isArray(field.options)) {
            throw new Error(`Field "${field.key}" requires an options array.`);
        }
    });
    return schema;
}

function getOrCreateNodeId() {
    const storageKey = 'opengrid-node-id';
    const persistentId = window.localStorage.getItem(storageKey);
    if (persistentId) {
        window.sessionStorage.setItem(storageKey, persistentId);
        return persistentId;
    }

    const sessionId = window.sessionStorage.getItem(storageKey);
    if (sessionId) {
        window.localStorage.setItem(storageKey, sessionId);
        return sessionId;
    }

    const nodeId = `node_${window.crypto.randomUUID()}`;
    window.sessionStorage.setItem(storageKey, nodeId);
    window.localStorage.setItem(storageKey, nodeId);
    return nodeId;
}
