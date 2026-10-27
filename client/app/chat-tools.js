// Chat-Werkzeuge: Antworten, Reaktionen, Markieren, Suchen, Aktionsleiste, Kontaktleiste
// und Chat-Fokus. Ausgelagert aus chat.js (klassisches Skript, globale Funktionen).
// ================= CHAT-FUNKTIONEN: ANTWORTEN, REAGIEREN, MARKIEREN, SUCHEN =================
function messagePreview(message) {
    if (message.secureSnap) return t('common.secureSnap');
    if (message.album) return t('chat.album', { name: message.album.name });
    if (message.audioData) return t('chat.voiceMessage', { duration: formatVoiceDuration(message.audioDuration) });
    if (message.video) return message.text ? t('chat.video2', { text: message.text }) : t('chat.video');
    // Ohne snapMode ist es ein normales Bild ("Als Bild senden") oder ein gespeicherter alter Snap.
    if (message.snapData && !message.snapMode) return message.text ? t('chat.image', { text: message.text }) : t('common.image');
    if (message.snapData || message.snapMode) return message.text ? t('chat.snap', { text: message.text }) : t('common.snap');
    const text = String(message.text || '');
    return text.length > REPLY_PREVIEW_LENGTH ? `${text.slice(0, REPLY_PREVIEW_LENGTH)}...` : text;
}

function buildReplyReference(peerId, messageId) {
    const original = messageId ? state.chats[peerId]?.find(item => item.id === messageId) : null;
    if (!original || original.deleted) return undefined;
    return { messageId: original.id, senderId: original.senderId, preview: messagePreview(original) };
}

function startReply(messageId) {
    state.replyToMessageId = messageId;
    renderReplyBar();
    document.getElementById('chat-input')?.focus();
}

function cancelReply() {
    state.replyToMessageId = null;
    renderReplyBar();
}

function renderReplyBar() {
    const bar = document.getElementById('chat-reply-bar');
    if (!bar) return;
    const reference = buildReplyReference(state.activeChatPeerId, state.replyToMessageId);
    bar.classList.toggle('hidden', !reference);
    if (!reference) return;
    const author = reference.senderId === state.myProfile.id ? t('chat.yourself') : getPeerPresentation(reference.senderId).name || HIDDEN_PEER_NAME;
    document.getElementById('chat-reply-author').textContent = t('chat.replyTo', { author });
    document.getElementById('chat-reply-preview').textContent = reference.preview;
}

function renderReplyQuote(replyTo, isMine) {
    const quote = document.createElement('button');
    quote.type = 'button';
    quote.className = `max-w-[80%] mb-0.5 px-3 py-1 rounded-xl border-l-2 border-brand-400 bg-slate-800/60 text-[11px] text-slate-400 text-left truncate ${isMine ? 'self-end' : 'self-start'}`;
    const author = replyTo.senderId === state.myProfile.id ? t('chat.you') : getPeerPresentation(replyTo.senderId).name || HIDDEN_PEER_NAME;
    quote.textContent = `${author}: ${replyTo.preview}`;
    quote.onclick = () => scrollToChatMessage(replyTo.messageId);
    return quote;
}

