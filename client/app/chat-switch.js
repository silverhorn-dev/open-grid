// ================= SCHNELL ZWISCHEN CHATS WECHSELN =================
// Im offenen Chat zum naechsten oder vorherigen Chat derselben Liste (Grid & Event bzw.
// Chat & Freunde), Reihenfolge wie die Chatliste. Einstellbar (keys/chat-switch-settings):
//   - aus (kein versehentliches Wechseln)
//   - 'bar':    Avatar-Leiste unter der Kontaktleiste, antippen
//   - 'arrows': Vor/Zurueck-Knoepfe in der Kontaktleiste
//   - 'swipe':  auf der Kontaktleiste seitlich wischen (nicht auf Nachrichten: dort heisst wischen
//               "antworten"; das Tab-Wischen ist im offenen Chat ohnehin aus)
// Ein Wechsel ersetzt den History-Eintrag: "Zurueck" fuehrt weiter zur Chatliste.
const CHAT_SWITCH_STYLES = ['bar', 'arrows', 'swipe'];
const CHAT_SWITCH_RECORD_ID = 'chat-switch-settings';
const CHAT_SWITCH_SWIPE_TRIGGER = 70;

async function loadChatSwitchSettings() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(CHAT_SWITCH_RECORD_ID)).catch(() => null);
    const defaultStyle = clientDefault('chatSwitchStyle', 'bar');
    state.chatSwitchSettings = {
        enabled: stored ? stored.enabled !== false : clientDefault('chatSwitchEnabled', true) !== false,
        style: CHAT_SWITCH_STYLES.includes(stored?.style) ? stored.style : CHAT_SWITCH_STYLES.includes(defaultStyle) ? defaultStyle : 'bar'
    };
    renderChatSwitchSettings();
    renderChatSwitcher();
}

async function updateChatSwitchSetting(key, value) {
    if (key === 'style' && !CHAT_SWITCH_STYLES.includes(value)) return;
    state.chatSwitchSettings = { ...state.chatSwitchSettings, [key]: key === 'enabled' ? value === true : value };
    await putDatabaseRecord('keys', { id: CHAT_SWITCH_RECORD_ID, ...state.chatSwitchSettings })
        .catch(error => logDebug(`Could not store chat switch settings: ${error.message}`));
    renderChatSwitchSettings();
    renderChatSwitcher();
}

function renderChatSwitchSettings() {
    const toggle = document.getElementById('chat-switch-toggle');
    if (toggle) toggle.checked = state.chatSwitchSettings.enabled;
    const style = document.getElementById('chat-switch-style');
    if (style) {
        style.value = state.chatSwitchSettings.style;
        style.disabled = !state.chatSwitchSettings.enabled;
    }
}

function chatSwitchActive() {
    return state.chatSwitchSettings.enabled && Boolean(state.activeChatPeerId);
}

// Nachbar in der Liste (direction -1 = vorheriger, 1 = naechster); null am Rand.
function neighbourChat(direction) {
    const peerIds = visibleChatPeerIds();
    const index = peerIds.indexOf(state.activeChatPeerId);
    if (index < 0) return null;
    return peerIds[index + direction] || null;
}

async function switchToChat(peerId) {
    if (!peerId || peerId === state.activeChatPeerId) return;
    state.applyingRoute = true;
    try {
        await openChatWithPeer(peerId);
    } finally {
        state.applyingRoute = false;
    }
    replaceRoute(routeForTab('chat'));
}

function switchChat(direction) {
    if (!chatSwitchActive()) return;
    const target = neighbourChat(direction);
    if (target) switchToChat(target).catch(logBackgroundError('switchChat'));
}

