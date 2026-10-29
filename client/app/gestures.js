// ================= GESTEN (Touch) =================
// Feature Request: tasks/feature-request-gestures.md. Jede Geste hat eine sichtbare Alternative
// (Knoepfe bleiben). Stil-Updates laufen gebuendelt ueber requestAnimationFrame.
//   - Nachricht wischen (fremde nach rechts, eigene nach links) = antworten
//   - Nachricht lange druecken = Aktionsleiste, doppelt tippen = Herz-Reaktion
//   - Zwischen Grid, Chat und Profil seitlich wischen; im Profil nach links = Menue
//   - Einstellungen: seitlich = Bereiche blaettern (nicht auf Reglern), oben nach unten = verlassen,
//     am ersten Bereich nach rechts = verlassen
//   - Grid, Chatliste und Profil: oben nach unten ziehen = neu laden (ganze Seite oder nur Daten, Einstellung)
//   - Seitenmenue nach rechts wischen = schliessen
//   - Im Chat auf der Eingabeleiste nach rechts wischen = zur Chatliste (einstellbar)
//   - Profil- und Medienfenster nach unten wischen = schliessen
//   - Im Chat am Ende nach oben ziehen = aktualisieren
// Die Kanten-Geste "zurueck" und Pull-to-Refresh der Seite bleiben dem Betriebssystem/Browser.
const GESTURE_LOCK_DISTANCE = 8;
const REPLY_SWIPE_MAX = 72;
const REPLY_SWIPE_TRIGGER = 56;
// Unsichtbares Band in der Mitte des Verlaufs (etwa 1 cm): dort nach rechts wischen schliesst den Chat.
const CHAT_CLOSE_BAND = 40;
// Beim Wegwischen folgt der Chat dem Finger und wird dabei leicht kleiner (hoechstens auf 97 %), wie eine Karte.
const CHAT_SWIPE_MIN_SCALE = 0.97;
const CHAT_SWIPE_MAX_RADIUS = 18;

function chatSwipePanel() {
    return document.getElementById('chat-window-panel') || document.getElementById('view-chat');
}

function renderChatSwipe(deltaX) {
    const panel = chatSwipePanel();
    if (!panel) return;
    if (prefersReducedMotion()) return;
    const progress = Math.min(1, deltaX / (TAB_SWIPE_TRIGGER * 2));
    panel.style.transition = 'none';
    panel.style.transformOrigin = 'center center';
    panel.style.transform = `translate3d(${deltaX}px, 0, 0) scale(${1 - (1 - CHAT_SWIPE_MIN_SCALE) * progress})`;
    panel.style.borderRadius = `${Math.round(CHAT_SWIPE_MAX_RADIUS * progress)}px`;
}

function resetChatSwipe() {
    const panel = chatSwipePanel();
    if (!panel) return;
    panel.style.transition = prefersReducedMotion() ? 'none' : 'transform 180ms ease-out, border-radius 180ms ease-out';
    panel.style.transform = '';
    panel.style.borderRadius = '';
}
const LONG_PRESS_MS = 450;
const DOUBLE_TAP_MS = 300;
const TAB_SWIPE_TRIGGER = 80;
const TAB_SWIPE_EDGE = 24;
// Ansichten, zwischen denen seitlich gewischt wird. Die Einstellungen ('keys') gehoeren zum Profil:
// dort blaettert seitliches Wischen die Bereiche, verlassen geht nur nach unten (zurueck ins Profil).
// Im Profil nach links wischen oeffnet das Menue.
const TAB_ORDER = ['grid', 'chat', 'editprofile', 'keys'];
const SWIPE_TABS = ['grid', 'chat', 'editprofile'];
const SETTINGS_LEAVE_TRIGGER = 120;
const GRID_REFRESH_TRIGGER = 70;
const GRID_REFRESH_MAX = 90;
const SHEET_CLOSE_TRIGGER = 100;
// Album-Ansicht: 40 % der Bildschirmhoehe, mindestens 220 px.
const ALBUM_SHEET_CLOSE_SHARE = 0.4;
const ALBUM_SHEET_CLOSE_MIN = 220;
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

