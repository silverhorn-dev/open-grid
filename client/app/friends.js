// ================= FREUNDE (Chat- und Freunde-Modus) =================
// Gleiche Mechanik wie Flamme/Match (matching.js), eigene Beziehung: "Adden" schickt eine Anfrage
// (FRIEND_PING), zurueck-adden nimmt an, ablehnen/entfernen = FRIEND_RESET. Freunde sehen das volle
// Profil und den Status. Verschluesselte Chat-Operationen per P2P oder Pfad C, der Server weiss nichts.
// Getrennte Chatlisten: jeder Chat gehoert zu "Grid & Event" (discovery) oder "Chat & Freunde"
// (social), festgelegt beim ersten Nachrichtenaustausch; Freunde wandern nach "social".
const FRIEND_OPERATION_TYPES = ['FRIEND_PING', 'FRIEND_RESET'];
const CHAT_SCOPES = ['discovery', 'social'];
const CHAT_SCOPE_RECORD_ID = 'chat-scopes';

function emptyFriendEntry() {
    return { sentAt: 0, receivedAt: 0, resetAt: 0 };
}

function getFriendEntry(peerId) {
    return state.friendState[peerId] || emptyFriendEntry();
}

function isFriend(peerId) {
    const entry = getFriendEntry(peerId);
    return entry.sentAt > entry.resetAt && entry.receivedAt > entry.resetAt;
}

// Eigene Einstellung: duerfen Matches aus Grid/Event mich adden? Bei "Nur Entdecken" nie
// (der gespeicherte Schalterwert bleibt fuer einen spaeteren Wechsel erhalten).
function allowsMatchFriends() {
    if (typeof scopeIncludes === 'function' && !scopeIncludes('social')) return false;
    return state.myProfile.allowMatchFriends !== false;
}

// Flag aus dem Profil des anderen (fehlt = erlaubt).
function peerAllowsMatchFriends(peerId) {
    return state.cachedProfiles[peerId]?.allowMatchFriends !== false;
}

// "Adden" bei einem Grid-/Event-Match: nur nach dem Match und wenn beide es erlauben.
function canAddMatch(peerId) {
    return isMatched(peerId) && allowsMatchFriends() && peerAllowsMatchFriends(peerId);
}

// Anfragen aus "Grid & Event" zaehlen nur nach einem Match und wenn man es erlaubt (Schutz gegen
// Clients, die den Knopf trotz Profil-Flag anbieten): sonst keine Meldung und kein "Annehmen".
function acceptsFriendRequestFrom(peerId) {
    if (typeof scopeIncludes === 'function' && !scopeIncludes('social')) return false;
    if (chatScopeOf(peerId) !== 'discovery') return true;
    return isMatched(peerId) && allowsMatchFriends();
}

// Offene Anfrage an mich (noch nicht angenommen).
function hasFriendRequest(peerId) {
    const entry = getFriendEntry(peerId);
    return entry.receivedAt > entry.resetAt && !isFriend(peerId) && acceptsFriendRequestFrom(peerId);
}

function hasSentFriendRequest(peerId) {
    const entry = getFriendEntry(peerId);
    return entry.sentAt > entry.resetAt && !isFriend(peerId);
}

// Match (Grid/Event) oder Freundschaft: beides hebt Chat-Einschraenkungen auf und gibt das Profil frei.
function isConnectedPeer(peerId) {
    return isMatched(peerId) || isFriend(peerId);
}

function recordFriendOperation(peerId, operation) {
    const entry = { ...getFriendEntry(peerId) };
    const at = operation.createdAt || 0;
    if (operation.type === 'FRIEND_PING') {
        if (operation.actorId === state.myProfile.id) entry.sentAt = Math.max(entry.sentAt, at);
        else entry.receivedAt = Math.max(entry.receivedAt, at);
    } else if (operation.type === 'FRIEND_RESET') {
        entry.resetAt = Math.max(entry.resetAt, at);
    }
    state.friendState[peerId] = entry;
}