function renderChatSwitcher() {
    const bar = document.getElementById('chat-switch-bar');
    const arrows = document.querySelectorAll('.chat-switch-arrow');
    if (!bar) return;
    const active = chatSwitchActive();
    const style = state.chatSwitchSettings.style;
    const peerIds = active ? visibleChatPeerIds() : [];
    const showBar = active && style === 'bar' && peerIds.length > 1;
    bar.classList.toggle('hidden', !showBar);
    arrows.forEach(button => {
        const direction = Number(button.dataset.direction);
        const show = active && style === 'arrows' && peerIds.length > 1;
        button.classList.toggle('hidden', !show);
        button.classList.toggle('flex', show);
        button.disabled = !neighbourChat(direction);
    });
    document.getElementById('chat-header')?.classList.toggle('chat-header-swipe', active && style === 'swipe');
    if (!showBar) {
        bar.replaceChildren();
        return;
    }
    bar.replaceChildren(...peerIds.map(peerId => {
        const peer = getPeerPresentation(peerId);
        const button = document.createElement('button');
        button.type = 'button';
        const current = peerId === state.activeChatPeerId;
        button.className = `relative shrink-0 w-10 h-10 rounded-full p-0.5 ${current ? 'bg-brand-500' : 'bg-transparent hover:bg-slate-700'}`;
        button.title = peer.name || HIDDEN_PEER_NAME;
        button.setAttribute('aria-label', t('chat.with', { value: peer.name || HIDDEN_PEER_NAME }));
        if (current) button.setAttribute('aria-current', 'true');
        const image = document.createElement('img');
        image.src = localAvatar(peer.avatar);
        image.alt = '';
        image.className = 'w-full h-full rounded-full object-cover border-2 border-slate-900';
        button.appendChild(image);
        if (!isPeerBlocked(peerId) && isPeerOnline(peerId)) {
            const dot = document.createElement('span');
            dot.className = 'absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-slate-900';
            button.appendChild(dot);
        }
        const unread = unreadCountOf(peerId);
        if (unread && !current) button.appendChild(createUnreadBadge(unread, 'unread-badge-corner'));
        button.onclick = () => switchToChat(peerId).catch(logBackgroundError('renderChatSwitcher'));
        return button;
    }));
    centerInScroller(bar, bar.querySelector('[aria-current="true"]'), 'x');
}

// Scrollt nur den Container selbst. `scrollIntoView` wuerde auch alle Vorfahren samt Seite bzw.
// Visual Viewport verschieben: auf dem Smartphone rutschte so der feste Chat (mit Eingabefeld)
// nach dem Neuladen teilweise aus dem Bild.
function centerInScroller(container, element, axis) {
    if (!container || !element) return;
    const box = container.getBoundingClientRect();
    const target = element.getBoundingClientRect();
    if (axis === 'x') {
        container.scrollLeft += (target.left + target.width / 2) - (box.left + box.width / 2);
    } else {
        container.scrollTop += (target.top + target.height / 2) - (box.top + box.height / 2);
    }
}

// Wischen nur auf der Kontaktleiste.
// Gesten auf der Kontaktleiste (Chat-Kopf): seitlich wischen = Chat wechseln (Stil "swipe"),
// nach unten ziehen = Profil des Kontakts oeffnen. Der Kopf zieht beim Ziehen leicht mit.
const HEADER_PULL_TRIGGER = 60;
const HEADER_PULL_MAX = 28;