// Wischen startet in der ganzen Zeile, auch im Leerraum neben der Nachricht und auf dem kleinen
// Aktionen-Pfeil (er sitzt genau dort, wo der Daumen beim Wischen nach rechts ansetzt). Andere
// Knoepfe, Links und Medien bleiben ausgenommen.
// Schliessen per Wischen nach rechts (Hintergrund-Geste): im unsichtbaren Band in der Mitte immer, sonst
// dort, wo keine Nachricht (Zeile) liegt, auf geloeschten Nachrichten und auf eigenen Nachrichten (die
// werden nach links beantwortet).
function handleMessagePointerDown(event) {
    if (event.pointerType !== 'touch') return;
    if (event.target.closest('input, [data-voice-track], [role="slider"]')) return;
    const container = event.currentTarget;
    const bounds = container.getBoundingClientRect();
    if (Math.abs(event.clientX - (bounds.left + bounds.width / 2)) <= CHAT_CLOSE_BAND / 2) {
        startChatCloseGesture(event);
        return;
    }
    const row = event.target.closest('[id^="chat-message-"]');
    const wrap = row?.querySelector('.chat-bubble-wrap');
    const messageId = messageIdFromRow(row);
    const message = messageId ? (state.chats[state.activeChatPeerId] || []).find(item => item.id === messageId) : null;
    if (!wrap || !messageId || message?.deleted) {
        startChatCloseGesture(event);
        return;
    }
    const control = event.target.closest('button, a, img, video, canvas');
    if (control && !control.classList.contains('message-actions-toggle')) return;
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
        openMessageMenu(gesture.messageId);
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
    if (moveChatCloseGesture(event)) return;
    const gesture = messageGesture.active;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.longPressed) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.axis) {
        if (Math.hypot(deltaX, deltaY) < GESTURE_LOCK_DISTANCE) return;
        clearTimeout(gesture.longPressTimer);
        gesture.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'x' : 'y';
        // Ab jetzt gehoert der Finger uns, auch wenn sich das Layout verschiebt (z. B. Tastatur).
        if (gesture.axis === 'x') {
            try {
                gesture.row.setPointerCapture(event.pointerId);
            } catch {
                // Pointer schon weg.
            }
        }
    }
    if (gesture.axis !== 'x') return;
    // Eigene Nachricht nach rechts: gehoert nicht der Nachricht (die geht nach links), also Chat schliessen.
    if (gesture.isMine && deltaX > 0 && !gesture.offset) {
        clearTimeout(gesture.longPressTimer);
        messageGesture.active = null;
        startChatCloseGesture(event, { startX: gesture.startX, startY: gesture.startY, axis: 'right' });
        moveChatCloseGesture(event);
        return;
    }
    // Nur weg vom Bildschirmrand: fremde Nachrichten nach rechts, eigene nach links.
    const directed = gesture.isMine ? Math.min(0, deltaX) : Math.max(0, deltaX);
    gesture.offset = Math.sign(directed) * Math.min(REPLY_SWIPE_MAX, Math.abs(directed));
    if (!messageGesture.frame) messageGesture.frame = requestAnimationFrame(renderReplySwipe);
}

// ----- Chat nach rechts wischen = schliessen (Hintergrund-Geste im Verlauf) -----
const chatCloseGesture = { active: null };

function startChatCloseGesture(event, { startX = event.clientX, startY = event.clientY, axis = null } = {}) {
    if (!state.chatSwipeClose || !state.activeChatPeerId) return false;
    chatCloseGesture.active = { pointerId: event.pointerId, container: event.currentTarget, startX, startY, axis, deltaX: 0, startedAt: performance.now() };
    return true;
}