function scrollToChatMessage(messageId) {
    const target = document.getElementById(`chat-message-${messageId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('chat-message-highlight');
    setTimeout(() => target.classList.remove('chat-message-highlight'), 1500);
}

// Auf Touch-Geraeten blendet ein Tipp auf die Nachricht die Aktionen ein, am Desktop das Hovern.
function toggleMessageActions(row) {
    const wasOpen = row.classList.contains('actions-open');
    closeMessageActions();
    if (!wasOpen) row.classList.add('actions-open');
}

function closeMessageActions() {
    document.querySelectorAll('#chat-messages .actions-open').forEach(element => element.classList.remove('actions-open'));
}

// Tipp ausserhalb schliesst offene Aktionsleisten.
document.addEventListener('click', event => {
    if (!event.target.closest?.('.actions-open')) closeMessageActions();
});

// Mit Original (wenn vorhanden) statt Vorschau.
async function openChatImageViewer(messageId) {
    const snaps = (state.chats[state.activeChatPeerId] || [])
        .filter(message => !message.deleted && isInlineSnap(message));
    const images = await Promise.all(snaps.map(bestImageFor));
    openImageViewer(images, snaps.findIndex(message => message.id === messageId), { allowSave: snaps.map(canDownloadMedia) });
}

// Eigene Nachrichten rechtsbuendig, fremde linksbuendig: die Leiste waechst zur Bildschirmmitte.
// Auf Touch-Geraeten ist der Pfeil das aeussere Element der Leiste: er oeffnet und schliesst sie.
function renderMessageActions(message, isMine, row) {
    const actions = document.createElement('div');
    actions.className = `message-actions absolute -top-5 ${isMine ? 'right-0' : 'left-0'} z-10 flex items-center gap-0.5 rounded-full border border-slate-700 bg-slate-900/95 px-1 py-0.5 shadow-lg text-slate-300`;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'message-actions-toggle w-6 h-6 rounded-full items-center justify-center text-[10px] text-slate-200 bg-black/25';
    toggle.setAttribute('aria-label', t('chat.showOrHideActions'));
    toggle.innerHTML = '<i class="fa-solid fa-chevron-down transition-transform"></i>';
    toggle.onclick = event => {
        event.stopPropagation();
        toggleMessageActions(row);
    };
    if (!isMine) actions.appendChild(toggle);
    const addAction = (iconClass, title, onClick, extraClass = 'hover:text-slate-50 hover:bg-slate-800') => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `message-action w-9 h-9 rounded-full flex items-center justify-center text-base transition ${extraClass}`;
        button.title = title;
        button.setAttribute('aria-label', title);
        button.onclick = event => {
            event.stopPropagation();
            onClick(event);
        };
        const icon = document.createElement('i');
        icon.className = iconClass;
        button.appendChild(icon);
        actions.appendChild(button);
    };
    addAction('fa-solid fa-reply', t('chat.reply'), () => startReply(message.id));
    if (message.text) addAction('fa-regular fa-copy', t('common.copy'), () => copyMessageText(message));
    addAction('fa-regular fa-face-smile', t('chat.react'), event => toggleReactionPicker(event.currentTarget, message.id));
    addAction(message.starred ? 'fa-solid fa-star text-amber-400' : 'fa-regular fa-star', message.starred ? t('chat.removeStar') : t('chat.starForYourself'), () => toggleMessageStar(message.id));
    if (isMine) addAction('fa-solid fa-trash', t('common.delete'), () => deleteChatMessage(message.id), 'text-red-400 hover:text-red-300 hover:bg-slate-800');
    if (isMine) actions.appendChild(toggle);
    return actions;
}

async function copyMessageText(message) {
    try {
        await navigator.clipboard.writeText(message.text || '');
        showToast(t('chat.textCopied'), 'success');
    } catch {
        showToast(t('common.copyingIsNotPossible'), 'error');
    }
    closeMessageActions();
}

function toggleReactionPicker(anchor, messageId) {
    const existing = document.getElementById('reaction-picker');
    if (existing) {
        const sameMessage = existing.dataset.messageId === messageId;
        existing.remove();
        if (sameMessage) return;
    }
    const picker = document.createElement('div');
    picker.id = 'reaction-picker';
    picker.dataset.messageId = messageId;
    picker.className = 'flex gap-1 bg-slate-900 border border-slate-700 rounded-full px-2 py-1 shadow-lg';
    REACTION_EMOJIS.forEach(emoji => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'text-base leading-none hover:scale-125 transition';
        button.textContent = emoji;
        button.onclick = () => {
            picker.remove();
            reactToMessage(messageId, emoji);
        };
        picker.appendChild(button);
    });
    anchor.closest('[id^="chat-message-"]').appendChild(picker);
}

function renderReactions(message, isMine) {
    const entries = Object.entries(message.reactions || {}).filter(([, reaction]) => reaction?.emoji);
    if (!entries.length || message.deleted) return null;
    const counts = new Map();
    entries.forEach(([actorId, reaction]) => {
        const item = counts.get(reaction.emoji) || { count: 0, mine: false };
        item.count += 1;
        item.mine = item.mine || actorId === state.myProfile.id;
        counts.set(reaction.emoji, item);
    });
    const row = document.createElement('div');
    // Eigene Nachrichten: unten links, fremde: unten rechts (Richtung Bildschirmmitte).
    row.className = `message-reactions absolute -bottom-4 ${isMine ? 'left-2' : 'right-2'} z-[5] flex gap-1`;
    counts.forEach(({ count, mine }, emoji) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `text-sm leading-none px-2 py-1 rounded-full border shadow ${mine ? 'bg-brand-900 border-brand-500/60' : 'bg-slate-900 border-slate-700'}`;
        chip.textContent = count > 1 ? `${emoji} ${count}` : emoji;
        chip.onclick = () => reactToMessage(message.id, emoji);
        row.appendChild(chip);
    });
    return row;
}

// Gleiche Reaktion erneut = entfernen.
async function reactToMessage(messageId, emoji) {
    const peerId = state.activeChatPeerId;
    const message = state.chats[peerId]?.find(item => item.id === messageId);
    if (!peerId || !message || message.deleted || isPeerBlocked(peerId)) return;
    const current = message.reactions?.[state.myProfile.id]?.emoji || null;
    const operation = {
        operationId: `react:${messageId}:${window.crypto.randomUUID()}`,
        peerId,
        type: 'MESSAGE_REACT',
        messageId,
        actorId: state.myProfile.id,
        emoji: current === emoji ? null : emoji,
        createdAt: Date.now()
    };
    await applyChatOperation(peerId, operation);
    const { peerId: _localPeerId, ...sharedOperation } = operation;
    await sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation: sharedOperation });
}

// Markierungen sind rein lokal und werden nicht synchronisiert.
async function toggleMessageStar(messageId) {
    const peerId = state.activeChatPeerId;
    const message = state.chats[peerId]?.find(item => item.id === messageId);
    if (!message) return;
    message.starred = !message.starred;
    await persistChatMessage(peerId, message);
    renderChatHistory();
}

function filterChatMessages(messages) {
    const query = state.chatSearch.trim().toLowerCase();
    return messages.filter(message => {
        if (state.chatStarredOnly && !message.starred) return false;
        if (!query) return true;
        return !message.deleted && String(message.text || '').toLowerCase().includes(query);
    });
}

function toggleChatSearch() {
    const bar = document.getElementById('chat-search-bar');
    if (!bar) return;
    const open = bar.classList.toggle('hidden') === false;
    if (open) {
        document.getElementById('chat-search-input').focus();
        return;
    }
    state.chatSearch = '';
    state.chatStarredOnly = false;
    document.getElementById('chat-search-input').value = '';
    document.getElementById('chat-starred-toggle').checked = false;
    renderChatHistory();
}

function setChatSearch(value) {
    state.chatSearch = value;
    renderChatHistory();
}

function setChatStarredOnly(enabled) {
    state.chatStarredOnly = enabled;
    renderChatHistory();
}

function resetChatTools() {
    state.replyToMessageId = null;
    state.chatSearch = '';
    state.chatStarredOnly = false;
    document.getElementById('chat-search-bar')?.classList.add('hidden');
    const input = document.getElementById('chat-search-input');
    if (input) input.value = '';
    const starred = document.getElementById('chat-starred-toggle');
    if (starred) starred.checked = false;
    renderReplyBar();
}

function updateChatConnectionStatus(peerId, text, classes) {
    if (state.activeChatPeerId !== peerId) return;
    const pill = document.getElementById('connection-status-pill');
    pill.textContent = text;
    pill.className = `debug-only text-xs px-2.5 py-1 rounded-full border font-mono whitespace-nowrap ${classes}`;
    renderChatPeerIndicator();
}

function isSecureChannelOpen(peerId) {
    return state.dataChannels[peerId]?.readyState === 'open' && Boolean(state.sessionKeys[peerId]);
}

// Name und Bild in der Kontaktleiste (auch nachgezogen, wenn der Profil-Handshake ankommt).
function renderChatPeerHeader(peerId) {
    const peer = getPeerPresentation(peerId);
    document.getElementById('chat-peer-name').textContent = peer.name || HIDDEN_PEER_NAME;
    const avatar = document.getElementById('chat-peer-avatar');
    avatar.innerHTML = '';
    const image = document.createElement('img');
    image.src = localAvatar(peer.avatar);
    image.alt = '';
    image.className = 'w-full h-full object-cover';
    avatar.appendChild(image);
}

// Kontaktleiste: Online-Punkt am Avatar, darunter "online", "offline" oder "hat den Chat offen".
function renderChatPeerIndicator() {
    const dot = document.getElementById('chat-peer-online-dot');
    const status = document.getElementById('chat-peer-status');
    if (!dot || !status) return;
    const peerId = state.activeChatPeerId;
    const online = Boolean(peerId) && isPeerOnline(peerId) && !isPeerBlocked(peerId);
    const watching = online && isSecureChannelOpen(peerId) && Boolean(state.peerChatFocus[peerId]);
    dot.classList.toggle('hidden', !online);
    const sameNetwork = online && state.peerTransport[peerId] === 'lan' ? t('chat.onSameWiFi') : '';
    const presence = peerId ? presenceTextOf(peerId) : '';
    const presenceSuffix = presence ? ` · ${presence}` : '';
    const state_ = !peerId ? '' : watching ? `\u{1F440} ${t('chat.hasChatOpen')}` : online ? t('chat.online') : t('chat.offline2');
    status.textContent = peerId ? `${state_}${online ? sameNetwork : ''}${presenceSuffix}` : '';
    status.classList.toggle('text-emerald-400', online);
    status.classList.toggle('text-slate-400', !online);
}

function toggleChatHeaderMenu(event) {
    event?.stopPropagation();
    const menu = document.getElementById('chat-header-menu');
    const open = menu.classList.toggle('hidden') === false;
    document.getElementById('chat-header-menu-btn').setAttribute('aria-expanded', String(open));
}

function closeChatHeaderMenu() {
    document.getElementById('chat-header-menu')?.classList.add('hidden');
    document.getElementById('chat-header-menu-btn')?.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', event => {
    // Der Menue-Knopf schaltet selbst um (actions.js), sonst wuerde er hier gleich wieder schliessen.
    if (!event.target.closest?.('#chat-header-menu, #chat-header-menu-btn')) closeChatHeaderMenu();
});

function isChatVisibleFor(peerId) {
    return Boolean(peerId)
        && state.activeChatPeerId === peerId
        && document.visibilityState === 'visible'
        && !document.getElementById('view-chat')?.classList.contains('hidden');
}

// Teilt dem Gegenueber ueber den DataChannel mit, ob der Chat gerade sichtbar ist. Wird nie gequeued.
function sendChatFocus(peerId, open) {
    if (!peerId || !isSecureChannelOpen(peerId) || isPeerBlocked(peerId)) return;
    sendSecurePayload(peerId, { type: 'CHAT_FOCUS', open }).catch(logBackgroundError('sendChatFocus'));
}

function syncChatFocus() {
    const focusedPeerId = isChatVisibleFor(state.activeChatPeerId) ? state.activeChatPeerId : null;
    if (focusedPeerId) markChatRead(focusedPeerId).catch(logBackgroundError('syncChatFocus'));
    const previousPeerId = state.chatFocusPeerId;
    if (previousPeerId === focusedPeerId) return;
    if (previousPeerId) sendChatFocus(previousPeerId, false);
    if (focusedPeerId) sendChatFocus(focusedPeerId, true);
    state.chatFocusPeerId = focusedPeerId;
}

function receiveChatFocus(peerId, open) {
    state.peerChatFocus[peerId] = Boolean(open);
    if (state.activeChatPeerId === peerId) renderChatPeerIndicator();
}

// ----- Album-Knopf im Chat -----
// In "Chat & Freunde"-Chats hat man normalerweise keine Alben: der Knopf ist dort versteckt.
// Easteregg: lange auf "Snap" druecken zeigt ihn fuer diesen Chat (ohne die Kamera zu oeffnen).
const SNAP_LONG_PRESS_MS = 600;

function isSocialChat(peerId) {
    return (chatScopeOf(peerId) || currentChatScope()) === 'social';
}

function updateChatAlbumButton() {
    const button = document.getElementById('chat-album-btn');
    const peerId = state.activeChatPeerId;
    if (!button) return;
    const hidden = Boolean(peerId) && isSocialChat(peerId) && state.albumButtonRevealedFor !== peerId;
    button.classList.toggle('hidden', hidden);
}

function initSnapLongPress() {
    const snap = document.getElementById('chat-snap-btn');
    if (!snap) return;
    let timer = null;
    let fired = false;
    const cancel = () => {
        clearTimeout(timer);
        timer = null;
    };
    snap.addEventListener('pointerdown', () => {
        fired = false;
        cancel();
        timer = setTimeout(() => {
            const peerId = state.activeChatPeerId;
            if (!peerId || !isSocialChat(peerId) || state.albumButtonRevealedFor === peerId) return;
            fired = true;
            state.albumButtonRevealedFor = peerId;
            hapticTick(20);
            updateChatAlbumButton();
            document.getElementById('chat-album-btn')?.classList.add('album-reveal');
        }, SNAP_LONG_PRESS_MS);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(type => snap.addEventListener(type, cancel));
    // Nach dem langen Druck kein Klick: die Kamera soll nicht aufgehen.
    snap.addEventListener('click', event => {
        if (!fired) return;
        fired = false;
        event.stopPropagation();
        event.preventDefault();
    }, true);
    // Kein Kontextmenue beim langen Druck auf dem Smartphone.
    snap.addEventListener('contextmenu', event => event.preventDefault());
}

