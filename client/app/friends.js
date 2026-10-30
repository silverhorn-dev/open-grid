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

// "Adden" bei einem Grid-/Event-Match: nur nach dem Match und wenn beide es erlauben (wer nur
// "Entdecken" nutzt, erlaubt es nie, siehe allowsMatchFriends).
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
        // Stand der Chat in "Grid & Event" (zugeordnet oder aus einem Match), bleibt dort ein Verweis
        // (chat-list-menu.js). Der eigene erste Text ordnet den Chat nicht zu, daher auch das Match.
        const previousScope = state.chatScopes[peerId] || (isMatched(peerId) ? 'discovery' : null);
        if (previousScope === 'discovery' && typeof markChatMoved === 'function') await markChatMoved(peerId);
        await setChatScope(peerId, 'social');
        await releaseHeldMessages(peerId);
        pushStatusesToPeer(peerId).catch(logBackgroundError('applyFriendOperation'));
        if (operation.actorId === peerId) notifyInApp('add', t('friends.andYouAreFriendsNow', { name }), 'success');
        sendSecurePayload(peerId, { type: 'PROFILE_REQUEST' }).catch(logBackgroundError('applyFriendOperation'));
    } else if (operation.type === 'FRIEND_PING' && operation.actorId === peerId && !nowFriend) {
        // Eine Anfrage verschiebt keinen bestehenden Chat (erst die Freundschaft). Nur ganz neue Kontakte
        // (kein Verlauf, kein Match) gehoeren gleich nach "Chat & Freunde".
        if (!isMatched(peerId) && !(state.chats[peerId] || []).length && !state.chatPreviews?.[peerId]) await ensureChatScope(peerId, 'social');
        if (acceptsFriendRequestFrom(peerId)) notifyInApp('add', t('friends.wantsToAddYou', { name }));
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
    // Mit Rueckruf: ohne direkte Verbindung nach 10 s ueber Pfad C (Anfragen mit Push "Adden"), statt nur
    // beim naechsten Chat-Sync; direkt zugestellt an einen abwesenden Partner per Anstupsen.
    const notifyKind = type === 'FRIEND_PING' ? 'add' : null;
    await sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation: sharedOperation }, path => {
        if (path === 'p2p' && notifyKind) nudgeAwayPeer(peerId, notifyKind);
    }, { notifyKind });
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

// ----- Flirt-Modus im Freundes-Chat -----
// Es gibt pro Person nur einen Verlauf; jede Nachricht traegt den Bereich, in dem sie geschrieben wurde
// (`scope`). Ist aus dem Match ein Freund geworden (Chat in "Chat & Freunde"), schaltet die Flamme
// (Lasche ueber dem Senden-Knopf) pro Chat zwischen normal und Flirt um:
// - Flirt: man sieht alles (Flirt-Nachrichten markiert) und schreibt mit `scope: 'discovery'`.
// - Normal: neue Nachrichten sind `social`; der Flirt-Teil ist ausgeblendet, solange die Einstellung
//   "Flirt-Verlauf ausblenden" an ist (Standard, Router-Standard `hideDiscoveryHistory`).
// Senden lange druecken schickt nur diese eine Nachricht als Flirt. Die Lasche ist ausblendbar
// (Einstellung `tab`, pro Chat `tabHidden`); dann bleiben das Menue im Chat-Kopf und langes Druecken.
// Ist der Entdecken-Bereich hier aus, gibt es keine Flamme und der Flirt-Teil bleibt verborgen.
// Nur Anzeige: nichts wird geloescht, das Gegenueber merkt nichts.
const DISCOVERY_HISTORY_RECORD_ID = 'discovery-history';