function moveChatCloseGesture(event) {
    const gesture = chatCloseGesture.active;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.axis) {
        if (Math.hypot(deltaX, deltaY) < GESTURE_LOCK_DISTANCE * 1.5) return true;
        gesture.axis = deltaX > 0 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5 ? 'right' : 'other';
        if (gesture.axis === 'right') {
            try {
                gesture.container?.setPointerCapture(event.pointerId);
            } catch {
                // Pointer schon weg.
            }
        }
    }
    if (gesture.axis !== 'right') return true;
    gesture.deltaX = Math.max(0, deltaX);
    renderChatSwipe(gesture.deltaX);
    return true;
}

function finishChatCloseGesture(event, cancelled) {
    const gesture = chatCloseGesture.active;
    if (!gesture || gesture.pointerId !== event.pointerId) return false;
    chatCloseGesture.active = null;
    if (gesture.axis !== 'right') return true;
    messageGesture.suppressClickUntil = Date.now() + 400;
    resetChatSwipe();
    const fast = gesture.deltaX / Math.max(1, performance.now() - gesture.startedAt) > 0.5;
    if (!cancelled && (gesture.deltaX >= TAB_SWIPE_TRIGGER || fast)) {
        hapticTick();
        leaveActiveChat();
    }
    return true;
}