async function loadFriendState() {
    const operations = await getAllDatabaseRecords('chatOperations').catch(() => []);
    state.friendState = {};
    operations
        .filter(operation => FRIEND_OPERATION_TYPES.includes(operation.type))
        .forEach(operation => recordFriendOperation(operation.peerId, operation));
}

// Aus applyChatOperation: false bei ungueltiger Operation.
async function applyFriendOperation(peerId, operation) {
    if (operation.actorId !== peerId && operation.actorId !== state.myProfile.id) return false;
    const wasFriend = isFriend(peerId);
    recordFriendOperation(peerId, operation);
    rememberChatPeer(peerId);
    const nowFriend = isFriend(peerId);
    if (wasFriend !== nowFriend) syncChatGate();
    const name = getPeerPresentation(peerId).name || HIDDEN_PEER_NAME;
    if (!wasFriend && nowFriend) {
        await setChatScope(peerId, 'social');
        await releaseHeldMessages(peerId);
        pushStatusesToPeer(peerId).catch(logBackgroundError('applyFriendOperation'));
        if (operation.actorId === peerId) showToast(t('friends.andYouAreFriendsNow', { name }), 'success');
        sendSecurePayload(peerId, { type: 'PROFILE_REQUEST' }).catch(logBackgroundError('applyFriendOperation'));
    } else if (operation.type === 'FRIEND_PING' && operation.actorId === peerId && !nowFriend) {
        // Neue Kontakte (noch ohne Liste) gehoeren nach "Chat & Freunde"; Grid-Kontakte nur nach Match.
        await ensureChatScope(peerId, 'social');
        if (acceptsFriendRequestFrom(peerId)) showToast(t('friends.wantsToAddYou', { name }), 'info');
    }
    if (wasFriend && !nowFriend) {
        delete state.statusPushes[peerId];
        await forgetStatusesOf(peerId);
        sendSecurePayload(peerId, { type: 'PROFILE_REQUEST' }).catch(logBackgroundError('applyFriendOperation'));
    }
    renderFriendUi(peerId);
    return true;
}

async function sendFriendOperation(peerId, type) {
    const operation = {
        operationId: `${type === 'FRIEND_PING' ? 'friend' : 'unfriend'}:${window.crypto.randomUUID()}`,
        peerId,
        type,
        actorId: state.myProfile.id,
        createdAt: Date.now()
    };
    await applyChatOperation(peerId, operation);
    const { peerId: _localPeerId, ...sharedOperation } = operation;
    // Mit Rueckruf: ohne direkte Verbindung nach 10 s ueber Pfad C (ohne Push), statt nur beim
    // naechsten Chat-Sync.
    await sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation: sharedOperation }, () => {});
}

// Anfrage senden oder eine erhaltene annehmen.
async function addFriend(peerId) {
    if (!peerId || isPeerBlocked(peerId) || isFriend(peerId) || hasSentFriendRequest(peerId)) return;
    if (chatScopeOf(peerId) === 'discovery' && !canAddMatch(peerId)) return;
    await sendFriendOperation(peerId, 'FRIEND_PING');
    showToast(isFriend(peerId) ? t('friends.youAreFriendsNow') : t('friends.requestSent2'), 'success');
}

// Ablehnen, zurueckziehen oder entfernen: alles setzt die Beziehung zurueck.
async function resetFriendship(peerId) {
    if (!peerId) return;
    if (isFriend(peerId) && !window.confirm(t('friends.reallyEndFriendshipStatusAnd'))) return;
    await sendFriendOperation(peerId, 'FRIEND_RESET');
}

// ----- Getrennte Chatlisten -----
// Liste, die gerade angezeigt wird: die des App-Modus, oder die per Listen-Wechsel gewaehlte
// ("nur Liste ansehen", chat-switch.js).
function modeChatScope() {
    return isSocialMode() ? 'social' : 'discovery';
}

