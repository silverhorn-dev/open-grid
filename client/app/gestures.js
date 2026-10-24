// ================= GESTEN (Touch) =================
// Feature Request: tasks/feature-request-gestures.md. Jede Geste hat eine sichtbare Alternative
// (Knoepfe bleiben). Stil-Updates laufen gebuendelt ueber requestAnimationFrame.
//   - Nachricht wischen (fremde nach rechts, eigene nach links) = antworten
//   - Nachricht lange druecken = Aktionsleiste, doppelt tippen = Herz-Reaktion
//   - Zwischen Grid, Chat und Profil seitlich wischen
//   - Profil- und Medienfenster nach unten wischen = schliessen
//   - Im Chat am Ende nach oben ziehen = aktualisieren
// Die Kanten-Geste "zurueck" und Pull-to-Refresh der Seite bleiben dem Betriebssystem/Browser.
const GESTURE_LOCK_DISTANCE = 8;
const REPLY_SWIPE_MAX = 72;
const REPLY_SWIPE_TRIGGER = 56;
const LONG_PRESS_MS = 450;
const DOUBLE_TAP_MS = 300;
const TAB_SWIPE_TRIGGER = 80;
const TAB_SWIPE_EDGE = 24;
const TAB_ORDER = ['grid', 'chat', 'editprofile'];
const SHEET_CLOSE_TRIGGER = 100;
const PULL_REFRESH_TRIGGER = 56;
const PULL_REFRESH_MAX = 72;

function prefersReducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function hapticTick(duration = 10) {
    try {
        navigator.vibrate?.(duration);
    } catch {
        // Nicht ueberall verfuegbar (z. B. iOS).
    }
}

function messageIdFromRow(row) {
    return row?.id?.startsWith('chat-message-') ? row.id.slice('chat-message-'.length) : null;
}

// ----- Nachrichten: wischen, lange druecken, doppelt tippen -----
const messageGesture = { active: null, lastTap: null, frame: 0 };

function handleMessagePointerDown(event) {
    if (event.pointerType !== 'touch') return;
    const wrap = event.target.closest('.chat-bubble-wrap');
    if (!wrap || event.target.closest('button, a, input, img, video')) return;
    const row = wrap.closest('[id^="chat-message-"]');
    const messageId = messageIdFromRow(row);
    if (!messageId) return;
    const gesture = {
        pointerId: event.pointerId,
        row,
        wrap,
        messageId,
        isMine: wrap.classList.contains('is-mine'),
        startX: event.clientX,
        startY: event.clientY,
        axis: null,
        offset: 0,
        longPressed: false
    };
    gesture.longPressTimer = setTimeout(() => {
        if (messageGesture.active !== gesture || gesture.axis) return;
        gesture.longPressed = true;
        hapticTick(15);
        if (!row.classList.contains('actions-open')) toggleMessageActions(row);
    }, LONG_PRESS_MS);
    messageGesture.active = gesture;
}

function renderReplySwipe() {
    messageGesture.frame = 0;
    const gesture = messageGesture.active;
    if (!gesture) return;
    gesture.wrap.style.transition = 'none';
    gesture.wrap.style.transform = `translate3d(${gesture.offset}px, 0, 0)`;
    const progress = Math.min(1, Math.abs(gesture.offset) / REPLY_SWIPE_TRIGGER);
    let hint = gesture.row.querySelector('.reply-swipe-hint');
    if (!hint) {
        hint = document.createElement('span');
        hint.className = `reply-swipe-hint absolute top-1/2 -translate-y-1/2 ${gesture.isMine ? 'right-1' : 'left-1'} text-brand-400 pointer-events-none`;
        hint.innerHTML = '<i class="fa-solid fa-reply"></i>';
        gesture.row.style.position = 'relative';
        gesture.row.appendChild(hint);
    }
    hint.style.opacity = String(progress);
}