function finishMessageGesture(event, cancelled) {
    if (finishChatCloseGesture(event, cancelled)) return;
    const gesture = messageGesture.active;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    messageGesture.active = null;
    clearTimeout(gesture.longPressTimer);
    if (gesture.axis === 'x') {
        // Der Klick nach dem Wischen (z. B. auf dem Pfeil) soll nichts aufklappen.
        messageGesture.suppressClickUntil = Date.now() + 400;
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
    // Schalter, Auswahlen und nicht fokussierte Textfelder reagieren auf Tippen, nicht auf Wischen: dort darf
    // das Wischen starten. Ein fokussiertes Textfeld (Cursor, Markieren) und Regler gehoeren dem Finger.
    if (target.closest('textarea:focus, input:focus:not([type="checkbox"]):not([type="radio"]), input[type="range"], [data-no-tab-swipe], #chat-messages, .chat-bubble-wrap')) return true;
    // Offener Chat (Smartphone, Vollbild): dort gehoert das seitliche Wischen den Nachrichten. Nur solange
    // er sichtbar ist; im Hintergrund behaelt die Ansicht "chat-open", andere Tabs wischen trotzdem.
    const chatView = document.getElementById('view-chat');
    if (chatView?.classList.contains('chat-open') && !chatView.classList.contains('hidden')) return true;
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
    // Regler (Schieber) gehoeren dem Finger, auch wenn sie keine Eingabefelder im engeren Sinn sind.
    if (event.target.closest('[role="slider"], .setting-range, input[type="range"]')) return;
    tabSwipe.active = {
        startX: touch.clientX, startY: touch.clientY, axis: null, deltaX: 0, deltaY: 0,
        startedAt: performance.now(), atTop: window.scrollY <= 0
    };
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
    const view = document.getElementById(`view-${currentTab()}`);
    // Grid und Profil: ganz oben nach unten ziehen = neu laden (eigene Geste, die installierte PWA auf iOS
    // hat keine).
    if (gesture.axis === 'y' && PULL_REFRESH_TABS[currentTab()] && gesture.atTop && window.scrollY <= 0) {
        gesture.deltaY = Math.max(0, deltaY);
        renderGridPullRefresh(Math.min(GRID_REFRESH_MAX, gesture.deltaY * 0.5), currentTab());
        return;
    }
    // Einstellungen: ganz oben nach unten ziehen = verlassen (Ansicht folgt dem Finger).
    if (gesture.axis === 'y' && currentTab() === 'keys' && gesture.atTop && window.scrollY <= 0) {
        gesture.deltaY = Math.max(0, deltaY);
        if (view && !prefersReducedMotion()) {
            view.style.transition = 'none';
            view.style.transform = `translate3d(0, ${gesture.deltaY * 0.4}px, 0)`;
            view.style.opacity = gesture.deltaY > SETTINGS_LEAVE_TRIGGER ? '0.6' : '';
        }
        return;
    }
    if (gesture.axis !== 'x') return;
    gesture.deltaX = deltaX;
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
    if (!gesture) return;
    if (PULL_REFRESH_TABS[tab] && gesture.axis === 'y') {
        renderGridPullRefresh(0, tab);
        if (gesture.deltaY >= GRID_REFRESH_TRIGGER) {
            hapticTick();
            reloadView(tab === 'grid' ? 'grid' : 'profile');
        }
        return;
    }
    if (tab === 'keys' && gesture.axis === 'y') {
        if (gesture.deltaY > SETTINGS_LEAVE_TRIGGER) {
            hapticTick();
            switchTab('editprofile');
        }
        return;
    }
    if (gesture.axis !== 'x') return;
    const fast = Math.abs(gesture.deltaX) / Math.max(1, performance.now() - gesture.startedAt) > 0.5;
    if (Math.abs(gesture.deltaX) < TAB_SWIPE_TRIGGER && !fast) return;
    const forward = gesture.deltaX < 0;
    if (tab === 'keys') {
        stepSettingsTab(forward ? 1 : -1);
        return;
    }
    if (tab === 'editprofile' && forward) {
        hapticTick();
        openMenu();
        return;
    }
    const order = SWIPE_TABS.filter(entry => entry !== 'grid' || isGridAvailable());
    const index = order.indexOf(tab) + (forward ? 1 : -1);
    if (index < 0 || index >= order.length) return;
    hapticTick();
    switchTab(order[index]);
}

// Ansichten mit eigenem Runterziehen ueber den Tab-Wischer und ihre Anzeige.
const PULL_REFRESH_TABS = { grid: 'grid-pull-refresh', editprofile: 'profile-pull-refresh' };

function renderGridPullRefresh(distance, tab = 'grid') {
    const indicator = document.getElementById(PULL_REFRESH_TABS[tab] || 'grid-pull-refresh');
    if (!indicator) return;
    indicator.style.height = `${distance}px`;
    // Anzeige waechst mit dem halben Zug; bereit, sobald der Zug GRID_REFRESH_TRIGGER erreicht.
    const ready = distance >= GRID_REFRESH_TRIGGER / 2;
    indicator.classList.toggle('is-ready', ready);
    const label = indicator.querySelector('span');
    if (label) label.textContent = ready ? t('grid.releaseToRefresh') : t('grid.pullToRefresh');
}

// Einstellungen: naechster/vorheriger Bereich (an den Enden passiert nichts).
function stepSettingsTab(direction) {
    const tabs = SETTINGS_TABS.filter(name => name !== 'debug' || CONFIG.DEBUG_MODE);
    const index = tabs.indexOf(state.settingsTab || 'general') + direction;
    // Am ersten Bereich nach rechts: Einstellungen verlassen (zurueck ins Profil).
    if (index < 0) {
        hapticTick();
        switchTab('editprofile');
        return;
    }
    if (index >= tabs.length) return;
    hapticTick();
    switchSettingsTab(tabs[index]);
}

// ----- Seitlich wischen = schliessen (Seitenmenue, Chat ueber die Eingabeleiste) -----
// `move` bewegt das Element mit dem Finger (nur nach rechts), ab TAB_SWIPE_TRIGGER oder schnell = `close`.
// `render`/`reset` (optional) zeichnen die Bewegung selbst (Chat: mit leichter Verkleinerung).
function attachSwipeRight(area, { moving = () => area, close, enabled = () => true, render = null, resetView = null }) {
    if (!area) return;
    let gesture = null;
    const reset = () => {
        if (resetView) return resetView();
        const element = moving();
        if (!element) return;
        element.style.transition = prefersReducedMotion() ? 'none' : 'transform 180ms ease-out';
        element.style.transform = '';
    };
    area.addEventListener('touchstart', event => {
        gesture = null;
        if (event.touches.length !== 1 || !enabled()) return;
        if (event.target.closest('textarea:focus, [role="slider"], input[type="range"], [data-no-tab-swipe]')) return;
        const touch = event.touches[0];
        gesture = { startX: touch.clientX, startY: touch.clientY, axis: null, deltaX: 0, startedAt: performance.now() };
    }, { passive: true });
    area.addEventListener('touchmove', event => {
        if (!gesture) return;
        const deltaX = event.touches[0].clientX - gesture.startX;
        const deltaY = event.touches[0].clientY - gesture.startY;
        if (!gesture.axis) {
            if (Math.hypot(deltaX, deltaY) < GESTURE_LOCK_DISTANCE * 1.5) return;
            gesture.axis = deltaX > 0 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5 ? 'right' : 'other';
        }
        if (gesture.axis !== 'right') return;
        gesture.deltaX = Math.max(0, deltaX);
        if (render) {
            render(gesture.deltaX);
            return;
        }
        const element = moving();
        if (element && !prefersReducedMotion()) {
            element.style.transition = 'none';
            element.style.transform = `translate3d(${gesture.deltaX}px, 0, 0)`;
        }
    }, { passive: true });
    const finish = cancelled => {
        const finished = gesture;
        gesture = null;
        reset();
        if (cancelled || finished?.axis !== 'right') return;
        const fast = finished.deltaX / Math.max(1, performance.now() - finished.startedAt) > 0.5;
        if (finished.deltaX < TAB_SWIPE_TRIGGER && !fast) return;
        hapticTick();
        close();
    };
    area.addEventListener('touchend', () => finish(false), { passive: true });
    area.addEventListener('touchcancel', () => finish(true), { passive: true });
}

// Einstellung: Eingabeleiste nach rechts wischen schliesst den Chat (`keys`/`chat-swipe-close`,
// Router-Standard `CLIENT_DEFAULTS.inputSwipeClosesChat`, sonst an).
const CHAT_SWIPE_CLOSE_RECORD_ID = 'chat-swipe-close';

async function loadChatSwipeCloseSetting() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(CHAT_SWIPE_CLOSE_RECORD_ID)).catch(() => null);
    state.chatSwipeClose = typeof stored?.enabled === 'boolean' ? stored.enabled : clientDefault('inputSwipeClosesChat', true) !== false;
    const toggle = document.getElementById('chat-swipe-close-toggle');
    if (toggle) toggle.checked = state.chatSwipeClose;
}

