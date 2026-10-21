async function refreshGrid() {
    const refreshed = await fetchPeersFromWorkerGrid();
    if (refreshed) showToast('Grid refreshed.', 'info');
}

function renderDiscoveryGrid() {
    const container = document.getElementById('grid-container');
    if (!container) return;

    const hiddenList = JSON.parse(localStorage.getItem('hiddenByPeers') || '[]');
    const visiblePeers = state.peers.filter(peer => !isPeerBlocked(peer.id) && !hiddenList.includes(peer.id));
    container.innerHTML = '';
    document.getElementById('grid-peer-count').textContent = `${visiblePeers.length} ${visiblePeers.length === 1 ? 'peer' : 'peers'}`;
    renderActivePeerList();

    if (visiblePeers.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'col-span-full text-center py-12 text-slate-500 text-sm border border-dashed border-slate-800 rounded-2xl bg-slate-900/40';
        emptyState.innerHTML = '<i class="fa-solid fa-satellite-dish text-2xl text-slate-600 mb-3"></i><div>No other peers are currently visible in this grid cell.</div>';
        container.appendChild(emptyState);
        return;
    }

    visiblePeers.forEach(peer => {
        const avatarSrc = peer.avatar ? peer.avatar : 'https://placehold.co/300x300/1e293b/ffffff?text=Peer';
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'text-left bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden cursor-pointer hover:border-brand-500/60 hover:-translate-y-0.5 transition group shadow-lg focus:outline-none focus:ring-2 focus:ring-brand-500';
        card.onclick = () => openProfileModal(peer.id);

        const imageWrapper = document.createElement('div');
        imageWrapper.className = 'relative aspect-[4/5] bg-slate-950 overflow-hidden';
        const image = document.createElement('img');
        image.src = avatarSrc;
        image.alt = `${peer.name || 'Peer'} profile thumbnail`;
        image.className = 'w-full h-full object-cover group-hover:scale-105 transition duration-500';
        imageWrapper.appendChild(image);

        const footer = document.createElement('div');
        footer.className = 'p-3 flex items-center justify-between gap-2';
        const identity = document.createElement('div');
        identity.className = 'min-w-0';
        const name = document.createElement('div');
        name.className = 'font-semibold text-sm text-slate-100 truncate';
        name.textContent = peer.name || 'Peer';
        const id = document.createElement('div');
        id.className = 'text-[10px] font-mono text-slate-500 truncate';
        id.textContent = peer.id;
        identity.append(name, id);
        footer.appendChild(identity);

        const arrow = document.createElement('i');
        arrow.className = 'fa-solid fa-chevron-right text-xs text-slate-600 group-hover:text-brand-400 transition';
        footer.appendChild(arrow);
        card.append(imageWrapper, footer);
        container.appendChild(card);
    });
}

function renderActivePeerList() {
    const container = document.getElementById('active-peers-list');
    const count = document.getElementById('active-peers-count');
    if (!container || !count) return;

    const hiddenList = JSON.parse(localStorage.getItem('hiddenByPeers') || '[]');
    // Zeige korrekte DB-geladene Peers an.
    // Fuege den aktiven Peer temporaer hinzu, falls der Chat gerade erst ueber das Grid gestartet wurde.
    const activeSet = new Set(state.chatPeerIds);
    if (state.activeChatPeerId) activeSet.add(state.activeChatPeerId);
    const peerIds = Array.from(activeSet).filter(peerId => !isPeerBlocked(peerId) && !hiddenList.includes(peerId));

    count.textContent = peerIds.length;
    container.innerHTML = '';
    peerIds.forEach(peerId => {
        const peer = getPeerPresentation(peerId);
        const blocked = isPeerBlocked(peer.id);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `w-full flex items-center gap-3 rounded-xl border p-2 text-left transition ${state.activeChatPeerId === peer.id ? 'border-brand-500/60 bg-brand-500/10' : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'}`;
        button.onclick = () => openChatWithPeer(peer.id);

        const image = document.createElement('img');
        image.src = peer.avatar || 'https://placehold.co/80x80/1e293b/ffffff?text=P';
        image.alt = '';
        image.className = 'w-10 h-10 rounded-full object-cover border border-slate-700';
        const details = document.createElement('div');
        details.className = 'min-w-0 flex-1';
        const name = document.createElement('div');
        name.className = 'text-xs font-semibold text-slate-200 truncate';
        name.textContent = peer.name || 'Peer';
        const status = document.createElement('div');
        status.className = 'text-[10px] font-mono text-slate-400';
        status.textContent = blocked
            ? 'Blocked'
            : state.dataChannels[peer.id]?.readyState === 'open'
            ? 'P2P connected'
            : state.peers.some(candidate => candidate.id === peer.id)
                ? 'Router entry'
                : 'Offline chat';
        details.append(name, status);
        button.append(image, details);
        container.appendChild(button);
    });
}

