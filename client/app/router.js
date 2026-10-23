// ================= ROUTING =================
// Echte Pfade fuer Tabs und Chats, damit Refresh den Zustand behaelt und die
// Zurueck-Geste auf Smartphones innerhalb der App navigiert.
const TAB_PATHS = {
    grid: '/grid',
    chat: '/chat',
    editprofile: '/profile',
    keys: '/settings',
    cloud: '/cloud'
};

function routeForTab(tabName) {
    if (tabName === 'chat' && state.activeChatPeerId) return `/chat/${encodeURIComponent(state.activeChatPeerId)}`;
    return TAB_PATHS[tabName] || TAB_PATHS.grid;
}

function parseRoute(pathname = window.location.pathname) {
    const chatMatch = pathname.match(/^\/chat\/([^/]+)\/?$/);
    if (chatMatch) return { tab: 'chat', peerId: decodeURIComponent(chatMatch[1]) };
    const normalized = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
    const tab = Object.keys(TAB_PATHS).find(key => TAB_PATHS[key] === normalized);
    return { tab: tab || 'grid', peerId: null };
}

// Wird von switchTab aufgerufen. Liegt oben ein Modal-Eintrag, wird er ersetzt,
// damit "Zurueck" nicht wieder ins geschlossene Modal fuehrt.
function syncRoute(tabName) {
    if (state.applyingRoute) return;
    const path = routeForTab(tabName);
    const onModalEntry = Boolean(window.history.state?.modal);
    if (path === window.location.pathname && !onModalEntry) return;
    const from = onModalEntry ? window.history.state.from || null : window.location.pathname;
    const method = onModalEntry ? 'replaceState' : 'pushState';
    window.history[method]({ route: path, from }, '', path);
    state.routePath = path;
}

function replaceRoute(path) {
    window.history.replaceState({ route: path, from: window.history.state?.from || null }, '', path);
    state.routePath = path;
}

// Modals bekommen einen eigenen History-Eintrag, damit "Zurueck" sie schliesst.
function pushModalEntry(name, hide) {
    state.openModal = { name, hide };
    window.history.pushState({ ...(window.history.state || {}), modal: name }, '', window.location.href);
}

// Schliessen per Knopf: den Modal-Eintrag per history.back() abbauen, der
// popstate-Handler blendet das Modal dann aus.
function dismissModalEntry(name, hide) {
    if (window.history.state?.modal === name && state.openModal?.name === name) {
        window.history.back();
        return;
    }
    if (state.openModal?.name === name) state.openModal = null;
    hide();
}

// Schliessen, weil direkt danach navigiert wird: kein history.back(), der
// naechste syncRoute ersetzt den Modal-Eintrag.
function hideModalForNavigation(name, hide) {
    if (state.openModal?.name === name) state.openModal = null;
    hide();
}

async function applyRoute({ tab, peerId }) {
    state.applyingRoute = true;
    try {
        if (tab === 'chat' && peerId) {
            if (state.activeChatPeerId !== peerId) await openChatWithPeer(peerId);
            else switchTab('chat');
        } else {
            if (tab === 'chat' && state.activeChatPeerId) leaveActiveChat();
            switchTab(tab);
        }
    } finally {
        state.applyingRoute = false;
    }
}

function handlePopState() {
    const modal = state.openModal;
    if (modal && window.history.state?.modal !== modal.name) {
        state.openModal = null;
        modal.hide();
    }
    // Nur ein Modal wurde geschlossen: Tab und Scrollposition bleiben.
    if (window.location.pathname === state.routePath) return;
    state.routePath = window.location.pathname;
    applyRoute(parseRoute()).catch(error => logDebug(`Could not apply route: ${error.message}`));
}

// Startroute: alte Deep Links (/?chat=<id>) und "/" werden auf echte Pfade umgeschrieben.
function resolveInitialRoute() {
    const legacyChatPeerId = new URLSearchParams(window.location.search).get('chat');
    const route = legacyChatPeerId ? { tab: 'chat', peerId: legacyChatPeerId } : parseRoute();
    const path = route.peerId ? `/chat/${encodeURIComponent(route.peerId)}` : TAB_PATHS[route.tab];
    window.history.replaceState({ route: path, from: null }, '', path);
    state.routePath = path;
    return route;
}