async function updateChatSwipeCloseSetting(enabled) {
    state.chatSwipeClose = Boolean(enabled);
    await putDatabaseRecord('keys', { id: CHAT_SWIPE_CLOSE_RECORD_ID, enabled: state.chatSwipeClose })
        .catch(error => logDebug(`Could not store chat swipe setting: ${error.message}`));
}

// ----- Fenster nach unten wischen = schliessen -----
// `trigger()` liefert die noetige Zugstrecke (Standard SHEET_CLOSE_TRIGGER). Ab dieser Strecke wird die
// Karte etwas durchsichtig: loslassen schliesst.
function attachSwipeToClose(scrollContainer, card, close, { trigger = () => SHEET_CLOSE_TRIGGER } = {}) {
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
        card.style.opacity = gesture.deltaY > trigger() ? '0.6' : '';
    }, { passive: true });
    const finish = cancelled => {
        const finished = gesture;
        gesture = null;
        // Nur nach eigenem Zug nach unten zuruecksetzen (sonst stoert es z. B. das seitliche Blaettern).
        if (finished?.axis !== 'down') return;
        card.style.transition = prefersReducedMotion() ? 'none' : 'transform 200ms ease-out, opacity 200ms ease-out';
        card.style.transform = '';
        card.style.opacity = '';
        if (!cancelled && finished.deltaY > trigger()) close();
    };
    scrollContainer.addEventListener('touchend', () => finish(false), { passive: true });
    scrollContainer.addEventListener('touchcancel', () => finish(true), { passive: true });
}