async function loadDiscoveryHistorySetting() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(DISCOVERY_HISTORY_RECORD_ID)).catch(() => null);
    const routerDefault = clientDefault('hideDiscoveryHistory', true);
    state.discoveryHistory = {
        hide: typeof stored?.hide === 'boolean' ? stored.hide : routerDefault !== false,
        flirt: peerIdList(stored?.flirt),
        // Im Entdecken-Modus ist der Flirt-Modus an; hier die Chats, in denen man ihn dort ausgeschaltet hat.
        flirtOff: peerIdList(stored?.flirtOff),
        tab: stored?.tab !== false,
        tabHidden: peerIdList(stored?.tabHidden),
        // Wann man den Flirt-Teil eines Chats zuletzt gesehen hat (Punkt an der Lasche fuer Neues danach).
        seen: Object.fromEntries(Object.entries(stored?.seen && typeof stored.seen === 'object' ? stored.seen : {})
            .filter(([peerId, at]) => typeof peerId === 'string' && Number.isFinite(at)).slice(0, 1000))
    };
    renderDiscoveryHistorySetting();
}

function peerIdList(value) {
    return Array.isArray(value) ? value.filter(id => typeof id === 'string').slice(0, 1000) : [];
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
    state.discoveryHistory = { ...state.discoveryHistory, hide: Boolean(hide) };
    await saveDiscoveryHistory();
    renderDiscoveryHistorySetting();
    if (state.activeChatPeerId) renderChatHistory();
}

function renderDiscoveryHistorySetting() {
    const toggle = document.getElementById('discovery-history-toggle');
    if (toggle) toggle.checked = state.discoveryHistory.hide;
    const tab = document.getElementById('flirt-tab-toggle');
    if (tab) tab.checked = state.discoveryHistory.tab;
}

async function updateFlirtTabSetting(show) {
    // Wieder einschalten zeigt die Lasche auch in den einzeln ausgeblendeten Chats.
    state.discoveryHistory = { ...state.discoveryHistory, tab: Boolean(show), tabHidden: show ? [] : state.discoveryHistory.tabHidden };
    await saveDiscoveryHistory();
    renderDiscoveryHistorySetting();
    updateFlirtButton();
}

function isFlirtTabShown(peerId) {
    return canFlirt(peerId) && state.discoveryHistory.tab && !state.discoveryHistory.tabHidden.includes(peerId);
}

async function setFlirtTabHidden(peerId, hidden) {
    const list = new Set(state.discoveryHistory.tabHidden);
    if (hidden) list.add(peerId);
    else list.delete(peerId);
    state.discoveryHistory = { ...state.discoveryHistory, tabHidden: [...list], tab: hidden ? state.discoveryHistory.tab : true };
    await saveDiscoveryHistory();
    renderDiscoveryHistorySetting();
    updateFlirtButton();
}

function hasDiscoveryHistory(peerId, messages = state.chats[peerId] || []) {
    return messages.some(message => message.scope === 'discovery' && !message.held);
}

// Ein Flirt-Teil gibt es nur in Freundes-Chats mit Match UND Nachrichten aus "Entdecken". Eins allein
// reicht nicht: ein Match ohne Flirt-Chat (Flammen im Grid, geschrieben nur in "Chat & Freunde") oder
// als `discovery` markierte Nachrichten ohne Match (aeltere Chats ohne Listen-Zuordnung, aus der
// Grid-Liste beschrieben) machen noch keinen Flirt. Ohne Flirt-Teil wird nichts ausgeblendet.
function hasFlirtPart(peerId) {
    return Boolean(peerId) && chatScopeOf(peerId) === 'social' && isMatched(peerId) && hasDiscoveryHistory(peerId);
}

function canFlirt(peerId) {
    return scopeIncludes('discovery') && hasFlirtPart(peerId);
}

// Entdecken- bzw. Event-Modus aktiv (nicht nur die Liste angesehen).
function inExploringMode() {
    return typeof isSocialMode === 'function' && !isSocialMode();
}

// Chats in beiden Bereichen (Freund mit Flirt-Teil): im Entdecken-Modus automatisch Flirt (abschaltbar,
// `flirtOff`), sonst nur, wenn man ihn eingeschaltet hat (`flirt`).
function isFlirting(peerId) {
    if (!canFlirt(peerId)) return false;
    return inExploringMode()
        ? !(state.discoveryHistory.flirtOff || []).includes(peerId)
        : state.discoveryHistory.flirt.includes(peerId);
}