function handleMessagePointerMove(event) {
    const gesture = messageGesture.active;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.longPressed) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.axis) {
        if (Math.hypot(deltaX, deltaY) < GESTURE_LOCK_DISTANCE) return;
        clearTimeout(gesture.longPressTimer);
        gesture.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'x' : 'y';
    }
    if (gesture.axis !== 'x') return;
    // Nur weg vom Bildschirmrand: fremde Nachrichten nach rechts, eigene nach links.
    const directed = gesture.isMine ? Math.min(0, deltaX) : Math.max(0, deltaX);
    gesture.offset = Math.sign(directed) * Math.min(REPLY_SWIPE_MAX, Math.abs(directed));
    if (!messageGesture.frame) messageGesture.frame = requestAnimationFrame(renderReplySwipe);
}

function finishMessageGesture(event, cancelled) {
    const gesture = messageGesture.active;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    messageGesture.active = null;
    clearTimeout(gesture.longPressTimer);
    if (gesture.axis === 'x') {
        if (!cancelled && Math.abs(gesture.offset) >= REPLY_SWIPE_TRIGGER) {
            hapticTick();
            startReply(gesture.messageId);
        }
        gesture.wrap.style.transition = prefersReducedMotion() ? 'none' : 'transform 200ms ease-out';
        gesture.wrap.style.transform = '';
        gesture.row.querySelector('.reply-swipe-hint')?.remove();
        return;
    }
    if (cancelled || gesture.axis || gesture.longPressed) return;
    // Doppelt tippen = Herz.
    const now = Date.now();
    const last = messageGesture.lastTap;
    if (last && last.messageId === gesture.messageId && now - last.at < DOUBLE_TAP_MS) {
        messageGesture.lastTap = null;
        hapticTick();
        reactToMessage(gesture.messageId, '❤️');
        return;
    }
    messageGesture.lastTap = { messageId: gesture.messageId, at: now };
}

// ----- Seitlich zwischen den Tabs wischen -----
const tabSwipe = { active: null };

function currentTab() {
    return TAB_ORDER.find(tab => !document.getElementById(`view-${tab}`)?.classList.contains('hidden')) || null;
}

// Nicht in Bereichen, die selbst horizontal reagieren.
function blocksTabSwipe(target) {
    if (target.closest('input, textarea, select, [data-no-tab-swipe], #chat-messages, .chat-bubble-wrap')) return true;
    if (document.getElementById('view-chat')?.classList.contains('chat-open')) return true;
    for (let element = target; element && element !== document.body; element = element.parentElement) {
        const overflowX = getComputedStyle(element).overflowX;
        if ((overflowX === 'auto' || overflowX === 'scroll') && element.scrollWidth > element.clientWidth) return true;
    }
    return false;
}

function handleTabTouchStart(event) {
    tabSwipe.active = null;
    if (event.touches.length !== 1 || !currentTab()) return;
    const touch = event.touches[0];
    // Kanten bleiben der System-Geste "zurueck".
    if (touch.clientX < TAB_SWIPE_EDGE || touch.clientX > window.innerWidth - TAB_SWIPE_EDGE) return;
    if (blocksTabSwipe(event.target)) return;
    tabSwipe.active = { startX: touch.clientX, startY: touch.clientY, axis: null, deltaX: 0, startedAt: performance.now() };
}

function handleTabTouchMove(event) {
    const gesture = tabSwipe.active;
    if (!gesture) return;
    const touch = event.touches[0];
    const deltaX = touch.clientX - gesture.startX;
    const deltaY = touch.clientY - gesture.startY;
    if (!gesture.axis) {
        if (Math.hypot(deltaX, deltaY) < GESTURE_LOCK_DISTANCE * 1.5) return;
        gesture.axis = Math.abs(deltaX) > Math.abs(deltaY) * 1.5 ? 'x' : 'y';
    }
    if (gesture.axis !== 'x') return;
    gesture.deltaX = deltaX;
    const view = document.getElementById(`view-${currentTab()}`);
    if (view && !prefersReducedMotion()) {
        view.style.transition = 'none';
        view.style.transform = `translate3d(${deltaX * 0.25}px, 0, 0)`;
        view.style.opacity = String(1 - Math.min(0.4, Math.abs(deltaX) / 600));
    }
}

