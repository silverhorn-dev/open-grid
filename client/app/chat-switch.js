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
    state.chatSwitchSettings = {
        enabled: stored?.enabled !== false,
        style: CHAT_SWITCH_STYLES.includes(stored?.style) ? stored.style : 'bar'
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
        button.setAttribute('aria-label', `Chat mit ${peer.name || HIDDEN_PEER_NAME}`);
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
        button.onclick = () => switchToChat(peerId).catch(logBackgroundError('renderChatSwitcher'));
        return button;
    }));
    bar.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// Wischen nur auf der Kontaktleiste.
function initChatSwitchSwipe() {
    const header = document.getElementById('chat-header');
    if (!header) return;
    let start = null;
    header.addEventListener('pointerdown', event => {
        if (!chatSwitchActive() || state.chatSwitchSettings.style !== 'swipe' || event.target.closest('button, input')) return;
        start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    });
    header.addEventListener('pointerup', event => {
        if (!start || start.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - start.x;
        const deltaY = event.clientY - start.y;
        start = null;
        if (Math.abs(deltaX) < CHAT_SWITCH_SWIPE_TRIGGER || Math.abs(deltaX) < Math.abs(deltaY) * 1.5) return;
        hapticTick();
        // Nach links wischen = naechster Chat (wie Blaettern).
        switchChat(deltaX < 0 ? 1 : -1);
    });
    header.addEventListener('pointercancel', () => {
        start = null;
    });
}

// Quick-Switcher: alle Chats der aktuellen Liste zur Auswahl (z. B. per Hochziehen im Chat).
function openChatSwitcherSheet() {
    const peerIds = visibleChatPeerIds();
    const content = openMediaModal('Chat wechseln');
    if (peerIds.length < 2) {
        renderMediaModalMessage('Keine weiteren Chats in dieser Liste.');
        return;
    }
    const list = document.createElement('div');
    list.className = 'space-y-1.5';
    peerIds.forEach(peerId => {
        const peer = getPeerPresentation(peerId);
        const current = peerId === state.activeChatPeerId;
        const button = document.createElement('button');
        button.type = 'button';
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
        preview.textContent = last ? `${last.mine ? 'Du: ' : ''}${last.text}` : '';
        details.append(name, preview);
        button.append(avatar, details);
        button.onclick = () => replaceModal(closeMediaModal, () => switchToChat(peerId));
        list.appendChild(button);
    });
    content.appendChild(list);
    list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
}