// Ohne Entdecken-Bereich ist der Flirt-Teil immer weg (zaehlt dann auch nicht als ungelesen).
function isDiscoveryMessageAlwaysHidden(peerId, message) {
    return message?.scope === 'discovery' && !scopeIncludes('discovery') && hasFlirtPart(peerId);
}

function isDiscoveryMessageHidden(peerId, message) {
    if (message?.scope !== 'discovery' || !hasFlirtPart(peerId)) return false;
    if (!scopeIncludes('discovery')) return true;
    return state.discoveryHistory.hide && !isFlirting(peerId);
}

// Bereich fuer eine neue eigene Nachricht. `flirtSendOnce`: Senden lange gedrueckt.
function messageScopeFor(peerId) {
    if (state.flirtSendOnce === peerId) {
        state.flirtSendOnce = null;
        if (canFlirt(peerId)) {
            // Im normalen Chat ist der Flirt-Teil ausgeblendet: sagen, wo die Nachricht hin ist.
            document.getElementById('chat-send-group')?.classList.remove('is-flirt-once');
            document.getElementById('chat-input-bar')?.classList.remove('is-flirt-once');
            if (state.discoveryHistory.hide) showToast(t('friends.sentAsFlirt'), 'info');
            return 'discovery';
        }
    }
    if (isFlirting(peerId)) return 'discovery';
    return chatScopeOf(peerId) || currentChatScope();
}

async function toggleFlirtMode(peerId = state.activeChatPeerId) {
    if (!canFlirt(peerId)) return;
    // Im Entdecken-Modus wird die Ausnahme (aus) umgeschaltet, sonst die Einschaltung.
    const key = inExploringMode() ? 'flirtOff' : 'flirt';
    const list = new Set(state.discoveryHistory[key] || []);
    if (list.has(peerId)) list.delete(peerId);
    else list.add(peerId);
    // Beim Ein- wie beim Ausschalten ist der Flirt-Teil gerade gesehen.
    const seen = { ...state.discoveryHistory.seen, [peerId]: Date.now() };
    state.discoveryHistory = { ...state.discoveryHistory, [key]: [...list], seen };
    await saveDiscoveryHistory();
    if (state.activeChatPeerId === peerId) {
        renderChatHistory();
        updateChatAlbumButton();
        restoreInputFocusAfterFlirtTab();
    }
}

// Lasche ueber dem Senden-Knopf, Eingabeleiste und Menue-Eintraege nachziehen. Im Flirt-Modus wachsen
// Lasche und Senden-Knopf zu einem Block zusammen, das Eingabefeld bekommt einen Rand und eigenen Text.
// Punkt an der Lasche: die neueste Nachricht ist gerade ausgeblendet.
function updateFlirtButton() {
    const peerId = state.activeChatPeerId;
    const available = canFlirt(peerId);
    const flirting = available && isFlirting(peerId);
    const tab = document.getElementById('chat-flirt-tab');
    const tabShown = available && isFlirtTabShown(peerId);
    if (tab) {
        tab.classList.toggle('hidden', !tabShown);
        tab.classList.toggle('is-active', flirting);
        tab.setAttribute('aria-pressed', String(flirting));
        tab.classList.toggle('has-news', available && hasUnseenFlirt(peerId));
    }
    document.getElementById('chat-send-group')?.classList.toggle('is-flirt', flirting);
    document.getElementById('chat-input-bar')?.classList.toggle('is-flirt', flirting);
    document.getElementById('chat-compose-row')?.classList.toggle('is-flirt', flirting);
    // Platz unten im Verlauf, damit die Lasche nie die letzte Nachricht verdeckt.
    document.getElementById('chat-messages')?.classList.toggle('has-flirt-tab', tabShown);
    const input = document.getElementById('chat-input');
    if (input) input.placeholder = flirting ? t('friends.flirtMessagePlaceholder') : t('chat.writeMessage');
    const menuFlirt = document.getElementById('chat-menu-flirt');
    if (menuFlirt) {
        menuFlirt.classList.toggle('hidden', !available);
        const label = document.getElementById('chat-menu-flirt-label');
        if (label) label.textContent = flirting ? t('friends.flirtModeOff') : t('friends.flirtModeOn');
    }
    document.getElementById('chat-menu-flirt-tab')?.classList.toggle('hidden', !available || tabShown);
    updateFlirtTabCollapse();
}