// ----- Chat: am Ende nach oben ziehen = einstellbare Aktion -----
// keys/pullup-settings: 'reload' (Tab neu laden, Standard), 'next' (naechster Chat der Liste),
// 'switcher' (Auswahl aller Chats der Liste), 'snap' (Snap-Kamera), 'album' (Album teilen).
const PULL_UP_ACTIONS = {
    reload: t('gestures.releaseToReload'),
    next: t('gestures.releaseNextChat'),
    switcher: t('gestures.releaseChooseChat'),
    snap: t('gestures.releaseTakeSnap'),
    album: t('gestures.releaseShareAlbum')
};
const PULL_UP_RECORD_ID = 'pullup-settings';

async function loadPullUpSetting() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(PULL_UP_RECORD_ID)).catch(() => null);
    const fallback = PULL_UP_ACTIONS[clientDefault('pullUpAction')] ? clientDefault('pullUpAction') : 'reload';
    state.pullUpAction = PULL_UP_ACTIONS[stored?.action] ? stored.action : fallback;
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
        reloadView('chat');
    }
}

// ----- Neu laden: ganze Seite oder nur Daten -----
// Einstellung `keys`/`reload-mode` ('full' | 'app'), Router-Standard `CLIENT_DEFAULTS.reloadMode`, sonst 'full'.
// 'full' laedt den Tab im Browser neu; 'app' holt nur die Daten der Ansicht neu (ohne Hinweis), die ganze
// Seite laesst sich dann ueber das Menue neu laden.
const RELOAD_MODE_RECORD_ID = 'reload-mode';
const RELOAD_MODES = ['full', 'app'];

async function loadReloadMode() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(RELOAD_MODE_RECORD_ID)).catch(() => null);
    const routerDefault = clientDefault('reloadMode', 'full');
    state.reloadMode = RELOAD_MODES.includes(stored?.mode) ? stored.mode : RELOAD_MODES.includes(routerDefault) ? routerDefault : 'full';
    renderReloadMode();
}

async function updateReloadMode(mode) {
    if (!RELOAD_MODES.includes(mode)) return;
    state.reloadMode = mode;
    await putDatabaseRecord('keys', { id: RELOAD_MODE_RECORD_ID, mode })
        .catch(error => logDebug(`Could not store reload mode: ${error.message}`));
    renderReloadMode();
}

function renderReloadMode() {
    const select = document.getElementById('reload-mode-select');
    if (select) select.value = state.reloadMode;
    document.getElementById('menu-reload-page')?.classList.toggle('hidden', state.reloadMode !== 'app');
}

function reloadPageFromMenu() {
    window.location.reload();
}

async function reloadView(view) {
    if (state.reloadMode !== 'app') {
        window.location.reload();
        return;
    }
    if (view === 'grid') {
        await fetchPeersFromWorkerGrid();
    } else if (view === 'profile') {
        await loadMyLocalProfile();
        renderProfileForm();
    } else if (view === 'chat' && state.activeChatPeerId) {
        await loadChatHistory(state.activeChatPeerId);
        renderChatHistory();
        await fetchQueuedCacheMessages();
    } else {
        await loadChatPeerIds();
        subscribePresence();
        await fetchQueuedCacheMessages();
    }
}