async function fetchPeersFromWorkerGrid() {
    if (state.gridFetchInFlight) return false;
    state.gridFetchInFlight = true;
    const refreshButton = document.getElementById('refresh-grid-btn');
    const refreshIcon = document.getElementById('refresh-grid-icon');
    if (refreshButton) refreshButton.disabled = true;
    if (refreshIcon) refreshIcon.classList.add('fa-spin');

    try {
        const res = await fetch(`${API_BASE}/api/grid?geohash=${encodeURIComponent(state.myProfile.geohash)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('Worker offline');
        const data = await res.json();

        if (data.peers && Array.isArray(data.peers)) {
            const removedPeerIds = new Set(
                (data.removedPeerIds || []).filter(peerId => peerId !== state.myProfile.id)
            );
            await Promise.all(Array.from(removedPeerIds, peerId => removeCachedPeer(peerId, state.myProfile.geohash)));
            state.peers = data.peers
                .filter(peer => peer.id !== state.myProfile.id && !removedPeerIds.has(peer.id))
                .map(peer => {
                    const cachedProfile = state.cachedProfiles[peer.id];
                    return {
                        ...peer,
                        name: cachedProfile?.fields?.displayName || peer.name,
                        avatar: cachedProfile?.avatar || peer.thumbnail || peer.avatar,
                        fullProfile: cachedProfile || null
                    };
                });
            await Promise.all(state.peers.map(cacheGridPeer));
            retryVisiblePeerConnections();
            renderDiscoveryGrid();
            document.getElementById('grid-last-updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
            return true;
        }
    } catch (err) {
        logDebug(`Grid sync failed: ${err.message}`);
        document.getElementById('grid-last-updated').textContent = 'Refresh failed';
        return false;
    } finally {
        state.gridFetchInFlight = false;
        if (refreshButton) refreshButton.disabled = false;
        if (refreshIcon) refreshIcon.classList.remove('fa-spin');
    }
    return false;
}

function connectWorkerWebSocket() {
    try {
        state.ws = new WebSocket(WS_URL);
        state.ws.onopen = async () => {
            logDebug('Connected to Worker Signaling');
            state.ws.send(JSON.stringify({ type: 'REGISTER_SOCKET', peerId: state.myProfile.id }));
            await registerWithWorkerGrid();
            await fetchPeersFromWorkerGrid();
        };
        state.ws.onmessage = async (event) => {
            try {
                await handleSignalingMessage(JSON.parse(event.data));
            } catch (error) {
                logDebug(`Signaling message failed: ${error.message}`);
            }
        };
        state.ws.onerror = () => {
            document.getElementById('network-indicator').className = 'w-2.5 h-2.5 rounded-full bg-red-500';
            document.getElementById('network-status-text').textContent = 'Signaling error';
        };
        state.ws.onclose = () => {
            document.getElementById('network-indicator').className = 'w-2.5 h-2.5 rounded-full bg-red-500';
            document.getElementById('network-status-text').textContent = 'Reconnecting';
            if (state.shouldReconnect) setTimeout(connectWorkerWebSocket, 5000);
        };
    } catch (error) {
        logDebug(`Could not initialize signaling: ${error.message}`);
    }
}

async function registerWithWorkerGrid() {
    try {
        const response = await fetch(`${API_BASE}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                peerId: state.myProfile.id,
                registrationId: state.registrationId,
                geohash: state.myProfile.geohash,
                thumbnail: state.myProfile.avatar,
                name: state.myProfile.fields.displayName || 'Peer'
            })
        });
        if (!response.ok) throw new Error(`Registration failed with status ${response.status}`);
        logDebug('Registered in Worker Spatial Grid');
    } catch (error) {
        logDebug(`Grid registration failed: ${error.message}`);
    }
}

async function gracefulUnregister() {
    try {
        logDebug('Initiating graceful unregister from router...');
        state.shouldReconnect = false;
        const query = new URLSearchParams({
            peerId: state.myProfile.id,
            registrationId: state.registrationId,
            geohash: state.myProfile.geohash
        });
        const response = await fetch(`${API_BASE}/api/register?${query}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error(`Unregister failed with status ${response.status}`);
        if (state.ws) state.ws.close();
        showToast('Erfolgreich vom Routing-Server abgemeldet.', 'success');
        document.getElementById('network-indicator').className = 'w-2.5 h-2.5 rounded-full bg-red-500';
        document.getElementById('network-status-text').textContent = 'Abgemeldet';
    } catch (error) {
        showToast('Abmeldung fehlgeschlagen.', 'error');
    }
}