// Neue, gerade ausgeblendete Flirt-Nachrichten des anderen seit dem letzten Blick in den Flirt-Teil.
// Ohne Eintrag (Chat zum ersten Mal mit Lasche) gilt "jetzt": alter Verlauf bekommt keinen Punkt.
function hasUnseenFlirt(peerId) {
    if (isFlirting(peerId)) {
        state.discoveryHistory.seen[peerId] = Date.now();
        return false;
    }
    if (!Number.isFinite(state.discoveryHistory.seen[peerId])) {
        state.discoveryHistory.seen[peerId] = Date.now();
        saveDiscoveryHistory();
        return false;
    }
    const seenAt = state.discoveryHistory.seen[peerId];
    return (state.chats[peerId] || []).some(message => message.senderId === peerId && !message.held && !message.deleted
        && (message.createdAt || 0) > seenAt && isDiscoveryMessageHidden(peerId, message));
}

// ----- Medien-Knopf (Entdecken/Event und Flirt-Modus) -----
// Dort stehen Album und Video nicht einzeln in der Leiste, sondern hinter einem Knopf mit einem Menue,
// das nach oben aufklappt (sichtbar per `media-combined`, chat-tools.js). Die Leiste bleibt so schmal.
function toggleComposeMediaMenu(force = null) {
    const menu = document.getElementById('chat-media-menu');
    const button = document.getElementById('chat-media-btn');
    if (!menu || !button) return;
    const open = force === null ? menu.classList.contains('hidden') : force;
    menu.classList.toggle('hidden', !open);
    button.setAttribute('aria-expanded', String(open));
}

function closeComposeMediaMenu() {
    toggleComposeMediaMenu(false);
}

function composeMediaAlbum() {
    closeComposeMediaMenu();
    openAlbumPicker();
}

function composeMediaVideo() {
    closeComposeMediaMenu();
    pickChatVideo();
}

// Weit hochgescrollt (ab einem halben Bildschirm): Lasche faehrt zu einem schmalen Streifen ueber dem
// Senden-Knopf ein, der stoert beim Lesen nicht. Tippen auf den Streifen oder ins Eingabefeld klappt sie
// wieder aus (ohne umzuschalten); unten angekommen kommt sie von selbst zurueck.
function updateFlirtTabCollapse(container = document.getElementById('chat-messages')) {
    const bar = document.getElementById('chat-input-bar');
    if (!bar || !container) return;
    const far = chatDistanceFromBottom(container) > container.clientHeight / 2;
    if (!far) state.flirtTabPinnedOpen = false;
    bar.classList.toggle('flirt-tab-collapsed', far && !state.flirtTabPinnedOpen);
}

function chatMenuToggleFlirt() {
    closeChatHeaderMenu();
    return toggleFlirtMode();
}

function chatMenuShowFlirtTab() {
    closeChatHeaderMenu();
    if (state.activeChatPeerId) return setFlirtTabHidden(state.activeChatPeerId, false);
}

// Lasche lange druecken = in diesem Chat ausblenden; Senden lange druecken = diese Nachricht als Flirt.
const FLIRT_LONG_PRESS_MS = 450;

