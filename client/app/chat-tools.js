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
    // Geloeschte Nachrichten kann man nicht beantworten (vorher per Wischen moeglich).
    const message = (state.chats[state.activeChatPeerId] || []).find(item => item.id === messageId);
    if (!message || message.deleted) return;
    if (state.editingMessageId) cancelReply();
    state.replyToMessageId = messageId;
    renderReplyBar();
    document.getElementById('chat-input')?.focus();
}

// Schliesst die Leiste ueber der Eingabe: Antwort oder Bearbeitung abbrechen.
function cancelReply() {
    state.replyToMessageId = null;
    if (state.editingMessageId) {
        state.editingMessageId = null;
        const input = document.getElementById('chat-input');
        if (input) {
            input.value = '';
            if (typeof fitChatInput === 'function') fitChatInput(input);
        }
        if (typeof updateComposeButtons === 'function') updateComposeButtons();
    }
    renderReplyBar();
}

// ----- Nachricht bearbeiten -----
// Eigene Textnachrichten (auch Bild-Unterschriften): der Text kommt ins Eingabefeld, Senden speichert die
// Aenderung (MESSAGE_EDIT, verschluesselt wie alle Chat-Operationen); beim anderen steht "bearbeitet".
function canEditMessage(message) {
    return Boolean(message) && message.senderId === state.myProfile.id && !message.deleted && Boolean(message.text)
        && !message.audioData && !message.secureSnap && !message.video;
}

function startEditMessage(messageId) {
    const message = (state.chats[state.activeChatPeerId] || []).find(item => item.id === messageId);
    if (!canEditMessage(message)) return;
    state.replyToMessageId = null;
    state.editingMessageId = messageId;
    const input = document.getElementById('chat-input');
    if (input) {
        input.value = message.text;
        if (typeof fitChatInput === 'function') fitChatInput(input);
        input.focus();
    }
    if (typeof updateComposeButtons === 'function') updateComposeButtons();
    renderReplyBar();
}

// Aus sendChatMessage: true = es war eine Bearbeitung (keine neue Nachricht).
async function finishEditMessage(text) {
    const peerId = state.activeChatPeerId;
    const messageId = state.editingMessageId;
    if (!messageId) return false;
    const message = (state.chats[peerId] || []).find(item => item.id === messageId);
    state.editingMessageId = null;
    renderReplyBar();
    const input = document.getElementById('chat-input');
    if (input) {
        input.value = '';
        if (typeof fitChatInput === 'function') fitChatInput(input);
    }
    if (typeof updateComposeButtons === 'function') updateComposeButtons();
    if (!canEditMessage(message) || !text || text === message.text) return true;
    const operation = {
        operationId: `edit:${messageId}:${window.crypto.randomUUID()}`,
        peerId,
        type: 'MESSAGE_EDIT',
        messageId,
        text,
        actorId: state.myProfile.id,
        createdAt: Date.now()
    };
    await applyChatOperation(peerId, operation);
    const { peerId: _localPeerId, ...sharedOperation } = operation;
    await sendSecurePayload(peerId, { type: 'CHAT_OPERATION', operation: sharedOperation });
    return true;
}

