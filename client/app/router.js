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
// Sie koennen gestapelt sein (z. B. Bildbetrachter ueber einem Album).
function pushModalEntry(name, hide) {
    state.modalStack.push({ name, hide });
    window.history.pushState(
        { ...(window.history.state || {}), modal: name, modalDepth: state.modalStack.length },
        '',
        window.location.href
    );
}

function removeModalFromStack(name) {
    const index = state.modalStack.map(modal => modal.name).lastIndexOf(name);
    if (index >= 0) state.modalStack.splice(index, 1);
}

// Schliessen per Knopf: den Modal-Eintrag per history.back() abbauen, der
// popstate-Handler blendet das Modal dann aus.
function dismissModalEntry(name, hide) {
    const top = state.modalStack[state.modalStack.length - 1];
    if (window.history.state?.modal === name && top?.name === name) {
        window.history.back();
        return;
    }
    removeModalFromStack(name);
    hide();
}

// Schliessen, weil direkt danach navigiert wird: kein history.back(), der
// naechste syncRoute ersetzt den Modal-Eintrag.
function hideModalForNavigation(name, hide) {
    removeModalFromStack(name);
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
            // Im Modus "Nur Chat" gibt es kein Grid.
            switchTab(tab === 'grid' && typeof isGridAvailable === 'function' && !isGridAvailable() ? 'chat' : tab);
        }
    } finally {
        state.applyingRoute = false;
    }
}

function handlePopState() {
    // Alle Modals oberhalb der Tiefe des aktuellen Eintrags schliessen.
    const depth = window.history.state?.modalDepth || 0;
    while (state.modalStack.length > depth) state.modalStack.pop().hide();
    // Nur ein Modal wurde geschlossen: Tab und Scrollposition bleiben.
    if (window.location.pathname === state.routePath) return;
    state.routePath = window.location.pathname;
    applyRoute(parseRoute()).catch(error => logDebug(`Could not apply route: ${error.message}`));
}

// Startroute: alte Deep Links (/?chat=<id>) und "/" werden auf echte Pfade umgeschrieben.
function resolveInitialRoute() {
    // Einladungslink: der Teil nach # wird gemerkt und nach dem Start ausgewertet.
    if (window.location.pathname === '/invite') {
        state.pendingInvite = window.location.hash;
        window.history.replaceState({ route: TAB_PATHS.chat, from: null }, '', TAB_PATHS.chat);
        state.routePath = TAB_PATHS.chat;
        return { tab: 'chat', peerId: null };
    }
    const legacyChatPeerId = new URLSearchParams(window.location.search).get('chat');
    const route = legacyChatPeerId ? { tab: 'chat', peerId: legacyChatPeerId } : parseRoute();
    const path = route.peerId ? `/chat/${encodeURIComponent(route.peerId)}` : TAB_PATHS[route.tab];
    window.history.replaceState({ route: path, from: null }, '', path);
    state.routePath = path;
    return route;
}
