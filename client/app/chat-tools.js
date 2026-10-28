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

// ----- Kontextmenue einer Nachricht -----
// Ein Menue fuer alles (Reaktionen oben, Aktionen darunter): langes Druecken oder der Pfeil (Touch),
// Rechtsklick oder "mehr" in der Hover-Leiste (Desktop). Es haengt am <body>, nicht in der
// Nachrichtenliste, und merkt sich die Nachricht (state.messageMenu): ein Neuzeichnen des Chats
// (neue Nachricht, Zustellbestaetigung, Reaktion) schliesst es nicht mehr. Schliessen: Tipp daneben,
// Esc, Zurueck-Geste, nach einer Aktion, beim Chatwechsel.
function messageMenuTarget() {
    const menu = state.messageMenu;
    if (!menu || menu.peerId !== state.activeChatPeerId) return null;
    const message = (state.chats[menu.peerId] || []).find(item => item.id === menu.messageId);
    return message && !message.deleted ? message : null;
}

function openMessageMenu(messageId) {
    const peerId = state.activeChatPeerId;
    const message = (state.chats[peerId] || []).find(item => item.id === messageId);
    if (!peerId || !message || message.deleted) return;
    // Schon offen fuer diese Nachricht (z. B. langes Druecken + Kontextmenue-Ereignis): nichts tun.
    if (state.messageMenu?.messageId === messageId && document.getElementById('message-menu')) return;
    if (state.messageMenu) hideMessageMenu();
    state.messageMenu = { peerId, messageId };
    renderMessageMenu();
    pushModalEntry('messagemenu', hideMessageMenu);
}

function closeMessageMenu() {
    if (!state.messageMenu) return;
    dismissModalEntry('messagemenu', hideMessageMenu);
}

function hideMessageMenu() {
    state.messageMenu = null;
    document.getElementById('message-menu')?.remove();
    document.getElementById('message-menu-backdrop')?.remove();
    document.querySelectorAll('#chat-messages .message-menu-target').forEach(row => row.classList.remove('message-menu-target'));
}

// Aktion aus dem Menue: erst schliessen (der Zurueck-Schritt kommt asynchron), dann ausfuehren.
// Sonst wuerde das verspaetete Schliessen etwas gerade Geoeffnetes gleich wieder zumachen.
function runMessageMenuAction(action) {
    replaceModal(closeMessageMenu, () => {
        Promise.resolve(action()).catch(logBackgroundError('runMessageMenuAction'));
    });
}

function messageMenuItem(icon, label, action, danger = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `message-menu-item${danger ? ' is-danger' : ''}`;
    button.innerHTML = `<i class="${icon}"></i>`;
    const text = document.createElement('span');
    text.textContent = label;
    button.appendChild(text);
    button.onclick = event => {
        event.stopPropagation();
        runMessageMenuAction(action);
    };
    return button;
}

function renderMessageMenu() {
    const message = messageMenuTarget();
    if (!message) {
        closeMessageMenu();
        return;
    }
    const isMine = message.senderId === state.myProfile.id;
    let backdrop = document.getElementById('message-menu-backdrop');
    if (!backdrop) {
        backdrop = document.createElement('div');
        backdrop.id = 'message-menu-backdrop';
        backdrop.className = 'message-menu-backdrop';
        // Nur ein Tipp, der auch auf dem Hintergrund beginnt, schliesst. Sonst landet der Klick nach dem
        // langen Druecken (Finger hebt sich, der Hintergrund liegt jetzt darunter) hier und das Menue
        // ginge sofort wieder zu.
        backdrop.addEventListener('pointerdown', event => {
            event.preventDefault();
            backdrop.dataset.armed = 'true';
        });
        backdrop.onclick = () => {
            if (backdrop.dataset.armed !== 'true') return;
            closeMessageMenu();
        };
        backdrop.oncontextmenu = event => {
            event.preventDefault();
            closeMessageMenu();
        };
        document.body.appendChild(backdrop);
    }
    let menu = document.getElementById('message-menu');
    if (!menu) {
        menu = document.createElement('div');
        menu.id = 'message-menu';
        menu.className = 'message-menu';
        menu.setAttribute('role', 'menu');
        document.body.appendChild(menu);
    }
    menu.dataset.messageId = message.id;
    const reactions = document.createElement('div');
    reactions.className = 'message-menu-reactions';
    const mine = message.reactions?.[state.myProfile.id]?.emoji || null;
    REACTION_EMOJIS.forEach(emoji => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `message-menu-reaction${emoji === mine ? ' is-active' : ''}`;
        button.textContent = emoji;
        button.setAttribute('aria-label', t('chat.reactWith', { emoji }));
        button.setAttribute('aria-pressed', String(emoji === mine));
        button.onclick = event => {
            event.stopPropagation();
            runMessageMenuAction(() => reactToMessage(message.id, emoji));
        };
        reactions.appendChild(button);
    });
    const items = [messageMenuItem('fa-solid fa-reply', t('chat.reply'), () => startReply(message.id))];
    if (message.text) items.push(messageMenuItem('fa-regular fa-copy', t('common.copy'), () => copyMessageText(message)));
    items.push(messageMenuItem(message.starred ? 'fa-solid fa-star text-amber-400' : 'fa-regular fa-star',
        message.starred ? t('chat.removeStar') : t('chat.starForYourself'), () => toggleMessageStar(message.id)));
    if (isMine) items.push(messageMenuItem('fa-solid fa-trash', t('common.delete'), () => deleteChatMessage(message.id), true));
    const list = document.createElement('div');
    list.className = 'message-menu-items';
    list.append(...items);
    menu.replaceChildren(reactions, list);
    positionMessageMenu(isMine);
}