function handleTabTouchEnd() {
    const gesture = tabSwipe.active;
    tabSwipe.active = null;
    const tab = currentTab();
    const view = tab ? document.getElementById(`view-${tab}`) : null;
    if (view) {
        view.style.transition = prefersReducedMotion() ? 'none' : 'transform 180ms ease-out, opacity 180ms ease-out';
        view.style.transform = '';
        view.style.opacity = '';
    }
    if (!gesture || gesture.axis !== 'x') return;
    const fast = Math.abs(gesture.deltaX) / Math.max(1, performance.now() - gesture.startedAt) > 0.5;
    if (Math.abs(gesture.deltaX) < TAB_SWIPE_TRIGGER && !fast) return;
    const order = TAB_ORDER.filter(entry => entry !== 'grid' || isGridAvailable());
    const index = order.indexOf(tab) + (gesture.deltaX < 0 ? 1 : -1);
    if (index < 0 || index >= order.length) return;
    hapticTick();
    switchTab(order[index]);
}

// ----- Fenster nach unten wischen = schliessen -----
function attachSwipeToClose(scrollContainer, card, close) {
    if (!scrollContainer || !card) return;
    let gesture = null;
    scrollContainer.addEventListener('touchstart', event => {
        gesture = null;
        if (event.touches.length !== 1 || scrollContainer.scrollTop > 0) return;
        if (event.target.closest('input, textarea, select, [data-no-sheet-swipe]')) return;
        gesture = { startY: event.touches[0].clientY, startX: event.touches[0].clientX, axis: null, deltaY: 0 };
    }, { passive: true });
    scrollContainer.addEventListener('touchmove', event => {
        if (!gesture) return;
        const deltaY = event.touches[0].clientY - gesture.startY;
        const deltaX = event.touches[0].clientX - gesture.startX;
        if (!gesture.axis) {
            if (Math.hypot(deltaX, deltaY) < GESTURE_LOCK_DISTANCE) return;
            gesture.axis = deltaY > 0 && Math.abs(deltaY) > Math.abs(deltaX) ? 'down' : 'other';
        }
        if (gesture.axis !== 'down' || scrollContainer.scrollTop > 0) return;
        gesture.deltaY = Math.max(0, deltaY);
        card.style.transition = 'none';
        card.style.transform = `translate3d(0, ${gesture.deltaY}px, 0)`;
    }, { passive: true });
    scrollContainer.addEventListener('touchend', () => {
        const finished = gesture;
        gesture = null;
        card.style.transition = prefersReducedMotion() ? 'none' : 'transform 200ms ease-out';
        card.style.transform = '';
        if (finished?.axis === 'down' && finished.deltaY > SHEET_CLOSE_TRIGGER) close();
    }, { passive: true });
}

// ----- Chat: am Ende nach oben ziehen = einstellbare Aktion -----
// keys/pullup-settings: 'reload' (Tab neu laden, Standard), 'next' (naechster Chat der Liste),
// 'switcher' (Auswahl aller Chats der Liste), 'snap' (Snap-Kamera), 'album' (Album teilen).
const PULL_UP_ACTIONS = {
    reload: 'Loslassen zum Neuladen',
    next: 'Loslassen: naechster Chat',
    switcher: 'Loslassen: Chat auswaehlen',
    snap: 'Loslassen: Snap aufnehmen',
    album: 'Loslassen: Album teilen'
};
const PULL_UP_RECORD_ID = 'pullup-settings';

