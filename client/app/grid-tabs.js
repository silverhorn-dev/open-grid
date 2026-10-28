// ================= GRID: DREI BEREICHE =================
// Grid · Interaktionen · Matches (nur in "Entdecken"). Interaktionen = wer mein Profil angesehen hat
// (nur wenn der Besucher das teilt) und wer mir eine Flamme geschickt hat; alles nur lokal
// (`keys`/`interactions`), nichts davon geht an den Router. Matches: noch nicht angeschriebene oben,
// jede Zeile mit Knopf zum Chat.
const INTERACTIONS_RECORD_ID = 'interactions';
const MAX_INTERACTIONS = 200;
// Dieselbe Person mit derselben Art innerhalb von 10 Minuten zaehlt einmal (nur die Zeit wird neu).
const INTERACTION_MERGE_MS = 10 * 60 * 1000;
const GRID_VIEWS = ['grid', 'interactions', 'matches'];

async function loadInteractions() {
    const stored = await databaseRequest('keys', 'readonly', store => store.get(INTERACTIONS_RECORD_ID)).catch(() => null);
    const items = Array.isArray(stored?.items) ? stored.items.filter(item => typeof item?.peerId === 'string'
        && ['flame', 'view'].includes(item.kind) && Number.isFinite(item.at)) : [];
    state.interactions = { items: items.slice(0, MAX_INTERACTIONS), seenAt: Number(stored?.seenAt) || 0 };
    renderGridTabs();
}

function saveInteractions() {
    return putDatabaseRecord('keys', { id: INTERACTIONS_RECORD_ID, ...state.interactions })
        .catch(error => logDebug(`Could not store interactions: ${error.message}`));
}

async function recordInteraction(peerId, kind, at = Date.now()) {
    if (!peerId || peerId === state.myProfile?.id) return;
    const items = state.interactions.items.filter(item => !(item.peerId === peerId && item.kind === kind && at - item.at < INTERACTION_MERGE_MS));
    items.unshift({ peerId, kind, at });
    state.interactions = { ...state.interactions, items: items.slice(0, MAX_INTERACTIONS) };
    // Gerade offen: gilt als gesehen.
    if (state.gridView === 'interactions' && isGridVisible()) state.interactions.seenAt = at;
    await saveInteractions();
    renderGridTabs();
}

function isGridVisible() {
    return !document.getElementById('view-grid')?.classList.contains('hidden');
}

// Interaktionen und Matches gibt es nur in "Entdecken" (Flammen, Profilbesuche).
function gridTabsAvailable() {
    return scopeIncludes('discovery') && !isSocialMode();
}

function unseenInteractionCount() {
    return state.interactions.items.filter(item => item.at > state.interactions.seenAt && !isPeerBlocked(item.peerId)).length;
}

function matchedPeerIds() {
    return Object.keys(state.matchState || {}).filter(peerId => isMatched(peerId) && !isPeerBlocked(peerId));
}

async function setGridView(view) {
    state.gridView = GRID_VIEWS.includes(view) ? view : 'grid';
    if (state.gridView === 'interactions' && state.interactions.items.length) {
        state.interactions = { ...state.interactions, seenAt: Date.now() };
        await saveInteractions();
    }
    renderGridTabs();
}

function renderGridTabs() {
    const bar = document.getElementById('grid-tabs');
    if (!bar) return;
    const available = gridTabsAvailable();
    if (!available) state.gridView = 'grid';
    bar.classList.toggle('hidden', !available);
    bar.querySelectorAll('[data-grid-view]').forEach(button => {
        const active = button.dataset.gridView === state.gridView;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
    });
    const badge = document.getElementById('grid-interactions-badge');
    if (badge) {
        const unseen = unseenInteractionCount();
        badge.classList.toggle('hidden', !unseen || state.gridView === 'interactions');
        badge.textContent = formatUnreadCount(unseen);
    }
    const view = state.gridView;
    document.getElementById('grid-container')?.classList.toggle('hidden', view !== 'grid');
    document.getElementById('grid-more-row')?.classList.toggle('hidden', view !== 'grid');
    const interactions = document.getElementById('grid-interactions');
    const matches = document.getElementById('grid-matches');
    interactions?.classList.toggle('hidden', view !== 'interactions');
    matches?.classList.toggle('hidden', view !== 'matches');
    if (view === 'interactions' && interactions) renderInteractionList(interactions);
    if (view === 'matches' && matches) renderMatchList(matches);
}

