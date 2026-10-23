// Serverzeit und Schluessel-Epoche; kurz gecacht, die Geraetezeit dient nur zum Fortschreiben.
async function fetchServerTime() {
    const cached = state.serverTime;
    if (cached && performance.now() - cached.fetchedAt < 60000) {
        const now = cached.now + (performance.now() - cached.fetchedAt);
        const epoch = Math.floor(now / cached.epochMs);
        return { now, epoch, epochMs: cached.epochMs, epochEndsAt: (epoch + 1) * cached.epochMs };
    }
    const response = await fetch(`${API_BASE}/api/time`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Time API returned ${response.status}`);
    const time = await response.json();
    state.serverTime = { ...time, fetchedAt: performance.now() };
    return time;
}

async function loadMoreGrid() {
    if (state.gridRing >= MAX_GRID_RING) return;
    state.gridRing += 1;
    const loaded = await fetchPeersFromWorkerGrid();
    if (!loaded) state.gridRing -= 1;
}

async function refreshGrid() {
    const refreshed = await fetchPeersFromWorkerGrid();
    if (refreshed) showToast('Grid aktualisiert.', 'info');
}

function renderDiscoveryGrid() {
    const container = document.getElementById('grid-container');
    if (!container) return;

    const hiddenList = JSON.parse(localStorage.getItem('hiddenByPeers') || '[]');
    const visiblePeers = state.peers.filter(peer => !isPeerBlocked(peer.id) && !hiddenList.includes(peer.id));
    container.innerHTML = '';
    document.getElementById('grid-peer-count').textContent = `${visiblePeers.length} ${visiblePeers.length === 1 ? 'peer' : 'peers'}`;
    const geohashLabel = document.getElementById('current-geohash');
    if (geohashLabel) geohashLabel.textContent = `${state.myProfile.geohash} · Ring ${state.gridRing}`;
    document.getElementById('grid-load-more-btn')?.classList.toggle('hidden', !state.gridHasMore);
    renderActivePeerList();

    if (visiblePeers.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'col-span-full text-center py-12 text-slate-500 text-sm border border-dashed border-slate-800 rounded-2xl bg-slate-900/40';
        emptyState.innerHTML = '<i class="fa-solid fa-satellite-dish text-2xl text-slate-600 mb-3"></i><div>No other peers are currently visible in this grid cell.</div>';
        container.appendChild(emptyState);
        return;
    }

    let currentBucket = null;
    visiblePeers.forEach(peer => {
        // Der Router liefert die Peers bereits nach Entfernung sortiert.
        if (peer.distanceBucket && peer.distanceBucket !== currentBucket) {
            currentBucket = peer.distanceBucket;
            const heading = document.createElement('h3');
            heading.className = 'col-span-full text-xs font-bold uppercase tracking-wider text-slate-400 pt-2';
            heading.textContent = DISTANCE_BUCKET_LABELS[currentBucket] || currentBucket;
            container.appendChild(heading);
        }
        const avatarSrc = localAvatar(peer.avatar);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'text-left bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden cursor-pointer hover:border-brand-500/60 hover:-translate-y-0.5 transition group shadow-lg focus:outline-none focus:ring-2 focus:ring-brand-500';
        card.onclick = () => openProfileModal(peer.id);

        const imageWrapper = document.createElement('div');
        imageWrapper.className = 'relative aspect-[4/5] bg-slate-950 overflow-hidden';
        if (!peer.avatar && !peer.name) {
            // Sichtbarkeitsstufe 3: Silhouette ohne Namen.
            imageWrapper.classList.add('flex', 'items-center', 'justify-center', 'text-slate-700');
            imageWrapper.innerHTML = '<i class="fa-solid fa-user-secret text-6xl"></i>';
        } else {
            const image = document.createElement('img');
            image.src = avatarSrc;
            image.alt = `${peer.name || 'Peer'} profile thumbnail`;
            image.className = 'w-full h-full object-cover group-hover:scale-105 transition duration-500';
            imageWrapper.appendChild(image);
        }
        if (isMatched(peer.id) || hasReceivedFlame(peer.id)) {
            const flame = document.createElement('span');
            flame.className = `absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center text-sm ${isMatched(peer.id) ? 'bg-orange-500 text-white' : 'bg-black/60 text-orange-300'}`;
            flame.title = isMatched(peer.id) ? 'Match' : 'Hat dir eine Flamme geschickt';
            flame.innerHTML = '<i class="fa-solid fa-fire"></i>';
            imageWrapper.appendChild(flame);
        }

        const footer = document.createElement('div');
        footer.className = 'p-3 flex items-center justify-between gap-2';
        const identity = document.createElement('div');
        identity.className = 'min-w-0';
        const name = document.createElement('div');
        name.className = 'font-semibold text-sm text-slate-100 truncate';
        name.textContent = peer.name || HIDDEN_PEER_NAME;
        const id = document.createElement('div');
        id.className = 'debug-only text-[10px] font-mono text-slate-500 truncate';
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

        const avatar = document.createElement('div');
        avatar.className = 'relative shrink-0';
        const image = document.createElement('img');
        image.src = localAvatar(peer.avatar);
        image.alt = '';
        image.className = 'w-10 h-10 rounded-full object-cover border border-slate-700';
        avatar.appendChild(image);
        if (!blocked && isPeerOnline(peer.id)) {
            const dot = document.createElement('span');
            dot.className = 'absolute bottom-0 right-0 w-3 h-3 rounded-full bg-emerald-400 border-2 border-slate-900';
            dot.title = 'Online';
            avatar.appendChild(dot);
        }
        const details = document.createElement('div');
        details.className = 'min-w-0 flex-1';
        const name = document.createElement('div');
        name.className = 'text-xs font-semibold text-slate-200 truncate';
        name.textContent = peer.name || HIDDEN_PEER_NAME;
        if (isMatched(peer.id) || hasReceivedFlame(peer.id)) {
            const flame = document.createElement('i');
            flame.className = `fa-solid fa-fire ml-1.5 ${isMatched(peer.id) ? 'text-orange-400' : 'text-orange-300/60'}`;
            flame.title = isMatched(peer.id) ? 'Match' : 'Hat dir eine Flamme geschickt';
            name.appendChild(flame);
        }
        const status = document.createElement('div');
        status.className = 'debug-only text-[10px] font-mono text-slate-400';
        status.textContent = blocked
            ? 'Blocked'
            : state.dataChannels[peer.id]?.readyState === 'open'
            ? 'P2P connected'
            : state.peerPresence[peer.id]
                ? 'Online (presence)'
                : state.peers.some(candidate => candidate.id === peer.id)
                    ? 'Router entry'
                    : 'Offline';
        details.append(name, status);
        button.append(avatar, details);
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
        const query = new URLSearchParams({ geohash: state.myProfile.geohash, ring: String(state.gridRing) });
        if (state.gridSettings.liveGrid) query.set('live', '1');
        const res = await fetch(`${API_BASE}/api/grid?${query}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('Worker offline');
        const data = await res.json();

        if (data.peers && Array.isArray(data.peers)) {
            const removedPeerIds = new Set(
                (data.removedPeerIds || []).filter(peerId => peerId !== state.myProfile.id)
            );
            await Promise.all(Array.from(removedPeerIds, peerId => removeCachedPeer(peerId, state.myProfile.geohash)));
            state.gridHasMore = data.hasMore === true;
            state.peers = data.peers
                .filter(peer => peer.id !== state.myProfile.id && !removedPeerIds.has(peer.id))
                .map(peer => {
                    const cachedProfile = state.cachedProfiles[peer.id];
                    return {
                        ...peer,
                        // Lokaler Cache-Schluessel ist die eigene Zelle; der Router liefert keine Peer-Standorte.
                        geohash: state.myProfile.geohash,
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
            updateConnectivityBanner();
            const registered = await registerWithWorkerGrid();
            if (!registered) {
                document.getElementById('network-status-text').textContent = 'Registration failed';
                state.ws.close();
                return;
            }
            state.ws.send(JSON.stringify({
                type: 'REGISTER_SOCKET',
                peerId: state.myProfile.id,
                authToken: state.routerAuthToken
            }));
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
            updateConnectivityBanner();
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
        if (!state.myKeys) throw new Error('Identity keys are not ready');
        const sharedToken = window.localStorage.getItem('opengrid-router-auth-token');
        if (sharedToken) state.routerAuthToken = sharedToken;
        if (!state.routerAuthToken) {
            const tokenBytes = window.crypto.getRandomValues(new Uint8Array(32));
            state.routerAuthToken = bytesToBase64(tokenBytes);
        }
        const proofPayload = JSON.stringify({
            peerId: state.myProfile.id,
            registrationId: state.registrationId,
            authToken: state.routerAuthToken
        });
        const proofSignature = await window.crypto.subtle.sign(
            {name: 'ECDSA', hash: {name: 'SHA-256'}},
            state.myKeys.ecdsaKeyPair.privateKey,
            new TextEncoder().encode(proofPayload)
        );
        const response = await fetch(`${API_BASE}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                peerId: state.myProfile.id,
                registrationId: state.registrationId,
                geohash: state.myProfile.geohash,
                // Sichtbarkeitsstufe 3: der Router bekommt weder Namen noch Vorschaubild.
                ...getRegistrationIdentity(),
                authToken: state.routerAuthToken,
                silent: isEffectivelySilent(),
                ttlMinutes: state.gridSettings.ttlMinutes,
                registrationProof: {
                    publicKey: state.myKeys.jwkEcdsaPublic,
                    signature: bytesToBase64(new Uint8Array(proofSignature))
                }
            })
        });
        if (!response.ok) {
            const problem = await response.json().catch(() => null);
            throw new Error(`Registration failed with status ${response.status}: ${problem?.error || 'Unknown error'}`);
        }
        const registration = await response.json();
        state.routerAuthToken = registration.authToken;
        window.localStorage.setItem('opengrid-router-auth-token', registration.authToken);
        onRouterAuthUpdated();
        logDebug('Registered in Worker Spatial Grid');
        return true;
    } catch (error) {
        logDebug(`Grid registration failed: ${error.message}`);
        return false;
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
            method: 'DELETE',
            headers: peerAuthHeaders()
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