function renderReplyBar() {
    const bar = document.getElementById('chat-reply-bar');
    if (!bar) return;
    const editing = state.editingMessageId
        ? (state.chats[state.activeChatPeerId] || []).find(item => item.id === state.editingMessageId)
        : null;
    if (editing) {
        bar.classList.remove('hidden');
        document.getElementById('chat-reply-author').textContent = t('chat.editMessage');
        document.getElementById('chat-reply-preview').textContent = editing.text;
        return;
    }
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
    let target = document.getElementById(`chat-message-${messageId}`);
    // Nicht gezeichnet (aelter als die geladene Seite bzw. anderer Tag): erst dorthin.
    if (!target && revealChatMessage(messageId)) target = document.getElementById(`chat-message-${messageId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('chat-message-highlight');
    setTimeout(() => target.classList.remove('chat-message-highlight'), 1500);
}

// ----- Verlauf in Seiten -----
// Lange Chats zeichnen nicht alles: durchgehend nur die letzten CHAT_RENDER_PAGE Nachrichten, oben
// angekommen kommen die naechsten dazu (ohne Springen). Oder als Option "Chat nach Tagen": eine Leiste
// unter der Kontaktleiste zeigt den Tag, Pfeile bzw. seitlich wischen wechseln zu Tagen mit Nachrichten.
// Suche und "nur markierte" durchsuchen immer den ganzen Verlauf.
const CHAT_RENDER_PAGE = 150;
const CHAT_VIEW_RECORD_ID = 'chat-view';

async function loadChatViewSetting() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(CHAT_VIEW_RECORD_ID)).catch(() => null);
    state.chatDayMode = typeof stored?.byDay === 'boolean' ? stored.byDay : clientDefault('chatPagesByDay', false) === true;
    const toggle = document.getElementById('chat-by-day-toggle');
    if (toggle) toggle.checked = state.chatDayMode;
}

async function updateChatViewSetting(byDay) {
    state.chatDayMode = Boolean(byDay);
    state.chatDay = null;
    await putDatabaseRecord('keys', { id: CHAT_VIEW_RECORD_ID, byDay: state.chatDayMode })
        .catch(error => logDebug(`Could not store chat view setting: ${error.message}`));
    if (state.activeChatPeerId) renderChatHistory();
}

function chatDayKey(timestamp) {
    const date = new Date(Number(timestamp) || 0);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function chatDayLabel(dayKey) {
    const [year, month, day] = dayKey.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    if (dayKey === chatDayKey(Date.now())) return t('chat.today');
    if (dayKey === chatDayKey(Date.now() - 86400000)) return t('grid.yesterday');
    const options = { weekday: 'short', day: 'numeric', month: 'short' };
    if (year !== new Date().getFullYear()) options.year = 'numeric';
    return date.toLocaleDateString(document.documentElement.lang || undefined, options);
}

// Welche Nachrichten gezeichnet werden: { messages, older } (older = nicht gezeichnete aeltere).
function chatHistoryWindow(messages, filtering) {
    const bar = document.getElementById('chat-day-bar');
    if (state.chatDayMode && !filtering && messages.length) {
        const days = [...new Set(messages.map(message => chatDayKey(message.createdAt)))];
        if (!days.includes(state.chatDay)) state.chatDay = days[days.length - 1];
        renderChatDayBar(days);
        return { messages: messages.filter(message => chatDayKey(message.createdAt) === state.chatDay), older: 0 };
    }
    bar?.classList.add('hidden');
    const older = Math.max(0, messages.length - state.chatRenderLimit);
    return { messages: older ? messages.slice(older) : messages, older };
}

function renderChatDayBar(days) {
    const bar = document.getElementById('chat-day-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    const index = days.indexOf(state.chatDay);
    document.getElementById('chat-day-label').textContent = chatDayLabel(state.chatDay);
    const prev = document.getElementById('chat-day-prev');
    const next = document.getElementById('chat-day-next');
    if (prev) prev.disabled = index <= 0;
    if (next) next.disabled = index >= days.length - 1;
    state.chatDays = days;
}

function stepChatDay(direction) {
    const days = state.chatDays || [];
    const index = days.indexOf(state.chatDay) + direction;
    if (index < 0 || index >= days.length) return;
    state.chatDay = days[index];
    // Neuer Tag: oben anfangen ausser beim neuesten (dort wie gewohnt unten).
    state.chatPinned = index === days.length - 1;
    renderChatHistory();
    const container = document.getElementById('chat-messages');
    if (container && !state.chatPinned) container.scrollTop = 0;
}

// Aeltere Nachrichten dazuladen, Position halten (oben angekommen bzw. Knopf).
function loadOlderChatMessages() {
    const container = document.getElementById('chat-messages');
    if (!container || !state.chatOlderCount) return;
    const fromBottom = container.scrollHeight - container.scrollTop;
    state.chatRenderLimit += CHAT_RENDER_PAGE;
    renderChatHistory();
    container.scrollTop = container.scrollHeight - fromBottom;
}

// Nachricht ausserhalb der gezeichneten Seite/des Tages sichtbar machen; true, wenn neu gezeichnet.
function revealChatMessage(messageId) {
    const messages = state.chats[state.activeChatPeerId] || [];
    const index = messages.findIndex(message => message.id === messageId);
    if (index < 0) return false;
    if (state.chatDayMode) {
        state.chatDay = chatDayKey(messages[index].createdAt);
    } else {
        state.chatRenderLimit = Math.max(state.chatRenderLimit, messages.length - index + 20);
    }
    state.chatPinned = false;
    renderChatHistory();
    return true;
}

function initChatDayBar() {
    const bar = document.getElementById('chat-day-bar');
    if (!bar) return;
    let start = null;
    bar.addEventListener('touchstart', event => {
        start = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    }, { passive: true });
    bar.addEventListener('touchend', event => {
        if (!start) return;
        const touch = event.changedTouches[0];
        const deltaX = touch.clientX - start.x;
        const deltaY = touch.clientY - start.y;
        start = null;
        if (Math.abs(deltaX) < 40 || Math.abs(deltaX) < Math.abs(deltaY) * 1.5) return;
        hapticTick();
        // Nach rechts wischen = frueherer Tag (wie Blaettern).
        stepChatDay(deltaX > 0 ? -1 : 1);
    }, { passive: true });
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

// immediate: laeuft sofort im Klick (vor dem Schliessen), z. B. fuer die Zwischenablage.
function messageMenuItem(icon, label, action, danger = false, immediate = null) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `message-menu-item${danger ? ' is-danger' : ''}`;
    button.innerHTML = `<i class="${icon}"></i>`;
    const text = document.createElement('span');
    text.textContent = label;
    button.appendChild(text);
    button.onclick = event => {
        event.stopPropagation();
        if (immediate) immediate();
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
        // Kontextmenue-Ereignis des Handys nach dem langen Druecken: nur schliessen, wenn der Druck hier begann.
        backdrop.oncontextmenu = event => {
            event.preventDefault();
            if (backdrop.dataset.armed === 'true') closeMessageMenu();
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
    // Kopieren direkt im Klick (nicht erst nach dem Schliessen): sonst ist die Nutzer-Geste weg und
    // Browser (v. a. Safari) verweigern die Zwischenablage.
    if (message.text) items.push(messageMenuItem('fa-regular fa-copy', t('common.copy'), () => {}, false, () => copyMessageText(message)));
    if (canEditMessage(message)) items.push(messageMenuItem('fa-solid fa-pen', t('chat.edit'), () => startEditMessage(message.id)));
    items.push(messageMenuItem(message.starred ? 'fa-solid fa-star text-amber-400' : 'fa-regular fa-star',
        message.starred ? t('chat.removeStar') : t('chat.starForYourself'), () => toggleMessageStar(message.id)));
    items.push(messageMenuItem('fa-regular fa-square-check', t('chat.select'), () => startMessageSelection(message.id)));
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

// Desktop: welche Nachricht liegt unter der Maus? Zeichnet sich der Verlauf neu (Status, Praesenz ...),
// verliert das neue Element kurz sein :hover und die Leiste blendete von 0 ein (Flackern). Mit der
// gemerkten ID bekommt die neu gezeichnete Nachricht die Leiste sofort ohne Ueberblenden.
function initMessageHoverTracking() {
    const container = document.getElementById('chat-messages');
    if (!container || !window.matchMedia?.('(hover: hover)').matches) return;
    container.addEventListener('mouseover', event => {
        const wrap = event.target.closest?.('.chat-bubble-wrap');
        const row = wrap?.closest('[id^="chat-message-"]');
        const id = row ? row.id.slice('chat-message-'.length) : null;
        if (id === state.hoveredMessageId) return;
        container.querySelectorAll('.chat-bubble-wrap.is-hovered').forEach(element => element.classList.remove('is-hovered'));
        state.hoveredMessageId = id;
    });
    container.addEventListener('mouseleave', () => {
        state.hoveredMessageId = null;
        container.querySelectorAll('.chat-bubble-wrap.is-hovered').forEach(element => element.classList.remove('is-hovered'));
    });
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

// Zwischenablage: erst die moderne API, sonst der alte Weg ueber ein unsichtbares Textfeld (beides muss
// direkt aus einem Klick kommen).
async function copyTextToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const field = document.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(field);
        field.select();
        let copied = false;
        try {
            copied = document.execCommand('copy');
        } catch {
            copied = false;
        }
        field.remove();
        return copied;
    }
}

async function copyMessageText(message) {
    if (await copyTextToClipboard(message.text || '')) showToast(t('chat.textCopied'), 'success');
    else showToast(t('common.copyingIsNotPossible'), 'error');
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
    state.chatRenderLimit = CHAT_RENDER_PAGE;
    state.chatDay = null;
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
    // Abwesend (App nicht sichtbar) geht vor "hat den Chat offen": wer weg ist, schaut nicht zu.
    const away = online && isPeerAway(peerId);
    const watching = online && !away && isSecureChannelOpen(peerId) && Boolean(state.peerChatFocus[peerId]);
    dot.classList.toggle('hidden', !online);
    const sameNetwork = online && state.peerTransport[peerId] === 'lan' ? t('chat.onSameWiFi') : '';
    const presence = peerId ? presenceTextOf(peerId) : '';
    const presenceSuffix = presence ? ` · ${presence}` : '';
    const state_ = !peerId ? '' : watching ? `\u{1F440} ${t('chat.hasChatOpen')}` : away ? t('chat.away') : online ? t('chat.online') : t('chat.offline2');
    status.textContent = peerId ? `${state_}${online ? sameNetwork : ''}${presenceSuffix}` : '';
    status.classList.toggle('text-emerald-400', online && !away);
    status.classList.toggle('text-amber-400', away);
    status.classList.toggle('text-slate-400', !online);
    dot.classList.toggle('bg-emerald-400', !away);
    dot.classList.toggle('bg-amber-400', away);
    dot.title = away ? t('chat.away') : t('common.online');
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
    const social = Boolean(peerId) && isSocialChat(peerId);
    const hidden = social && state.albumButtonRevealedFor !== peerId;
    button.classList.toggle('hidden', hidden);
    // Entdecken/Event (und Flirt): Album und Video hinter einem Medien-Knopf (friends.js); im reinen
    // Freundes-Chat bleibt das Video einzeln (Album meist versteckt, s. o.).
    const row = document.getElementById('chat-compose-row');
    row?.classList.toggle('media-combined', !social);
    if (social) closeComposeMediaMenu();
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


// ----- Mehrere Nachrichten auswaehlen -----
// Start ueber das Nachrichten-Menue ("Auswaehlen"). Danach schaltet jedes Antippen eine Nachricht um; die
// Leiste oben kopiert die Texte (mit Namen, in Reihenfolge) oder loescht eigene Nachrichten. Zurueck oder ✕
// beendet die Auswahl. Nur lokal, nichts wird gesendet ausser beim Loeschen.
function startMessageSelection(messageId) {
    const peerId = state.activeChatPeerId;
    if (!peerId) return;
    const already = Boolean(state.messageSelection);
    state.messageSelection = { peerId, ids: new Set(already ? state.messageSelection.ids : []) };
    if (messageId) state.messageSelection.ids.add(messageId);
    const list = document.getElementById('chat-messages');
    if (list && !list.dataset.selectionHandler) {
        list.dataset.selectionHandler = 'true';
        // Erfasst Klicks vor Bild-Betrachter, Antworten usw., solange ausgewaehlt wird.
        list.addEventListener('click', event => {
            if (!state.messageSelection) return;
            const row = event.target.closest('[id^="chat-message-"]');
            if (!row) return;
            event.preventDefault();
            event.stopPropagation();
            toggleMessageSelection(row.id.slice('chat-message-'.length));
        }, true);
    }
    if (!already) pushModalEntry('messageselection', hideMessageSelection);
    renderMessageSelection();
}

function toggleMessageSelection(messageId) {
    const selection = state.messageSelection;
    if (!selection) return;
    const message = (state.chats[selection.peerId] || []).find(item => item.id === messageId);
    if (!message || message.deleted) return;
    if (selection.ids.has(messageId)) selection.ids.delete(messageId);
    else selection.ids.add(messageId);
    if (!selection.ids.size) {
        closeMessageSelection();
        return;
    }
    renderMessageSelection();
}

function closeMessageSelection() {
    if (!state.messageSelection) return;
    dismissModalEntry('messageselection', hideMessageSelection);
}

function hideMessageSelection() {
    state.messageSelection = null;
    document.getElementById('message-selection-bar')?.remove();
    document.querySelectorAll('#chat-messages .is-selected').forEach(row => row.classList.remove('is-selected'));
}

function selectedMessages() {
    const selection = state.messageSelection;
    if (!selection) return [];
    return (state.chats[selection.peerId] || [])
        .filter(message => selection.ids.has(message.id) && !message.deleted)
        .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
}

function renderMessageSelection() {
    const selection = state.messageSelection;
    if (!selection) return;
    document.querySelectorAll('#chat-messages [id^="chat-message-"]').forEach(row => {
        row.classList.toggle('is-selected', selection.ids.has(row.id.slice('chat-message-'.length)));
    });
    const messages = selectedMessages();
    let bar = document.getElementById('message-selection-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'message-selection-bar';
        bar.className = 'message-selection-bar';
        bar.setAttribute('role', 'toolbar');
        document.getElementById('chat-messages')?.before(bar);
    }
    const button = (icon, label, onClick, danger = false) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = `message-selection-action${danger ? ' is-danger' : ''}`;
        element.innerHTML = `<i class="${icon}"></i>`;
        element.title = label;
        element.setAttribute('aria-label', label);
        element.onclick = onClick;
        return element;
    };
    const count = document.createElement('span');
    count.className = 'message-selection-count';
    count.textContent = t('chat.selectedCount', { count: messages.length });
    const actions = [button('fa-solid fa-xmark', t('chat.endSelection'), () => closeMessageSelection())];
    actions.push(count);
    if (messages.some(message => message.text)) {
        // Kopieren direkt im Klick (Zwischenablage braucht die Nutzer-Geste).
        actions.push(button('fa-regular fa-copy', t('common.copy'), () => {
            copySelectedMessages();
            closeMessageSelection();
        }));
    }
    if (messages.length && messages.every(message => message.senderId === state.myProfile.id)) {
        actions.push(button('fa-solid fa-trash', t('common.delete'), () => deleteSelectedMessages(), true));
    }
    bar.replaceChildren(...actions);
}

// Texte mit Namen, je Nachricht eine Zeile (wie beim Weiterleiten aus anderen Messengern).
async function copySelectedMessages() {
    const lines = selectedMessages().filter(message => message.text).map(message => {
        const author = message.senderId === state.myProfile.id ? t('chat.you') : getPeerPresentation(message.senderId).name || HIDDEN_PEER_NAME;
        return `${author}: ${message.text}`;
    });
    if (await copyTextToClipboard(lines.join('\n'))) showToast(t('chat.messagesCopied', { count: lines.length }), 'success');
    else showToast(t('common.copyingIsNotPossible'), 'error');
}

async function deleteSelectedMessages() {
    const messages = selectedMessages().filter(message => message.senderId === state.myProfile.id);
    if (!messages.length || !window.confirm(t('chat.deleteSelectedMessages', { count: messages.length }))) return;
    closeMessageSelection();
    for (const message of messages) await deleteChatMessage(message.id);
}