// Eine Zeile: Avatar, Name, Text, Zeit, optional ein Knopf rechts.
function createGridListRow(peerId, text, at, action = null) {
    const peer = getPeerPresentation(peerId) || { name: HIDDEN_PEER_NAME };
    const row = document.createElement('div');
    row.className = 'grid-list-row';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'grid-list-open';
    open.onclick = () => openProfileModal(peerId);
    const avatar = document.createElement('img');
    avatar.src = localAvatar(peer.avatar);
    avatar.alt = '';
    avatar.className = 'w-11 h-11 rounded-full object-cover border border-slate-700 shrink-0';
    const details = document.createElement('span');
    details.className = 'min-w-0 flex-1';
    const name = document.createElement('span');
    name.className = 'block text-sm font-semibold text-slate-100 truncate';
    name.textContent = peer.name || HIDDEN_PEER_NAME;
    const line = document.createElement('span');
    line.className = 'block text-xs text-slate-400 truncate';
    line.textContent = at ? `${text} · ${formatChatListTime(at)}` : text;
    details.append(name, line);
    open.append(avatar, details);
    row.appendChild(open);
    if (action) row.appendChild(action);
    return row;
}

function gridListButton(icon, label, onClick, primary = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `grid-list-action${primary ? ' is-primary' : ''}`;
    button.innerHTML = `<i class="${icon}"></i>`;
    button.append(` ${label}`);
    button.onclick = event => {
        event.stopPropagation();
        onClick();
    };
    return button;
}

function renderInteractionList(container) {
    container.innerHTML = '';
    const items = state.interactions.items.filter(item => !isPeerBlocked(item.peerId));
    if (!items.length) {
        container.appendChild(createEmptyState({ icon: 'fa-eye', text: t('grid.noInteractionsYet') }));
        return;
    }
    items.forEach(item => {
        const text = item.kind === 'view' ? t('grid.viewedYourProfile') : t('grid.sentYouAFlame');
        // Flamme zurueck: nur ohne Match und ohne laufende Sperre.
        const canFlame = !isMatched(item.peerId) && !hasSentFlame(item.peerId) && flameCooldownLeft(item.peerId) === 0;
        const action = isMatched(item.peerId)
            ? gridListButton('fa-solid fa-comment', t('grid.write'), () => openMatchChat(item.peerId), true)
            : canFlame ? gridListButton('fa-solid fa-fire', t('grid.flameBack'), () => sendFlame(item.peerId).then(renderGridTabs)) : null;
        container.appendChild(createGridListRow(item.peerId, text, item.at, action));
    });
}

function renderMatchList(container) {
    container.innerHTML = '';
    const matched = matchedPeerIds();
    if (!matched.length) {
        container.appendChild(createEmptyState({ icon: 'fa-fire', text: t('grid.noMatchesYet') }));
        return;
    }
    const written = peerId => Boolean(state.chatPreviews[peerId]);
    const matchedAt = peerId => {
        const entry = getMatchEntry(peerId);
        return Math.max(entry.sentAt || 0, entry.receivedAt || 0);
    };
    // Noch nicht angeschriebene zuerst, sonst neueste Matches oben.
    matched.sort((left, right) => Number(written(left)) - Number(written(right)) || matchedAt(right) - matchedAt(left));
    matched.forEach(peerId => {
        const text = written(peerId) ? t('common.match') : t('grid.notWrittenYet');
        const action = gridListButton('fa-solid fa-comment', t('grid.write'), () => openMatchChat(peerId), !written(peerId));
        container.appendChild(createGridListRow(peerId, text, matchedAt(peerId), action));
    });
}

async function openMatchChat(peerId) {
    switchTab('chat');
    await openChatWithPeer(peerId);
}