// Chatliste: ganz oben nach unten ziehen = neu laden (gleiche Schwelle wie im Grid).
function attachChatListPullRefresh() {
    const list = document.getElementById('active-peers-list');
    const indicator = document.getElementById('chat-list-pull-refresh');
    if (!list || !indicator) return;
    let gesture = null;
    const render = distance => {
        indicator.style.height = `${distance}px`;
        const ready = distance >= GRID_REFRESH_TRIGGER / 2;
        indicator.classList.toggle('is-ready', ready);
        const label = indicator.querySelector('span');
        if (label) label.textContent = ready ? t('grid.releaseToRefresh') : t('grid.pullToRefresh');
    };
    list.addEventListener('touchstart', event => {
        gesture = event.touches.length === 1 && list.scrollTop <= 0
            ? { startX: event.touches[0].clientX, startY: event.touches[0].clientY, axis: null, deltaY: 0 } : null;
    }, { passive: true });
    list.addEventListener('touchmove', event => {
        if (!gesture) return;
        const deltaX = event.touches[0].clientX - gesture.startX;
        const deltaY = event.touches[0].clientY - gesture.startY;
        if (!gesture.axis) {
            if (Math.hypot(deltaX, deltaY) < GESTURE_LOCK_DISTANCE * 1.5) return;
            gesture.axis = deltaY > 0 && Math.abs(deltaY) > Math.abs(deltaX) * 1.5 ? 'down' : 'other';
        }
        if (gesture.axis !== 'down' || list.scrollTop > 0) return;
        gesture.deltaY = Math.max(0, deltaY);
        render(Math.min(GRID_REFRESH_MAX, gesture.deltaY * 0.5));
    }, { passive: true });
    const finish = cancelled => {
        const finished = gesture;
        gesture = null;
        if (finished?.axis !== 'down') return;
        render(0);
        if (!cancelled && finished.deltaY >= GRID_REFRESH_TRIGGER) {
            hapticTick();
            reloadView('chatlist').catch(logBackgroundError('reloadView'));
        }
    };
    list.addEventListener('touchend', () => finish(false), { passive: true });
    list.addEventListener('touchcancel', () => finish(true), { passive: true });
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
            : t('common.keepPulling');
    };
    container.addEventListener('touchstart', event => {
        gesture = event.touches.length === 1 && state.activeChatPeerId && isAtBottom()
            ? { startY: event.touches[0].clientY, distance: 0 }
            : null;
    }, { passive: true });
    // "Unten" nur beim Aufsetzen pruefen: die wachsende Anzeige verkleinert den Verlauf, danach waere er
    // nicht mehr ganz unten, die Anzeige fiele auf 0 und waechse wieder (Flackern). Waehrend des Ziehens
    // bleibt der Verlauf deshalb unten angeheftet.
    container.addEventListener('touchmove', event => {
        if (!gesture) return;
        const pulled = gesture.startY - event.touches[0].clientY;
        const distance = pulled > 0 ? Math.min(PULL_REFRESH_MAX, pulled * 0.5) : 0;
        if (distance === gesture.distance) return;
        gesture.distance = distance;
        render(distance);
        container.scrollTop = container.scrollHeight;
    }, { passive: true });
    const finish = cancelled => {
        const finished = gesture;
        gesture = null;
        if (!finished) return;
        render(0);
        if (!cancelled && finished.distance >= PULL_REFRESH_TRIGGER) {
            hapticTick();
            runPullUpAction();
        }
    };
    container.addEventListener('touchend', () => finish(false), { passive: true });
    container.addEventListener('touchcancel', () => finish(true), { passive: true });
}

function initGestures() {
    const messages = document.getElementById('chat-messages');
    if (messages) {
        messages.addEventListener('pointerdown', handleMessagePointerDown);
        messages.addEventListener('pointermove', handleMessagePointerMove);
        messages.addEventListener('pointerup', event => finishMessageGesture(event, false));
        messages.addEventListener('pointercancel', event => finishMessageGesture(event, true));
        messages.addEventListener('click', event => {
            if (Date.now() < (messageGesture.suppressClickUntil || 0)) {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);
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
    attachSwipeRight(document.getElementById('app-menu'), { close: closeMenu });
    attachChatListPullRefresh();
    attachSwipeRight(document.getElementById('chat-input-bar'), {
        enabled: () => state.chatSwipeClose && Boolean(state.activeChatPeerId),
        render: renderChatSwipe,
        resetView: resetChatSwipe,
        close: leaveActiveChat
    });
    // Album-Ansicht: deutlich weiter ziehen, sonst ist eine 1x-Ansicht schnell aus Versehen vorbei.
    attachSwipeToClose(
        document.getElementById('media-modal-content'),
        document.querySelector('#media-modal > div'),
        closeMediaModal,
        { trigger: () => (state.albumViewer ? Math.max(ALBUM_SHEET_CLOSE_MIN, window.innerHeight * ALBUM_SHEET_CLOSE_SHARE) : SHEET_CLOSE_TRIGGER) }
    );
}