// suppressClick: der Klick nach dem langen Druecken loest die normale Aktion nicht mehr aus.
function attachLongPress(element, onLongPress, { suppressClick = false } = {}) {
    if (!element) return;
    let timer = null;
    let fired = false;
    const cancel = () => {
        clearTimeout(timer);
        timer = null;
        element.classList.remove('is-pressing');
    };
    element.addEventListener('pointerdown', event => {
        if (event.button > 0) return;
        fired = false;
        cancel();
        timer = setTimeout(() => {
            timer = null;
            fired = true;
            element.classList.remove('is-pressing');
            onLongPress();
        }, FLIRT_LONG_PRESS_MS);
        element.classList.add('is-pressing');
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(type => element.addEventListener(type, cancel));
    element.addEventListener('contextmenu', event => event.preventDefault());
    // Der Klick nach dem langen Druecken soll nicht noch einmal umschalten.
    element.addEventListener('click', event => {
        if (!fired) return;
        fired = false;
        if (suppressClick || element.id === 'chat-flirt-tab') {
            event.stopImmediatePropagation();
            event.preventDefault();
        }
    }, true);
}

// Lasche antippen nimmt dem Eingabefeld nicht den Fokus: hatte es ihn, bekommt es ihn nach dem
// Umschalten zurueck (Tastatur bleibt offen); hatte es ihn nicht, bleibt das so.
let flirtTabKeepsInputFocus = false;

function restoreInputFocusAfterFlirtTab() {
    if (!flirtTabKeepsInputFocus) return;
    flirtTabKeepsInputFocus = false;
    document.getElementById('chat-input')?.focus({ preventScroll: true });
}

function initFlirtControls() {
    // Medien-Menue schliesst bei einem Tipp daneben.
    document.addEventListener('pointerdown', event => {
        if (!event.target.closest?.('.compose-media')) closeComposeMediaMenu();
    });
    const tab = document.getElementById('chat-flirt-tab');
    tab?.addEventListener('pointerdown', () => {
        flirtTabKeepsInputFocus = document.activeElement?.id === 'chat-input';
    });
    // Maus: der Knopf nimmt den Fokus gar nicht erst (Klick kommt trotzdem an).
    tab?.addEventListener('mousedown', event => event.preventDefault());
    // Wer zu schreiben anfaengt, braucht die Lasche evtl.: Fokus im Eingabefeld klappt sie aus.
    document.getElementById('chat-input')?.addEventListener('focus', () => {
        if (!document.getElementById('chat-input-bar')?.classList.contains('flirt-tab-collapsed')) return;
        state.flirtTabPinnedOpen = true;
        updateFlirtTabCollapse();
    });
    // Eingefahren: der erste Tipp klappt nur aus.
    tab?.addEventListener('click', event => {
        if (!document.getElementById('chat-input-bar')?.classList.contains('flirt-tab-collapsed')) return;
        event.stopImmediatePropagation();
        event.preventDefault();
        state.flirtTabPinnedOpen = true;
        updateFlirtTabCollapse();
        restoreInputFocusAfterFlirtTab();
    }, true);
    attachLongPress(tab, () => {
        const peerId = state.activeChatPeerId;
        if (!peerId) return;
        hapticTick();
        restoreInputFocusAfterFlirtTab();
        setFlirtTabHidden(peerId, true).catch(logBackgroundError('initFlirtControls'));
        showToast(t('friends.flirtTabHiddenHere'), 'info');
    });
    // Senden lange druecken: der Klick beim Loslassen sendet dann als Flirt.
    attachLongPress(document.getElementById('send-chat-btn'), () => {
        const peerId = state.activeChatPeerId;
        if (!canFlirt(peerId) || isFlirting(peerId)) return;
        hapticTick();
        state.flirtSendOnce = peerId;
        document.getElementById('chat-send-group')?.classList.add('is-flirt-once');
        document.getElementById('chat-input-bar')?.classList.add('is-flirt-once');
        setTimeout(() => {
            if (state.flirtSendOnce === peerId) state.flirtSendOnce = null;
            document.getElementById('chat-send-group')?.classList.remove('is-flirt-once');
            document.getElementById('chat-input-bar')?.classList.remove('is-flirt-once');
        }, 3000);
    });
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