function currentChatScope() {
    return state.chatListScopeOverride || modeChatScope();
}

async function loadChatScopes() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(CHAT_SCOPE_RECORD_ID)).catch(() => null);
    state.chatScopes = Object.fromEntries(Object.entries(stored?.scopes || {}).filter(([, scope]) => CHAT_SCOPES.includes(scope)));
}

async function setChatScope(peerId, scope) {
    if (!CHAT_SCOPES.includes(scope) || state.chatScopes[peerId] === scope) return;
    state.chatScopes = { ...state.chatScopes, [peerId]: scope };
    await putDatabaseRecord('keys', { id: CHAT_SCOPE_RECORD_ID, scopes: state.chatScopes })
        .catch(error => logDebug(`Could not store chat scopes: ${error.message}`));
    renderActivePeerList();
}

// Nur setzen, wenn der Chat noch keiner Liste gehoert.
async function ensureChatScope(peerId, scope) {
    if (!state.chatScopes[peerId]) await setChatScope(peerId, scope);
}

function chatScopeOf(peerId) {
    if (isFriend(peerId)) return 'social';
    return state.chatScopes[peerId] || null;
}

// Alte Chats ohne Zuordnung erscheinen in beiden Listen.
function isInCurrentChatList(peerId) {
    const scope = chatScopeOf(peerId);
    return !scope || scope === currentChatScope();
}

// ----- Entdecken-Verlauf im Freundes-Chat -----
// Es gibt pro Person nur einen Verlauf; jede Nachricht traegt den Bereich, in dem sie geschrieben wurde
// (`scope`). Ist aus dem Match ein Freund geworden (Chat in "Chat & Freunde"), blendet der Chat die
// Entdecken-Nachrichten standardmaessig aus (Einstellung, Router-Standard `hideDiscoveryHistory`).
// Pro Chat laesst sich das umdrehen (`flipped`). Ist der Entdecken-Bereich hier aus, bleibt der Teil
// immer verborgen. Nur Anzeige: nichts wird geloescht, das Gegenueber merkt nichts.
const DISCOVERY_HISTORY_RECORD_ID = 'discovery-history';

async function loadDiscoveryHistorySetting() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(DISCOVERY_HISTORY_RECORD_ID)).catch(() => null);
    const routerDefault = clientDefault('hideDiscoveryHistory', true);
    state.discoveryHistory = {
        hide: typeof stored?.hide === 'boolean' ? stored.hide : routerDefault !== false,
        flipped: Array.isArray(stored?.flipped) ? stored.flipped.filter(id => typeof id === 'string').slice(0, 1000) : []
    };
    renderDiscoveryHistorySetting();
}

async function saveDiscoveryHistory() {
    try {
        await putDatabaseRecord('keys', { id: DISCOVERY_HISTORY_RECORD_ID, ...state.discoveryHistory });
    } catch (error) {
        logDebug(`Could not store discovery history setting: ${error.message}`);
        showToast(t('common.settingCouldNotBeSaved'), 'error');
    }
}

async function updateDiscoveryHistorySetting(hide) {
    // Neue Grundeinstellung gilt fuer alle Chats; einzelne Umschaltungen verfallen.
    state.discoveryHistory = { hide: Boolean(hide), flipped: [] };
    await saveDiscoveryHistory();
    renderDiscoveryHistorySetting();
    if (state.activeChatPeerId) renderChatHistory();
}

function renderDiscoveryHistorySetting() {
    const toggle = document.getElementById('discovery-history-toggle');
    if (toggle) toggle.checked = state.discoveryHistory.hide;
}

// Betrifft dieser Chat den Entdecken-Verlauf? (Freundes-Chat mit Nachrichten aus "Entdecken")
function hasDiscoveryHistory(peerId, messages = state.chats[peerId] || []) {
    return chatScopeOf(peerId) === 'social' && messages.some(message => message.scope === 'discovery' && !message.held);
}