function initChatSwitchSwipe() {
    const header = document.getElementById('chat-header');
    if (!header) return;
    let start = null;
    const reset = () => {
        header.style.transition = prefersReducedMotion() ? 'none' : 'transform 160ms ease-out';
        header.style.transform = '';
        start = null;
    };
    header.addEventListener('pointerdown', event => {
        if (!state.activeChatPeerId || event.target.closest('button, input')) return;
        start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    });
    header.addEventListener('pointermove', event => {
        if (!start || start.pointerId !== event.pointerId) return;
        const deltaY = event.clientY - start.y;
        if (deltaY <= 0 || deltaY < Math.abs(event.clientX - start.x)) return;
        header.style.transition = 'none';
        header.style.transform = `translate3d(0, ${Math.min(HEADER_PULL_MAX, deltaY * 0.4)}px, 0)`;
    });
    header.addEventListener('pointerup', event => {
        if (!start || start.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - start.x;
        const deltaY = event.clientY - start.y;
        reset();
        if (deltaY >= HEADER_PULL_TRIGGER && deltaY > Math.abs(deltaX) * 1.5) {
            hapticTick();
            openProfileModal(state.activeChatPeerId);
            return;
        }
        if (!chatSwitchActive() || state.chatSwitchSettings.style !== 'swipe') return;
        if (Math.abs(deltaX) < CHAT_SWITCH_SWIPE_TRIGGER || Math.abs(deltaX) < Math.abs(deltaY) * 1.5) return;
        hapticTick();
        // Nach links wischen = naechster Chat (wie Blaettern).
        switchChat(deltaX < 0 ? 1 : -1);
    });
    header.addEventListener('pointercancel', reset);
}

// Liste von Chats zum Antippen (Quick-Switcher, "Senden an" beim Teilen nach OpenGrid).
function createChatPickerList(peerIds, onPick, currentPeerId = null) {
    const list = document.createElement('div');
    list.className = 'space-y-1.5';
    peerIds.forEach(peerId => {
        const peer = getPeerPresentation(peerId);
        const current = peerId === currentPeerId;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.peerId = peerId;
        button.className = `w-full flex items-center gap-3 rounded-xl border p-2 text-left ${current ? 'border-brand-500/60 bg-brand-500/10' : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'}`;
        if (current) button.setAttribute('aria-current', 'true');
        const avatar = document.createElement('div');
        avatar.className = 'relative shrink-0';
        const image = document.createElement('img');
        image.src = localAvatar(peer.avatar);
        image.alt = '';
        image.className = 'w-10 h-10 rounded-full object-cover border border-slate-700';
        avatar.appendChild(image);
        if (!isPeerBlocked(peerId) && isPeerOnline(peerId)) {
            const dot = document.createElement('span');
            dot.className = 'absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-400 border-2 border-slate-900';
            avatar.appendChild(dot);
        }
        const details = document.createElement('div');
        details.className = 'min-w-0 flex-1';
        const name = document.createElement('div');
        name.className = 'text-sm font-semibold text-slate-200 truncate';
        name.textContent = peer.name || HIDDEN_PEER_NAME;
        const preview = document.createElement('div');
        preview.className = 'text-xs text-slate-400 truncate';
        const last = state.chatPreviews[peerId];
        preview.textContent = last ? `${last.mine ? t('common.you') : ''}${last.text}` : '';
        details.append(name, preview);
        button.append(avatar, details);
        const unread = unreadCountOf(peerId);
        if (unread) button.appendChild(createUnreadBadge(unread, 'shrink-0'));
        button.onclick = () => onPick(peerId);
        list.appendChild(button);
    });
    return list;
}

// Quick-Switcher: alle Chats der aktuellen Liste zur Auswahl (z. B. per Hochziehen im Chat).
function openChatSwitcherSheet() {
    const peerIds = visibleChatPeerIds();
    const content = openMediaModal(t('chat.switchChat'));
    if (peerIds.length < 2) {
        renderMediaModalMessage(t('chat.noOtherChatsInThis'), 'fa-comments');
        return;
    }
    const list = createChatPickerList(peerIds, peerId => replaceModal(closeMediaModal, () => switchToChat(peerId)), state.activeChatPeerId);
    content.appendChild(list);
    centerInScroller(content, list.querySelector('[aria-current="true"]'), 'y');
}

// ----- Listen-Wechsel: "Grid & Event" <-> "Chat & Freunde" -----
// Knopf neben dem Titel der Chatliste (abschaltbar, keys/list-switch-settings):
//   'mode': wechselt den App-Modus zur passenden Seite (zuletzt genutzter Modus dort)
//   'view': zeigt nur die andere Liste; daneben "Modus wechseln". Tab-Wechsel und Neu laden fuehren
//           zur Liste des Modus zurueck.
const LIST_SWITCH_RECORD_ID = 'list-switch-settings';
const LIST_SWITCH_BEHAVIORS = ['mode', 'view'];
const SOCIAL_MODES = ['chat', 'friends'];
const DISCOVERY_MODES = ['discovery', 'event'];

async function loadListSwitchSettings() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(LIST_SWITCH_RECORD_ID)).catch(() => null);
    state.listSwitchSettings = {
        enabled: stored ? stored.enabled !== false : clientDefault('listSwitchEnabled', true) !== false,
        behavior: LIST_SWITCH_BEHAVIORS.includes(stored?.behavior) ? stored.behavior
            : LIST_SWITCH_BEHAVIORS.includes(clientDefault('listSwitchBehavior')) ? clientDefault('listSwitchBehavior') : 'mode'
    };
    renderListSwitchSettings();
    renderListSwitch();
}