async function loadPullUpSetting() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(PULL_UP_RECORD_ID)).catch(() => null);
    state.pullUpAction = PULL_UP_ACTIONS[stored?.action] ? stored.action : 'reload';
    const select = document.getElementById('pullup-action-select');
    if (select) select.value = state.pullUpAction;
}

async function updatePullUpSetting(action) {
    if (!PULL_UP_ACTIONS[action]) return;
    state.pullUpAction = action;
    await putDatabaseRecord('keys', { id: PULL_UP_RECORD_ID, action })
        .catch(error => logDebug(`Could not store pull-up setting: ${error.message}`));
}

// Ohne Toast/Banner (die stapelten sich beim schnellen Wiederholen).
function runPullUpAction() {
    const action = state.pullUpAction;
    if (action === 'next') {
        // Am Ende der Liste wieder von vorn.
        const target = neighbourChat(1) || visibleChatPeerIds().find(peerId => peerId !== state.activeChatPeerId);
        if (target) switchToChat(target).catch(logBackgroundError('runPullUpAction'));
    } else if (action === 'switcher') {
        openChatSwitcherSheet();
    } else if (action === 'snap') {
        openSnapUploadModal().catch(logBackgroundError('runPullUpAction'));
    } else if (action === 'album') {
        openAlbumPicker();
    } else {
        window.location.reload();
    }
}

function attachPullUpRefresh(container) {
    if (!container) return;
    let gesture = null;
    const indicator = document.getElementById('chat-pull-refresh');
    const isAtBottom = () => container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
    const render = distance => {
        if (!indicator) return;
        indicator.style.height = `${distance}px`;
        indicator.classList.toggle('is-ready', distance >= PULL_REFRESH_TRIGGER);
        indicator.querySelector('span').textContent = distance >= PULL_REFRESH_TRIGGER
            ? PULL_UP_ACTIONS[state.pullUpAction] || PULL_UP_ACTIONS.reload
            : 'Weiter ziehen';
    };
    container.addEventListener('touchstart', event => {
        gesture = event.touches.length === 1 && state.activeChatPeerId && isAtBottom()
            ? { startY: event.touches[0].clientY, distance: 0 }
            : null;
    }, { passive: true });
    container.addEventListener('touchmove', event => {
        if (!gesture) return;
        const pulled = gesture.startY - event.touches[0].clientY;
        if (pulled <= 0 || !isAtBottom()) {
            gesture.distance = 0;
            render(0);
            return;
        }
        gesture.distance = Math.min(PULL_REFRESH_MAX, pulled * 0.5);
        render(gesture.distance);
    }, { passive: true });
    container.addEventListener('touchend', () => {
        const finished = gesture;
        gesture = null;
        render(0);
        if (finished?.distance >= PULL_REFRESH_TRIGGER) {
            hapticTick();
            runPullUpAction();
        }
    }, { passive: true });
}

function initGestures() {
    const messages = document.getElementById('chat-messages');
    if (messages) {
        messages.addEventListener('pointerdown', handleMessagePointerDown);
        messages.addEventListener('pointermove', handleMessagePointerMove);
        messages.addEventListener('pointerup', event => finishMessageGesture(event, false));
        messages.addEventListener('pointercancel', event => finishMessageGesture(event, true));
        attachPullUpRefresh(messages);
    }
    const main = document.querySelector('main.app-main');
    if (main) {
        main.addEventListener('touchstart', handleTabTouchStart, { passive: true });
        main.addEventListener('touchmove', handleTabTouchMove, { passive: true });
        main.addEventListener('touchend', handleTabTouchEnd, { passive: true });
        main.addEventListener('touchcancel', handleTabTouchEnd, { passive: true });
    }
    attachSwipeToClose(
        document.getElementById('profile-detail-modal'),
        document.querySelector('#profile-detail-modal > div'),
        closeProfileModal
    );
    attachSwipeToClose(
        document.getElementById('media-modal-content'),
        document.querySelector('#media-modal > div'),
        closeMediaModal
    );
}