function isDiscoveryHistoryHidden(peerId) {
    if (!scopeIncludes('discovery')) return true;
    return state.discoveryHistory.hide !== state.discoveryHistory.flipped.includes(peerId);
}

function isDiscoveryMessageHidden(peerId, message) {
    return message?.scope === 'discovery' && chatScopeOf(peerId) === 'social' && isDiscoveryHistoryHidden(peerId);
}

async function toggleDiscoveryHistory(peerId = state.activeChatPeerId) {
    if (!peerId || !scopeIncludes('discovery')) return;
    const flipped = new Set(state.discoveryHistory.flipped);
    if (flipped.has(peerId)) flipped.delete(peerId);
    else flipped.add(peerId);
    state.discoveryHistory = { ...state.discoveryHistory, flipped: [...flipped] };
    await saveDiscoveryHistory();
    if (state.activeChatPeerId === peerId) renderChatHistory();
}

// Zeile oben im Verlauf: "Entdecken-Verlauf ausgeblendet (N)" bzw. "... ausblenden". Nur mit aktivem
// Entdecken-Bereich, sonst gibt es nichts umzuschalten.
function createDiscoveryHistoryToggle(peerId, messages) {
    if (!scopeIncludes('discovery') || !hasDiscoveryHistory(peerId, messages)) return null;
    const hidden = isDiscoveryHistoryHidden(peerId);
    const count = messages.filter(message => message.scope === 'discovery' && !message.held).length;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'discovery-history-toggle';
    button.dataset.click = 'toggleDiscoveryHistory';
    button.dataset.args = JSON.stringify([peerId]);
    const icon = document.createElement('i');
    icon.className = `fa-solid ${hidden ? 'fa-eye' : 'fa-eye-slash'}`;
    const label = document.createElement('span');
    label.textContent = hidden ? t('friends.discoveryHistoryHidden', { count }) : t('friends.hideDiscoveryHistory');
    button.append(icon, label);
    return button;
}

// ----- UI -----
function renderFriendUi(peerId) {
    renderActivePeerList();
    if (state.activeModalPeerId === peerId) renderProfileMatchActions(peerId);
    if (state.activeChatPeerId === peerId) {
        updateChatActionButtons();
        renderChatAllowance();
    }
}

function friendButton(label, icon, className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `text-xs px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 ${className}`;
    button.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    button.appendChild(document.createTextNode(` ${label}`));
    button.onclick = onClick;
    return button;
}

// Profil-Aktionen im Chat-/Freunde-Modus (statt Flamme).
function renderProfileFriendActions(container, peerId) {
    const status = document.createElement('div');
    status.className = 'text-xs text-slate-400 flex items-center gap-1.5';
    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-2';
    const primary = 'bg-brand-600 hover:bg-brand-500 text-white';
    const secondary = 'border border-slate-700 text-slate-300 hover:bg-slate-800';
    if (isFriend(peerId)) {
        status.innerHTML = '<i class="fa-solid fa-user-check text-emerald-400"></i>';
        status.appendChild(document.createTextNode(` ${t('friends.youAreFriends')}`));
        actions.appendChild(friendButton(t('common.remove'), 'fa-user-minus', secondary, () => resetFriendship(peerId)));
    } else if (hasFriendRequest(peerId)) {
        status.textContent = t('common.wantsToAddYou');
        actions.append(
            friendButton(t('friends.accept'), 'fa-user-plus', primary, () => addFriend(peerId)),
            friendButton(t('friends.decline'), 'fa-xmark', secondary, () => resetFriendship(peerId))
        );
    } else if (hasSentFriendRequest(peerId)) {
        status.textContent = t('friends.requestSent');
        actions.appendChild(friendButton(t('friends.withdraw'), 'fa-rotate-left', secondary, () => resetFriendship(peerId)));
    } else {
        actions.appendChild(friendButton(t('common.add'), 'fa-user-plus', primary, () => addFriend(peerId)));
    }
    container.append(status, actions);
}