async function updateListSwitchSetting(key, value) {
    if (key === 'behavior' && !LIST_SWITCH_BEHAVIORS.includes(value)) return;
    state.listSwitchSettings = { ...state.listSwitchSettings, [key]: key === 'enabled' ? value === true : value };
    await putDatabaseRecord('keys', { id: LIST_SWITCH_RECORD_ID, ...state.listSwitchSettings })
        .catch(error => logDebug(`Could not store list switch settings: ${error.message}`));
    if (!state.listSwitchSettings.enabled || state.listSwitchSettings.behavior === 'mode') state.chatListScopeOverride = null;
    renderListSwitchSettings();
    renderActivePeerList();
}

function renderListSwitchSettings() {
    const toggle = document.getElementById('list-switch-toggle');
    if (toggle) toggle.checked = state.listSwitchSettings.enabled;
    const behavior = document.getElementById('list-switch-behavior');
    if (behavior) {
        behavior.value = state.listSwitchSettings.behavior;
        behavior.disabled = !state.listSwitchSettings.enabled;
    }
}

// App-Modus fuer eine Liste: zuletzt dort genutzt, sonst der erste erlaubte (Event nur, wenn aktiv).
function modeForChatScope(scope) {
    const allowed = scope === 'social' ? SOCIAL_MODES : DISCOVERY_MODES;
    const usable = mode => state.appConfig.modes.includes(mode) && (mode !== 'event' || hasActiveEvent());
    const last = scope === 'social' ? state.appModeSettings.lastSocialMode : state.appModeSettings.lastDiscoveryMode;
    if (allowed.includes(last) && usable(last)) return last;
    return allowed.find(usable) || null;
}

function otherChatScope() {
    return currentChatScope() === 'social' ? 'discovery' : 'social';
}

function renderListSwitch() {
    const button = document.getElementById('chat-list-switch');
    const modeButton = document.getElementById('chat-list-mode-btn');
    if (!button) return;
    const settings = state.listSwitchSettings;
    const target = otherChatScope();
    // Im Modus-Wechsel braucht die andere Seite einen erlaubten Modus.
    // Nur bei "Entdecken & Freunde" gibt es eine zweite Liste.
    const bothAreas = typeof effectiveModeScope !== 'function' || effectiveModeScope() === 'all';
    const possible = bothAreas && settings.enabled && (settings.behavior === 'view' || Boolean(modeForChatScope(target)));
    button.classList.toggle('hidden', !possible);
    button.title = target === 'social' ? t('chat.toChatFriends') : t('chat.toGridEvent');
    button.setAttribute('aria-label', button.title);
    const viewingOther = Boolean(state.chatListScopeOverride) && state.chatListScopeOverride !== modeChatScope();
    modeButton?.classList.toggle('hidden', !viewingOther || !modeForChatScope(state.chatListScopeOverride));
}

async function switchChatList() {
    const target = otherChatScope();
    hapticTick();
    if (state.listSwitchSettings.behavior === 'mode') {
        const mode = modeForChatScope(target);
        if (mode) await setAppMode(mode);
        return;
    }
    state.chatListScopeOverride = target === modeChatScope() ? null : target;
    renderActivePeerList();
}

// "Modus wechseln" neben der nur angesehenen Liste.
async function switchModeToViewedList() {
    const mode = modeForChatScope(state.chatListScopeOverride);
    if (mode) await setAppMode(mode);
}

