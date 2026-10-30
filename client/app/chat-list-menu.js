// ================= CHATLISTE: MENUE UND VERSCHOBENE CHATS =================
// Jede Zeile der Chatliste hat rechts ein Menue (⋮), auch per langem Druecken oder Rechtsklick.
// Wird aus einem Match eine Freundschaft, wandert der Chat nach "Chat & Freunde". In "Grid & Event"
// bleibt ein Verweis stehen ("Jetzt in Chat & Freunde"), der dorthin fuehrt und sich entfernen laesst.
// Nur Anzeige auf diesem Geraet, das Gegenueber merkt nichts.
const MOVED_CHATS_RECORD_ID = 'moved-chats';

async function loadMovedChats() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(MOVED_CHATS_RECORD_ID)).catch(() => null);
    state.movedChats = stored?.peers && typeof stored.peers === 'object' ? { ...stored.peers } : {};
}

async function saveMovedChats() {
    await putDatabaseRecord('keys', { id: MOVED_CHATS_RECORD_ID, peers: state.movedChats })
        .catch(error => logDebug(`Could not store moved chats: ${error.message}`));
}

// Aus applyFriendOperation: der Chat stand in "Grid & Event" und gehoert jetzt zu "Chat & Freunde".
async function markChatMoved(peerId) {
    state.movedChats = { ...state.movedChats, [peerId]: Date.now() };
    await saveMovedChats();
}

async function dismissMovedChat(peerId) {
    if (!state.movedChats?.[peerId]) return;
    const { [peerId]: _removed, ...rest } = state.movedChats;
    state.movedChats = rest;
    await saveMovedChats();
    renderActivePeerList();
}

// Verweis zeigen: Freundschaft besteht noch, die Grid-Liste ist offen und der Bereich ist an.
function isMovedChatHint(peerId) {
    return Boolean(state.movedChats?.[peerId]) && isFriend(peerId) && currentChatScope() === 'discovery' && scopeIncludes('social');
}

// Zum Chat in "Chat & Freunde": Liste (oder Modus, je nach Listen-Wechsel-Einstellung) wechseln, dann oeffnen.
async function openMovedChat(peerId) {
    if (state.listSwitchSettings?.behavior === 'mode') {
        const mode = modeForChatScope('social');
        if (mode) await setAppMode(mode);
    } else {
        state.chatListScopeOverride = modeChatScope() === 'social' ? null : 'social';
    }
    await openChatWithPeer(peerId);
}

// ----- Menue -----
function closeChatListMenu() {
    if (!state.chatListMenu) return;
    dismissModalEntry('chatlistmenu', hideChatListMenu);
}

function hideChatListMenu() {
    state.chatListMenu = null;
    document.getElementById('chat-list-menu')?.remove();
    document.getElementById('chat-list-menu-backdrop')?.remove();
    document.querySelectorAll('#active-peers-list .is-menu-target').forEach(row => row.classList.remove('is-menu-target'));
}

function runChatListMenuAction(action) {
    replaceModal(closeChatListMenu, () => {
        Promise.resolve(action()).catch(logBackgroundError('runChatListMenuAction'));
    });
}

function chatListMenuEntries(peerId) {
    if (isMovedChatHint(peerId)) {
        return [
            ['fa-solid fa-arrow-right', t('chatList.openInFriends'), () => openMovedChat(peerId)],
            ['fa-regular fa-user', t('common.profile'), () => openProfileModal(peerId)],
            ['fa-solid fa-xmark', t('chatList.removeFromList'), () => dismissMovedChat(peerId)]
        ];
    }
    const blocked = isPeerBlocked(peerId);
    return [
        ['fa-regular fa-comment', t('chatList.open'), () => openChatWithPeer(peerId)],
        ['fa-regular fa-user', t('common.profile'), () => openProfileModal(peerId)],
        ['fa-solid fa-trash', t('chat.deleteChat'), () => deleteActiveChat(peerId), true],
        [blocked ? 'fa-solid fa-unlock' : 'fa-solid fa-ban', blocked ? t('chatList.unblock') : t('chat.block'), () => toggleActivePeerBlock(peerId), true]
    ];
}

function openChatListMenu(peerId, anchor) {
    if (!peerId) return;
    if (state.chatListMenu?.peerId === peerId && document.getElementById('chat-list-menu')) return;
    if (state.chatListMenu) {
        hideChatListMenu();
        removeModalFromStack('chatlistmenu');
    }
    state.chatListMenu = { peerId };
    const backdrop = document.createElement('div');
    backdrop.id = 'chat-list-menu-backdrop';
    backdrop.className = 'message-menu-backdrop';
    // Wie beim Nachrichten-Menue: nur ein Tipp, der auf dem Hintergrund beginnt, schliesst (sonst ginge
    // das Menue nach dem langen Druecken beim Loslassen gleich wieder zu).
    backdrop.addEventListener('pointerdown', event => {
        event.preventDefault();
        backdrop.dataset.armed = 'true';
    });
    backdrop.onclick = () => {
        if (backdrop.dataset.armed === 'true') closeChatListMenu();
    };
    backdrop.oncontextmenu = event => {
        event.preventDefault();
        closeChatListMenu();
    };
    const menu = document.createElement('div');
    menu.id = 'chat-list-menu';
    menu.className = 'message-menu';
    menu.setAttribute('role', 'menu');
    menu.dataset.peerId = peerId;
    const list = document.createElement('div');
    list.className = 'message-menu-items';
    for (const [icon, label, action, danger] of chatListMenuEntries(peerId)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `message-menu-item${danger ? ' is-danger' : ''}`;
        button.setAttribute('role', 'menuitem');
        button.innerHTML = `<i class="${icon}"></i>`;
        const text = document.createElement('span');
        text.textContent = label;
        button.appendChild(text);
        button.onclick = event => {
            event.stopPropagation();
            runChatListMenuAction(action);
        };
        list.appendChild(button);
    }
    menu.appendChild(list);
    document.body.append(backdrop, menu);
    const row = anchor?.closest('.chat-list-row') || anchor;
    row?.classList.add('is-menu-target');
    positionChatListMenu(row);
    pushModalEntry('chatlistmenu', hideChatListMenu);
    menu.querySelector('button')?.focus({ preventScroll: true });
}

// Rechts unter der Zeile, wenn Platz ist, sonst darueber; immer ganz im Bild.
function positionChatListMenu(row) {
    const menu = document.getElementById('chat-list-menu');
    if (!menu) return;
    const margin = 8;
    const box = row?.getBoundingClientRect() || { right: window.innerWidth / 2, top: window.innerHeight / 2, bottom: window.innerHeight / 2 };
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(margin, box.right - width), window.innerWidth - width - margin);
    const below = box.bottom + 4;
    const top = below + height + margin <= window.innerHeight ? below : Math.max(margin, box.top - height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

// Menue-Knopf und langes Druecken fuer eine Zeile (grid.client.js renderActivePeerList).
function attachChatListMenu(row, rowButton, menuButton, peerId) {
    menuButton.onclick = event => {
        event.stopPropagation();
        openChatListMenu(peerId, row);
    };
    // Der Klick nach dem langen Druecken oeffnet den Chat nicht zusaetzlich.
    attachLongPress(rowButton, () => {
        hapticTick();
        openChatListMenu(peerId, row);
    }, { suppressClick: true });
    rowButton.addEventListener('contextmenu', event => {
        event.preventDefault();
        openChatListMenu(peerId, row);
    });
}