// Unter die Nachricht, wenn Platz ist, sonst darueber; immer ganz im Bild, zur Seite der Nachricht.
function positionMessageMenu(isMine) {
    const menu = document.getElementById('message-menu');
    const row = document.getElementById(`chat-message-${state.messageMenu?.messageId}`);
    document.querySelectorAll('#chat-messages .message-menu-target').forEach(element => {
        if (element !== row) element.classList.remove('message-menu-target');
    });
    if (!menu) return;
    const bubble = row?.querySelector('.chat-bubble');
    row?.classList.add('message-menu-target');
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const margin = 8;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const box = bubble?.getBoundingClientRect() || { left: (viewportWidth - width) / 2, right: (viewportWidth + width) / 2, top: viewportHeight / 2, bottom: viewportHeight / 2 };
    const left = isMine ? box.right - width : box.left;
    const below = box.bottom + margin;
    const top = below + height <= viewportHeight - margin ? below : box.top - margin - height;
    menu.style.left = `${Math.round(Math.min(viewportWidth - width - margin, Math.max(margin, left)))}px`;
    menu.style.top = `${Math.round(Math.min(viewportHeight - height - margin, Math.max(margin, top)))}px`;
}

// Nach jedem Neuzeichnen des Chats: Menue an die neue Zeile haengen (oder schliessen, wenn die
// Nachricht weg ist).
function syncMessageMenu() {
    if (!state.messageMenu) return;
    renderMessageMenu();
}

document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.messageMenu) closeMessageMenu();
});
// Rechtsklick (bzw. Kontextmenue-Taste) auf eine Nachricht: unser Menue statt des Browser-Menues.
document.addEventListener('contextmenu', event => {
    const row = event.target.closest?.('#chat-messages [id^="chat-message-"]');
    if (!row || event.target.closest('a, input, textarea')) return;
    const messageId = row.id.slice('chat-message-'.length);
    if (!(state.chats[state.activeChatPeerId] || []).some(message => message.id === messageId && !message.deleted)) return;
    event.preventDefault();
    openMessageMenu(messageId);
});
window.addEventListener('resize', () => {
    if (state.messageMenu) syncMessageMenu();
});

// Mit Original (wenn vorhanden) statt Vorschau.
async function openChatImageViewer(messageId) {
    const snaps = (state.chats[state.activeChatPeerId] || [])
        .filter(message => !message.deleted && isInlineSnap(message));
    const images = await Promise.all(snaps.map(bestImageFor));
    openImageViewer(images, snaps.findIndex(message => message.id === messageId), { allowSave: snaps.map(canDownloadMedia) });
}

// Desktop: beim Hovern eine kleine Leiste (Antworten, Reagieren, mehr). Touch: nur der Pfeil in der
// Ecke; beide oeffnen das Kontextmenue.
function renderMessageActions(message, isMine) {
    const actions = document.createElement('div');
    actions.className = `message-actions absolute -top-4 ${isMine ? 'right-1' : 'left-1'} z-10 flex items-center gap-0.5 rounded-full border border-slate-700 bg-slate-900/95 p-0.5 shadow-lg text-slate-300`;
    const button = (className, icon, title, onClick) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = className;
        element.title = title;
        element.setAttribute('aria-label', title);
        element.innerHTML = `<i class="${icon}"></i>`;
        element.onclick = event => {
            event.stopPropagation();
            onClick();
        };
        return element;
    };
    const action = 'message-action w-8 h-8 rounded-full flex items-center justify-center text-sm transition hover:text-slate-50 hover:bg-slate-800';
    actions.append(
        button(action, 'fa-solid fa-reply', t('chat.reply'), () => startReply(message.id)),
        button(action, 'fa-regular fa-face-smile', t('chat.react'), () => openMessageMenu(message.id)),
        button(action, 'fa-solid fa-ellipsis', t('chat.moreActions'), () => openMessageMenu(message.id)),
        button('message-actions-toggle w-6 h-6 rounded-full items-center justify-center text-[10px] text-slate-200 bg-black/25',
            'fa-solid fa-chevron-down', t('chat.showOrHideActions'), () => openMessageMenu(message.id))
    );
    return actions;
}

async function copyMessageText(message) {
    try {
        await navigator.clipboard.writeText(message.text || '');
        showToast(t('chat.textCopied'), 'success');
    } catch {
        showToast(t('common.copyingIsNotPossible'), 'error');
    }
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
    row.className = `message-reactions absolute -bottom-4 ${isMine ? 'left-2' : 'right-2'} z-5 flex gap-1`;
    counts.forEach(({ count, mine }, emoji) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `text-sm leading-none px-2 py-1 rounded-full border shadow-sm ${mine ? 'bg-brand-900 border-brand-500/60' : 'bg-slate-900 border-slate-700'}`;
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

// Im Flirt-Modus (friends.js) gilt der Freundes-Chat wie ein Entdecken-Chat.
function isSocialChat(peerId) {
    return (chatScopeOf(peerId) || currentChatScope()) === 'social' && !isFlirting(peerId);
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

