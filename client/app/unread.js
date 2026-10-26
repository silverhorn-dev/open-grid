// ================= UNGELESENE NACHRICHTEN (Badges) =================
// Pro Chat zaehlen die Nachrichten des Partners, die nach dem letzten Lesen kamen (nicht geloescht,
// nicht zurueckgehalten). "Gelesen" heisst: der Chat war sichtbar offen. Der Lesestand bleibt lokal
// (IndexedDB `keys` / `chat-reads`) und geht weder an den Server noch an den Partner.
// Anzeige: Zahl an jedem Chat in der Liste und in der Kontaktleiste, Summe am Chat-Tab, im Tab-Titel
// und am App-Symbol (Badging API, falls vorhanden); Punkt am Listen-Wechsel, wenn die andere Liste
// Ungelesenes hat.
const CHAT_READS_RECORD_ID = 'chat-reads';
const UNREAD_BADGE_MAX = 99;
const BASE_DOCUMENT_TITLE = document.title;

async function loadChatReads() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(CHAT_READS_RECORD_ID)).catch(() => null);
    if (stored?.reads && typeof stored.reads === 'object') {
        state.chatReads = Object.fromEntries(Object.entries(stored.reads).filter(([, at]) => Number.isFinite(at)));
        return;
    }
    // Erster Start mit Badges: bisherige Chats gelten als gelesen (sonst waere alles "neu").
    state.chatReads = { '*': Date.now() };
    await persistChatReads();
}

async function persistChatReads() {
    await putDatabaseRecord('keys', { id: CHAT_READS_RECORD_ID, reads: state.chatReads })
        .catch(error => logDebug(`Could not store chat reads: ${error.message}`));
}

function chatReadAt(peerId) {
    return state.chatReads[peerId] ?? state.chatReads['*'] ?? 0;
}

function isUnreadMessage(peerId, message) {
    return Boolean(message)
        && message.senderId === peerId
        && !message.deleted
        && !message.held
        && (Number(message.createdAt) || 0) > chatReadAt(peerId);
}

function countUnread(peerId, messages) {
    if (isPeerBlocked(peerId)) return 0;
    return messages.filter(message => isUnreadMessage(peerId, message)).length;
}

// Beim Start aus allen gespeicherten Nachrichten.
function recountAllUnread(messages) {
    const byPeer = {};
    messages.forEach(message => {
        if (!message.peerId) return;
        (byPeer[message.peerId] = byPeer[message.peerId] || []).push(message);
    });
    state.unreadCounts = Object.fromEntries(Object.entries(byPeer)
        .map(([peerId, list]) => [peerId, countUnread(peerId, list)])
        .filter(([, count]) => count > 0));
    renderUnreadBadges();
}

// Nach jeder Aenderung an einem Chat (neue, geaenderte, geloeschte Nachricht).
async function refreshUnread(peerId) {
    if (!peerId) return;
    if (isChatVisibleFor(peerId)) {
        await markChatRead(peerId);
        return;
    }
    const messages = await getDatabaseRecordsByIndex('messages', 'peerId', peerId).catch(() => state.chats[peerId] || []);
    setUnreadCount(peerId, countUnread(peerId, messages));
}

function setUnreadCount(peerId, count) {
    if ((state.unreadCounts[peerId] || 0) === count) return;
    const next = { ...state.unreadCounts };
    if (count > 0) next[peerId] = count;
    else delete next[peerId];
    state.unreadCounts = next;
    renderActivePeerList();
}

// Chat ist sichtbar offen: alles bis jetzt gilt als gelesen. Auch Nachrichten mit vorgehender Uhr
// des Absenders zaehlen nicht spaeter erneut.
async function markChatRead(peerId) {
    if (!peerId) return;
    const latest = Math.max(0, ...(state.chats[peerId] || []).map(message => Number(message.createdAt) || 0));
    const readAt = Math.max(Date.now(), latest);
    const hadUnread = Boolean(state.unreadCounts[peerId]);
    if (!hadUnread && chatReadAt(peerId) >= latest && state.chatReads[peerId]) return;
    state.chatReads = { ...state.chatReads, [peerId]: readAt };
    await persistChatReads();
    if (hadUnread) setUnreadCount(peerId, 0);
    else renderUnreadBadges();
}

function unreadCountOf(peerId) {
    return isPeerBlocked(peerId) ? 0 : state.unreadCounts[peerId] || 0;
}

function totalUnread(filter = () => true) {
    return Object.keys(state.unreadCounts).filter(filter).reduce((sum, peerId) => sum + unreadCountOf(peerId), 0);
}

function formatUnreadCount(count) {
    return count > UNREAD_BADGE_MAX ? `${UNREAD_BADGE_MAX}+` : String(count);
}

// Kleine Zahl als Pille (Chatliste, Kontaktleiste).
function createUnreadBadge(count, extraClass = '') {
    const badge = document.createElement('span');
    badge.className = `unread-badge ${extraClass}`.trim();
    badge.textContent = formatUnreadCount(count);
    badge.setAttribute('aria-label', t('{count} ungelesen', { count }));
    return badge;
}

// Summe am Chat-Tab, Tab-Titel, App-Symbol und Punkt am Listen-Wechsel.
function renderUnreadBadges() {
    const total = totalUnread();
    document.querySelectorAll('[data-unread-total]').forEach(badge => {
        badge.textContent = formatUnreadCount(total);
        badge.classList.toggle('hidden', total === 0);
    });
    document.title = total ? `(${formatUnreadCount(total)}) ${BASE_DOCUMENT_TITLE}` : BASE_DOCUMENT_TITLE;
    if ('setAppBadge' in navigator) {
        (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {});
    }
    // Chats ohne Liste stehen in beiden Listen und zaehlen deshalb nicht als "andere Liste".
    const otherScope = otherChatScope();
    const otherUnread = totalUnread(peerId => chatScopeOf(peerId) === otherScope);
    document.getElementById('chat-list-switch-dot')?.classList.toggle('hidden', otherUnread === 0);
}
