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

// Naechster Ring mit neuen Peers laut Router (leere Ringe uebersprungen), sonst der folgende.
function nextGridRing() {
    const next = Number(state.gridNextRing);
    return Number.isInteger(next) && next > state.gridRing ? next : state.gridRing + 1;
}

async function loadMoreGrid() {
    if (state.appMode !== 'discovery' || state.gridRing >= MAX_GRID_RING) return;
    const previous = state.gridRing;
    state.gridRing = Math.min(MAX_GRID_RING, nextGridRing());
    const loaded = await fetchGridRing();
    if (!loaded) state.gridRing = previous;
}

// Knopf am PC: nur die Daten (ohne Hinweis, der stapelte sich beim wiederholten Ziehen).
async function refreshGrid() {
    await fetchPeersFromWorkerGrid();
}

function renderDiscoveryGrid() {
    const container = document.getElementById('grid-container');
    if (!container) return;

    const hiddenList = JSON.parse(localStorage.getItem('hiddenByPeers') || '[]');
    const listedPeers = state.peers.filter(peer => !isPeerBlocked(peer.id) && !hiddenList.includes(peer.id));
    // Filter nur auf dem Geraet (grid-filter.js); die ersten Profile im Hintergrund holen.
    const discovery = gridTabsAvailable();
    // Sichtbarkeitsregeln der anderen (audience.js): Karten, die nicht fuer mich bestimmt sind, weglassen.
    const allowedPeers = discovery ? listedPeers.filter(peer => audienceAllows(peer.audience)) : listedPeers;
    const visiblePeers = discovery ? applyGridFilter(allowedPeers) : allowedPeers;
    if (discovery) prefetchGridProfiles(listedPeers);
    setProfileBrowseList(visiblePeers.map(peer => peer.id));
    const groupByDistance = !(discovery && profileFilterActive());
    container.innerHTML = '';
    document.getElementById('grid-peer-count').textContent = visiblePeers.length === 1 ? t('grid.1Person') : t('grid.people', { count: visiblePeers.length });
    // Mit Tabs steht die Zahl grau am Grid-Tab (grid-tabs.js), sonst in der Statuszeile.
    state.gridVisibleCount = visiblePeers.length;
    const geohashLabel = document.getElementById('current-geohash');
    if (geohashLabel) geohashLabel.textContent = t('grid.ring', { geohash: state.myProfile.geohash, gridRing: state.gridRing });
    renderGridMore();
    renderActivePeerList();
    renderGridTabs();

    if (visiblePeers.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'col-span-full';
        emptyState.appendChild(createEmptyState({
            icon: 'fa-satellite-dish',
            text: state.appMode === 'friends'
                ? t('grid.noneOfYourContactsIs')
                : state.appMode === 'event'
                    ? t('grid.nobodyElseInThisEvent')
                    : t('grid.nobodyNearYouIsVisible')
        }));
        container.appendChild(emptyState);
        return;
    }

    let currentBucket = null;
    visiblePeers.forEach(peer => {
        // Der Router liefert die Peers bereits nach Entfernung sortiert.
        if (groupByDistance && peer.distanceBucket && peer.distanceBucket !== currentBucket) {
            currentBucket = peer.distanceBucket;
            const heading = document.createElement('h3');
            heading.className = 'col-span-full text-xs font-bold uppercase tracking-wider text-slate-400 pt-2';
            heading.textContent = DISTANCE_BUCKET_LABELS[currentBucket] || currentBucket;
            container.appendChild(heading);
        }
        const avatarSrc = localAvatar(peer.avatar);
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'text-left bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden cursor-pointer hover:border-brand-500/60 hover:-translate-y-0.5 transition group shadow-lg focus:outline-hidden focus:ring-2 focus:ring-brand-500';
        card.onclick = () => openProfileModal(peer.id);

        const imageWrapper = document.createElement('div');
        imageWrapper.className = 'relative aspect-4/5 bg-slate-950 overflow-hidden';
        if (!peer.avatar && !peer.name) {
            // Sichtbarkeitsstufe 3: Silhouette ohne Namen.
            imageWrapper.classList.add('flex', 'items-center', 'justify-center', 'text-slate-700');
            imageWrapper.innerHTML = '<i class="fa-solid fa-user-secret text-6xl"></i>';
        } else {
            const image = document.createElement('img');
            image.src = avatarSrc;
            image.alt = t('grid.profilePictureOf', { name: peer.name || HIDDEN_PEER_NAME });
            image.className = 'w-full h-full object-cover group-hover:scale-105 transition duration-500';
            imageWrapper.appendChild(image);
        }
        // Match oder sichtbare Flammen (gestapelt: Doppelflamme, sonst Zahl), matching.js.
        const flame = flameIndicator(peer.id, `absolute top-2 right-2 h-7 min-w-7 px-1.5 rounded-full flex items-center justify-center text-sm ${isMatched(peer.id) ? 'bg-orange-500 text-white' : 'bg-black/60 text-orange-300'}`);
        if (flame) imageWrapper.appendChild(flame);

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

// Heute: Uhrzeit (immer 24 h), gestern: "Gestern", sonst Datum.
function formatChatListTime(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return formatClockTime(timestamp);
    if (date.toDateString() === yesterday.toDateString()) return t('grid.yesterday');
    return date.toLocaleDateString(i18nLocale(), { day: '2-digit', month: '2-digit' });
}

// Chats der aktuellen Liste (Grid & Event oder Chat & Freunde), neueste oben. Der aktive Chat bleibt
// drin, auch wenn er gerade erst ueber das Grid gestartet wurde. Auch fuer den Chat-Wechsel.
// includeMoved: auch die Verweise auf nach "Chat & Freunde" gewanderte Chats (nur die Liste selbst).
function visibleChatPeerIds({ includeMoved = false } = {}) {
    let hiddenList = [];
    try {
        hiddenList = JSON.parse(localStorage.getItem('hiddenByPeers') || '[]');
    } catch {
        hiddenList = [];
    }
    const activeSet = new Set(state.chatPeerIds);
    if (state.activeChatPeerId) activeSet.add(state.activeChatPeerId);
    return Array.from(activeSet)
        .filter(peerId => !isPeerBlocked(peerId) && !hiddenList.includes(peerId)
            && (peerId === state.activeChatPeerId || isInCurrentChatList(peerId)
                || (includeMoved && typeof isMovedChatHint === 'function' && isMovedChatHint(peerId))))
        .sort((left, right) => (state.chatPreviews[right]?.at || 0) - (state.chatPreviews[left]?.at || 0));
}

function renderActivePeerList() {
    const container = document.getElementById('active-peers-list');
    const count = document.getElementById('active-peers-count');
    if (!container || !count) return;

    const peerIds = visibleChatPeerIds({ includeMoved: true });

    count.textContent = peerIds.length;
    renderUnreadBadges();
    renderStatusBar();
    renderChatSwitcher();
    const scopeLabel = document.getElementById('chat-list-scope');
    if (scopeLabel) scopeLabel.textContent = currentChatScope() === 'social' ? t('grid.chatFriends') : t('grid.event');
    renderListSwitch();
    container.innerHTML = '';
    if (!peerIds.length) {
        const social = currentChatScope() === 'social';
        container.appendChild(createEmptyState({
            icon: 'fa-comments',
            title: t('grid.noChatsYet'),
            text: social ? t('grid.inviteSomeoneWithYourInvite') : t('grid.tapProfileInGridTo'),
            action: social ? { label: t('common.inviteContact'), icon: 'fa-user-plus', onClick: () => openInviteCard() } : null
        }));
    }
    peerIds.forEach(peerId => {
        const peer = getPeerPresentation(peerId);
        const blocked = isPeerBlocked(peer.id);
        // Verweis auf einen nach "Chat & Freunde" gewanderten Chat (chat-list-menu.js).
        const moved = peer.id !== state.activeChatPeerId && typeof isMovedChatHint === 'function' && isMovedChatHint(peer.id);
        const row = document.createElement('div');
        row.className = `chat-list-row flex items-stretch rounded-xl border transition ${state.activeChatPeerId === peer.id ? 'border-brand-500/60 bg-brand-500/10' : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'}${moved ? ' is-moved' : ''}`;
        row.dataset.peerId = peer.id;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chat-list-open min-w-0 flex-1 flex items-center gap-3 p-2 text-left';
        button.onclick = () => (moved ? openMovedChat(peer.id) : openChatWithPeer(peer.id));
        const menuButton = document.createElement('button');
        menuButton.type = 'button';
        menuButton.className = 'chat-list-menu-btn shrink-0 w-9 flex items-center justify-center text-slate-500 hover:text-slate-200';
        menuButton.title = t('chatList.menu');
        menuButton.setAttribute('aria-label', t('chatList.menu'));
        menuButton.setAttribute('aria-haspopup', 'menu');
        menuButton.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';

        const avatar = document.createElement('div');
        avatar.className = 'relative shrink-0';
        const image = document.createElement('img');
        image.src = localAvatar(peer.avatar);
        image.alt = '';
        image.className = 'w-10 h-10 rounded-full object-cover border border-slate-700';
        avatar.appendChild(image);
        const dot = blocked ? null : createPresenceDot(peer.id, 'absolute bottom-0 right-0 w-3 h-3');
        if (dot) avatar.appendChild(dot);
        const details = document.createElement('div');
        details.className = 'min-w-0 flex-1';
        const name = document.createElement('div');
        name.className = 'text-xs font-semibold text-slate-200 truncate';
        name.textContent = peer.name || HIDDEN_PEER_NAME;
        const socialList = currentChatScope() === 'social';
        if (socialList && (isFriend(peer.id) || hasFriendRequest(peer.id))) {
            const friend = document.createElement('i');
            friend.className = `fa-solid ${isFriend(peer.id) ? 'fa-user-check text-emerald-400' : 'fa-user-plus text-brand-400'} ml-1.5`;
            friend.title = isFriend(peer.id) ? t('grid.friends') : t('common.wantsToAddYou');
            name.appendChild(friend);
        } else if (!socialList) {
            const flame = flameIndicator(peer.id, `ml-1.5 ${isMatched(peer.id) ? 'text-orange-400' : 'text-orange-300/60'}`);
            if (flame) name.appendChild(flame);
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
        const preview = state.chatPreviews[peer.id];
        const previewLine = document.createElement('div');
        previewLine.className = 'flex items-center gap-2 text-[11px] text-slate-400';
        const previewText = document.createElement('span');
        previewText.className = 'truncate flex-1';
        const pendingNote = socialList
            ? (hasFriendRequest(peer.id) ? t('common.wantsToAddYou') : '')
            : (hasReceivedFlame(peer.id) ? t('common.sentYouFlame') : '');
        previewText.textContent = moved
            ? t('chatList.movedToFriends')
            : preview ? `${preview.mine ? t('common.you') : ''}${preview.text}` : pendingNote;
        if (moved) previewText.classList.add('text-brand-400');
        const unread = moved ? 0 : unreadCountOf(peer.id);
        if (unread) previewText.classList.add('font-semibold', 'text-slate-100');
        previewLine.appendChild(previewText);
        if (preview?.at && !moved) {
            const time = document.createElement('span');
            time.className = `shrink-0 ${unread ? 'text-brand-400 font-semibold' : 'text-slate-500'}`;
            time.textContent = formatChatListTime(preview.at);
            previewLine.appendChild(time);
        }
        if (unread) previewLine.appendChild(createUnreadBadge(unread, 'shrink-0'));
        // Kurzstatus in eigener Zeile, damit lange Namen ihn auf dem Smartphone nicht abschneiden.
        const presence = presenceTextOf(peer.id);
        const presenceLine = document.createElement('div');
        presenceLine.className = presence ? 'text-[11px] text-brand-400 truncate' : 'hidden';
        presenceLine.textContent = presence;
        details.append(name, presenceLine, previewLine, status);
        button.append(avatar, details);
        row.append(button, menuButton);
        if (typeof attachChatListMenu === 'function') attachChatListMenu(row, button, menuButton, peer.id);
        container.appendChild(row);
    });
}

// Wenig los in der Naehe: naechste Ringe automatisch laden, hoechstens bis Ring 3 und nur,
// solange der Router weitere Peers meldet (hasMore). Ohne Peers gibt es so keine Schleife.
const GRID_AUTO_EXPAND_MIN_PEERS = 6;
const MAX_AUTO_GRID_RING = 3;

// `ring` = der Ring, der als naechstes geladen wuerde (nextRing vom Router).
function shouldAutoExpandGrid({ appMode, hasMore, peerCount, ring }) {
    return appMode === 'discovery' && hasMore && peerCount < GRID_AUTO_EXPAND_MIN_PEERS && ring <= MAX_AUTO_GRID_RING;
}

// Unter dem Grid: "Mehr laden" (naechster Ring mit neuen Leuten) oder der Hinweis, dass alles in
// Reichweite geladen ist. Nur in "Entdecken".
function renderGridMore() {
    const discovery = state.appMode === 'discovery';
    document.getElementById('grid-load-more-btn')?.classList.toggle('hidden', !discovery || !state.gridHasMore);
    document.getElementById('grid-all-loaded')?.classList.toggle('hidden', !discovery || state.gridHasMore || state.peers.length === 0);
}

async function fetchPeersFromWorkerGrid() {
    let loaded = await fetchGridRing();
    while (loaded && shouldAutoExpandGrid({
        appMode: state.appMode,
        hasMore: state.gridHasMore,
        peerCount: state.peers.length,
        ring: nextGridRing()
    })) {
        const previous = state.gridRing;
        state.gridRing = nextGridRing();
        loaded = await fetchGridRing();
        if (!loaded) state.gridRing = previous;
    }
    return loaded;
}

async function fetchGridRing() {
    if (state.gridFetchInFlight || !isGridAvailable()) return false;
    state.gridFetchInFlight = true;
    const refreshButton = document.getElementById('refresh-grid-btn');
    const refreshIcon = document.getElementById('refresh-grid-icon');
    if (refreshButton) refreshButton.disabled = true;
    if (refreshIcon) refreshIcon.classList.add('fa-spin');

    try {
        const query = buildGridQuery();
        const headers = state.appMode === 'friends' || isSafetyGateActive() ? peerAuthHeaders() : {};
        const res = await fetch(`${API_BASE}/api/grid?${query}`, { cache: 'no-store', headers });
        if (res.status === 403 && isSafetyGateActive()) {
            const problem = await res.json().catch(() => null);
            handleVerificationRequired(problem?.verificationRequired);
            return false;
        }
        if (!res.ok) throw new Error('Worker offline');
        const data = await res.json();

        if (data.peers && Array.isArray(data.peers)) {
            const removedPeerIds = new Set(
                (data.removedPeerIds || []).filter(peerId => peerId !== state.myProfile.id)
            );
            await Promise.all(Array.from(removedPeerIds, peerId => removeCachedPeer(peerId, state.myProfile.geohash)));
            state.gridHasMore = data.hasMore === true;
            state.gridNextRing = Number.isInteger(data.nextRing) ? data.nextRing : null;
            state.peers = data.peers
                .filter(peer => peer.id !== state.myProfile.id && !removedPeerIds.has(peer.id))
                // Freunde-Modus: das Grid ist ein Adressbuch nur mit Freunden.
                .filter(peer => state.appMode !== 'friends' || isFriend(peer.id))
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
            document.getElementById('grid-last-updated').textContent = t('grid.updated', { time: formatClockTime(Date.now()) });
            return true;
        }
    } catch (err) {
        logDebug(`Grid sync failed: ${err.message}`);
        document.getElementById('grid-last-updated').textContent = t('grid.refreshFailed');
        return false;
    } finally {
        state.gridFetchInFlight = false;
        if (refreshButton) refreshButton.disabled = false;
        if (refreshIcon) refreshIcon.classList.remove('fa-spin');
    }
    return false;
}

// ----- Signaling-Heartbeat -----
// Ein WebSocket kann "halb offen" sein (Smartphone im Hintergrund, WLAN-Wechsel): readyState bleibt
// OPEN, aber nichts kommt mehr an. Daher regelmaessig und beim Zurueckkehren in die App ein PING;
// kommt kein PONG, wird die Verbindung neu aufgebaut.
const WS_PING_INTERVAL_MS = 25000;
const WS_PONG_TIMEOUT_MS = 5000;

function checkSignalingHealth(reason) {
    const ws = state.ws;
    if (!state.shouldReconnect) return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        reconnectSignaling(reason);
        return;
    }
    if (ws.readyState !== WebSocket.OPEN || state.wsPingTimer) return;
    const nonce = window.crypto.randomUUID();
    state.wsPingNonce = nonce;
    try {
        ws.send(JSON.stringify({ type: 'PING', nonce }));
    } catch {
        reconnectSignaling(reason);
        return;
    }
    state.wsPingTimer = setTimeout(() => {
        state.wsPingTimer = null;
        logDebug(`Signaling antwortet nicht (${reason}), baue die Verbindung neu auf.`);
        reconnectSignaling(reason);
    }, WS_PONG_TIMEOUT_MS);
}

function handleSignalingPong(message) {
    if (message.nonce !== state.wsPingNonce) return;
    clearTimeout(state.wsPingTimer);
    state.wsPingTimer = null;
}

// Alten Socket ohne Reconnect-Timer schliessen und sofort neu verbinden.
function reconnectSignaling(reason) {
    clearTimeout(state.wsPingTimer);
    state.wsPingTimer = null;
    const old = state.ws;
    if (old) {
        old.onopen = old.onmessage = old.onerror = old.onclose = null;
        try {
            old.close();
        } catch {
            // Schon zu.
        }
    }
    state.ws = null;
    logDebug(`Signaling: neue Verbindung (${reason}).`);
    updateConnectivityIndicator();
    connectWorkerWebSocket();
}

function connectWorkerWebSocket() {
    try {
        state.ws = new WebSocket(WS_URL);
        state.ws.onopen = async () => {
            state.wsOpenedAt = Date.now();
            logDebug('Connected to Worker Signaling');
            updateConnectivityIndicator();
            const registered = await registerWithWorkerGrid();
            if (!registered) {
                document.getElementById('network-status-text').textContent = t('grid.registrationFailed');
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
            document.getElementById('network-status-text').textContent = t('grid.signalingError');
        };
        state.ws.onclose = () => {
            updateConnectivityIndicator();
            document.getElementById('network-indicator').className = 'w-2.5 h-2.5 rounded-full bg-red-500';
            document.getElementById('network-status-text').textContent = t('grid.reconnecting');
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
                // Nur die Versionsnummer: andere holen das Profil P2P nur, wenn es sich geaendert hat.
                profileVersion: Number.isSafeInteger(state.myProfile.version) ? state.myProfile.version : undefined,
                // "Nur zeigen fuer ...": Regel als kurzer Code (audience.js), sonst nichts.
                audience: myAudienceCode(),
                silent: isEffectivelySilent() || isModeSilent(),
                ...getRegistrationScope(),
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
        handleVerificationRequired(registration.verificationRequired);
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
        showToast(t('grid.signedOutFromRoutingServer'), 'success');
        document.getElementById('network-indicator').className = 'w-2.5 h-2.5 rounded-full bg-red-500';
        document.getElementById('network-status-text').textContent = t('grid.signedOut');
    } catch (error) {
        showToast(t('grid.signOutFailed'), 'error');
    }
}
