let rtcConfig = {
    iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
    iceTransportPolicy: 'all'
};

// Dynamische TURN-Credentials beim Start vom Backend laden
async function fetchIceConfig() {
    try {
        const res = await fetch(`${API_BASE}/api/ice-config`);
        const data = await res.json();
        if (!data.iceServers) return;

        rtcConfig.iceServers = data.iceServers;
        state.serverLanMode = data.lanMode === true;
        // Der Server liefert auch ohne TURN eine gueltige STUN-Konfiguration.
        // Ohne diese Unterscheidung wuerde ein fehlendes TURN_SECRET faelschlich
        // als Erfolg protokolliert und die fehlenden Relays blieben unerklaert.
        if (data.turnEnabled) {
            logDebug('Dynamische TURN-Credentials erfolgreich geladen.');
        } else {
            logDebug(`WARNUNG: TURN ist serverseitig nicht aktiv (${data.reason || 'unbekannter Grund'}). `
                + 'Es sind nur STUN-Kandidaten verfuegbar, Verbindungen hinter NAT schlagen fehl.');
        }
    } catch (e) {
        logDebug('Konnte TURN-Credentials nicht laden, nutze STUN-Fallback.');
    }
}

fetchIceConfig();

// Club-/LAN-Modus (Server LAN_MODE oder Einstellung "Nur lokales Netz"): keine STUN/TURN-Server,
// nur lokale host/mDNS-Kandidaten. Verbindungen klappen dann nur im selben Netz.
function getRtcConfig() {
    const lanOnly = state.serverLanMode || state.gridSettings.lanOnly;
    return { ...rtcConfig, iceServers: lanOnly ? [] : rtcConfig.iceServers };
}

// Verbindungsart aus dem gewaehlten Kandidatenpaar: beide host = selbes Netz.
function classifyTransport(localType, remoteType) {
    if (localType === 'relay' || remoteType === 'relay') return 'relay';
    if (localType === 'host' && remoteType === 'host') return 'lan';
    return 'direct';
}

async function detectPeerTransport(peerId, connection) {
    try {
        const stats = await connection.getStats();
        let pair = null;
        stats.forEach(report => {
            if (report.type === 'transport' && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId);
        });
        if (!pair) stats.forEach(report => {
            if (!pair && report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) pair = report;
        });
        if (!pair) return;
        const local = stats.get(pair.localCandidateId);
        const remote = stats.get(pair.remoteCandidateId);
        state.peerTransport[peerId] = classifyTransport(local?.candidateType, remote?.candidateType);
        logDebug(`Verbindung zu ${peerId}: ${state.peerTransport[peerId]} (${local?.candidateType}/${remote?.candidateType})`);
        if (state.activeChatPeerId === peerId) {
            renderChatPeerIndicator();
            document.getElementById('chat-connection-type').textContent = `Encrypted WebRTC DataChannel (${state.peerTransport[peerId]})`;
        }
    } catch (error) {
        logDebug(`Could not read connection stats: ${error.message}`);
    }
}

function sendSignalingMessage(payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        throw new Error('Signaling connection is not ready.');
    }
    state.ws.send(JSON.stringify(payload));
}

function getOrCreatePeerConnection(peerId) {
    const existing = state.webrtcConnections[peerId];
    if (existing && !['closed', 'failed'].includes(existing.connectionState)) return existing;
    if (existing) cleanupPeerConnection(peerId, existing);

    const connection = new RTCPeerConnection(getRtcConfig());
    // Zeitpunkt merken: nach einem Signaling-Neustart gelten nur aeltere Verbindungen als haengend.
    connection.openGridCreatedAt = Date.now();
    state.webrtcConnections[peerId] = connection;
    state.pendingIceCandidates[peerId] = state.pendingIceCandidates[peerId] || [];
    const seenCandidateTypes = new Set();

    connection.onicecandidate = (event) => {
        if (!event.candidate) {
            const summary = seenCandidateTypes.size ? [...seenCandidateTypes].join(', ') : 'keine';
            logDebug(`ICE-Sammlung fuer ${peerId} beendet. Kandidatentypen: ${summary}`);
            if (!seenCandidateTypes.has('relay')) {
                logDebug(`WARNUNG: Kein relay-Kandidat fuer ${peerId}. TURN liefert keine Allocation.`);
            }
            return;
        }
        const candidateType = event.candidate.type || 'unknown';
        if (!seenCandidateTypes.has(candidateType)) {
            seenCandidateTypes.add(candidateType);
            logDebug(`ICE-Kandidat (${candidateType}/${event.candidate.protocol || 'n/a'}) fuer ${peerId}`);
        }
        try {
            sendSignalingMessage({
                type: 'ICE_CANDIDATE',
                targetPeerId: peerId,
                senderNodeId: state.myProfile.id,
                candidate: event.candidate
            });
        } catch (error) {
            logDebug(`Could not send ICE candidate: ${error.message}`);
        }
    };

    connection.oniceconnectionstatechange = () => {
        logDebug(`ICE state fuer ${peerId}: ${connection.iceConnectionState}`);
    };

    connection.ondatachannel = (event) => setupDataChannel(peerId, event.channel);
    // Video-Tracks kommen nur fuer Live-Secure-Snaps.
    connection.ontrack = (event) => handleSnapStreamTrack(peerId, event);
    connection.onconnectionstatechange = () => {
        const status = connection.connectionState;
        logDebug(`P2P connection with ${peerId}: ${status}`);
        if (status === 'connected') {
            detectPeerTransport(peerId, connection);
            clearTimeout(state.disconnectTimers[peerId]);
            delete state.disconnectTimers[peerId];
            state.connectionRetryCounts[peerId] = 0;
            const secured = Boolean(state.sessionKeys[peerId]);
            updateChatConnectionStatus(
                peerId,
                secured ? 'E2EE connected' : 'Securing channel...',
                secured ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-sky-500/10 text-sky-400 border-sky-500/30'
            );
        } else if (status === 'failed') {
            updateChatConnectionStatus(peerId, 'Disconnected', 'bg-red-500/10 text-red-400 border-red-500/30');
            reportConnectionFailure(peerId, connection, seenCandidateTypes);
            recoverPeerConnection(peerId, connection);
        } else if (status === 'disconnected') {
            updateChatConnectionStatus(peerId, 'Reconnecting...', 'bg-amber-500/10 text-amber-400 border-amber-500/30');
            clearTimeout(state.disconnectTimers[peerId]);
            state.disconnectTimers[peerId] = setTimeout(() => {
                if (connection.connectionState === 'disconnected') recoverPeerConnection(peerId, connection);
            }, 3000);
        } else if (status === 'closed') {
            cleanupPeerConnection(peerId, connection);
        }
    };
    return connection;
}

async function reportConnectionFailure(peerId, connection, seenCandidateTypes) {
    const local = new Set();
    const remote = new Set();
    try {
        const stats = await connection.getStats();
        stats.forEach(report => {
            if (report.type === 'local-candidate') local.add(report.candidateType);
            if (report.type === 'remote-candidate') remote.add(report.candidateType);
        });
    } catch (error) {
        logDebug(`Konnte ICE-Statistiken fuer ${peerId} nicht lesen: ${error.message}`);
    }
    const localTypes = local.size ? [...local].join(', ') : [...seenCandidateTypes].join(', ') || 'keine';
    const remoteTypes = remote.size ? [...remote].join(', ') : 'keine';
    logDebug(`Verbindung zu ${peerId} fehlgeschlagen. Lokale Kandidaten: ${localTypes} | Gegenstelle: ${remoteTypes}`);
    if (!local.has('relay')) {
        logDebug('Ursache: Es wurde lokal kein TURN-Relay-Kandidat erzeugt (TURN nicht erreichbar oder Credentials abgelehnt).');
    } else if (!remote.has('relay') && !remote.size) {
        logDebug('Ursache: Die Gegenstelle hat keine Kandidaten geliefert (Signaling erreicht den Peer nicht).');
    }
}

function cleanupPeerConnection(peerId, connection) {
    clearTimeout(state.disconnectTimers[peerId]);
    delete state.disconnectTimers[peerId];
    if (state.webrtcConnections[peerId] === connection) {
        delete state.webrtcConnections[peerId];
        delete state.dataChannels[peerId];
        delete state.sessionKeys[peerId];
        delete state.pendingIceCandidates[peerId];
        delete state.peerChatFocus[peerId];
        delete state.peerTransport[peerId];
        if (state.activeChatPeerId === peerId) renderChatPeerIndicator();
    }
    if (connection.signalingState !== 'closed') connection.close();
}

function recoverPeerConnection(peerId, connection) {
    cleanupPeerConnection(peerId, connection);
    const retries = state.connectionRetryCounts[peerId] || 0;
    if ((state.secureMessageQueues[peerId]?.length || state.activeChatPeerId === peerId) && retries < 1) {
        state.connectionRetryCounts[peerId] = retries + 1;
        setTimeout(() => initiateP2PConnection(peerId).catch(() => {
        }), 1000);
    } else if (state.secureMessageQueues[peerId]?.length) {
        flushPeerQueueToCache(peerId).then(() => {
            if (state.secureMessageQueues[peerId]?.length) {
                showToast('Nachricht konnte noch nicht zugestellt werden. Sie wird spaeter erneut gesendet.', 'warning');
            }
        }).catch(error => {
            logDebug(`Path C recovery failed: ${error.message}`);
            showToast('Nachricht konnte noch nicht zugestellt werden. Sie wird spaeter erneut gesendet.', 'warning');
        });
    }
}

async function flushPendingIceCandidates(peerId) {
    const connection = state.webrtcConnections[peerId];
    const candidates = state.pendingIceCandidates[peerId] || [];
    if (!connection?.remoteDescription) return;

    state.pendingIceCandidates[peerId] = [];
    for (const candidate of candidates) {
        await connection.addIceCandidate(candidate);
    }
}

async function handleSignalingMessage(message) {
    if (message.type === 'CACHE_WAITING') {
        scheduleCacheFetch();
        return;
    }

    if (message.type === 'PONG') {
        handleSignalingPong(message);
        return;
    }

    if (message.type === 'SOCKET_REGISTERED') {
        document.getElementById('network-indicator').className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse';
        document.getElementById('network-status-text').textContent = 'Worker connected';
        refreshChatControls()
            .then(() => {
                subscribePresence();
                // Nach einem (Neu-)Verbinden haengende P2P-Verbindungen neu aufbauen.
                retryVisiblePeerConnections(true);
                pushAllAlbumKeys().catch(error => logDebug(`Album key push failed: ${error.message}`));
                return fetchQueuedCacheMessages();
            })
            .catch(error => {
                logDebug(`Could not refresh chat controls or retrieve Path C messages: ${error.message}`);
            });
        return;
    }

    if (message.type === 'PRESENCE_SNAPSHOT') {
        const online = new Set(Array.isArray(message.online) ? message.online : []);
        state.peerPresence = Object.fromEntries(state.presenceSubscription.map(peerId => [peerId, online.has(peerId)]));
        online.forEach(peerId => handlePeerCameOnline(peerId));
        renderPresenceChange();
        return;
    }
    if (message.type === 'PRESENCE') {
        if (typeof message.peerId !== 'string' || !state.presenceSubscription.includes(message.peerId)) return;
        state.peerPresence[message.peerId] = message.online === true;
        if (message.online === true) handlePeerCameOnline(message.peerId);
        else updateProfilePresence(message.peerId, 'offline');
        renderPresenceChange(message.peerId);
        return;
    }

    if (message.type === 'PEER_OFFLINE') {
        const offlinePeerId = message.peerId;
        if (!offlinePeerId || offlinePeerId === state.myProfile.id) return;
        if (offlinePeerId in state.peerPresence) state.peerPresence[offlinePeerId] = false;
        const probe = state.presenceProbes[offlinePeerId];
        if (probe) clearTimeout(probe.timeout);
        delete state.presenceProbes[offlinePeerId];
        updateProfilePresence(offlinePeerId, 'offline');
        const connection = state.webrtcConnections[offlinePeerId];
        if (connection && connection.connectionState !== 'connected') cleanupPeerConnection(offlinePeerId, connection);
        return;
    }

    if (message.type === 'PEER_OFFLINE_FALLBACK') {
        const connection = state.webrtcConnections[message.targetPeerId];
        if (connection) cleanupPeerConnection(message.targetPeerId, connection);
        flushPeerQueueToCache(message.targetPeerId).catch(error => {
            logDebug(`Path C fallback failed: ${error.message}`);
        });
        updateChatConnectionStatus(message.targetPeerId, 'Peer unavailable', 'bg-amber-500/10 text-amber-400 border-amber-500/30');
        showDebugToast('Peer is currently unavailable for a direct P2P connection.', 'warning');
        return;
    }
    if (message.type === 'SIGNALING_ERROR') {
        logDebug(`Signaling server rejected a message: ${message.message}`);
        return;
    }

    const peerId = message.senderNodeId;
    if (!peerId || peerId === state.myProfile.id) return;
    if (isPeerBlocked(peerId)) {
        logDebug(`Ignored signaling from blocked peer ${peerId}.`);
        return;
    }
    const connection = getOrCreatePeerConnection(peerId);

    if (message.type === 'SDP_OFFER') {
        const polite = state.myProfile.id.localeCompare(peerId) > 0;
        const offerCollision = state.makingOffer[peerId] || connection.signalingState !== 'stable';
        state.ignoreOffer[peerId] = !polite && offerCollision;
        if (state.ignoreOffer[peerId]) {
            logDebug(`Ignored colliding offer from ${peerId}`);
            return;
        }
        if (offerCollision) {
            await Promise.all([
                connection.setLocalDescription({type: 'rollback'}),
                connection.setRemoteDescription(message.sdp)
            ]);
        } else {
            await connection.setRemoteDescription(message.sdp);
        }
        await flushPendingIceCandidates(peerId);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        sendSignalingMessage({
            type: 'SDP_ANSWER',
            targetPeerId: peerId,
            senderNodeId: state.myProfile.id,
            sdp: connection.localDescription
        });
    } else if (message.type === 'SDP_ANSWER') {
        state.ignoreOffer[peerId] = false;
        if (connection.signalingState !== 'have-local-offer') {
            logDebug(`Ignored stale answer from ${peerId}`);
            return;
        }
        await connection.setRemoteDescription(message.sdp);
        await flushPendingIceCandidates(peerId);
    } else if (message.type === 'ICE_CANDIDATE') {
        if (state.ignoreOffer[peerId]) return;
        const candidate = new RTCIceCandidate(message.candidate);
        try {
            if (connection.remoteDescription) {
                await connection.addIceCandidate(candidate);
            } else {
                state.pendingIceCandidates[peerId].push(candidate);
            }
        } catch (error) {
            if (!state.ignoreOffer[peerId]) throw error;
        }
    }
}

// ================= PRESENCE (CHAT-PARTNER) =================
// Unabhaengig vom Grid: der Server meldet den Status gegenseitiger Chat-Partner, egal in welcher Zelle.
function subscribePresence() {
    if (state.ws?.readyState !== WebSocket.OPEN) return;
    state.presenceSubscription = state.chatPeerIds.filter(peerId => !isPeerBlocked(peerId));
    state.ws.send(JSON.stringify({ type: 'PRESENCE_SUBSCRIBE', peerIds: state.presenceSubscription }));
}

function isPeerOnline(peerId) {
    return state.peerPresence[peerId] === true || state.dataChannels[peerId]?.readyState === 'open';
}

// Kommt ein Partner online, gehen wartende Nachrichten sofort direkt raus.
function handlePeerCameOnline(peerId) {
    updateProfilePresence(peerId, 'online');
    // Neuer Chat ohne Profil (z. B. erste Nachricht kam ueber den Router-Cache): jetzt direkt holen.
    requestMissingProfile(peerId);
    pushAlbumKeysToPeer(peerId).catch(logBackgroundError('handlePeerCameOnline'));
    pushStatusesToPeer(peerId).catch(logBackgroundError('handlePeerCameOnline'));
    const needsConnection = Boolean(state.secureMessageQueues[peerId]?.length) || state.activeChatPeerId === peerId;
    if (needsConnection && state.dataChannels[peerId]?.readyState !== 'open' && !isPeerBlocked(peerId)) {
        initiateP2PConnection(peerId).catch(logBackgroundError('handlePeerCameOnline'));
    }
}

function renderPresenceChange(peerId = null) {
    renderActivePeerList();
    if (!peerId || state.activeChatPeerId === peerId) renderChatPeerIndicator();
}

// Offener Chat und Peers mit wartenden Nachrichten, auch wenn sie nicht im Grid stehen (Chat- und
// Freunde-Modus haben kein Grid). Nach einem Signaling-Neustart (afterReconnect) gelten auch
// Verbindungen, die noch "new" oder "connecting" sind, als haengend, wenn sie vor dem neuen Socket
// entstanden sind: ihre Angebote gingen an den alten. Neuere laufen weiter.
function retryVisiblePeerConnections(afterReconnect = false) {
    const candidates = new Set([
        ...state.peers.map(peer => peer.id),
        state.activeChatPeerId,
        ...Object.keys(state.secureMessageQueues)
    ].filter(Boolean));
    const broken = ['failed', 'closed', 'disconnected'];
    const isStale = connection => broken.includes(connection.connectionState)
        || (afterReconnect && ['new', 'connecting'].includes(connection.connectionState)
            && (connection.openGridCreatedAt || 0) < (state.wsOpenedAt || 0));
    candidates.forEach(peerId => {
        const shouldReconnect = state.activeChatPeerId === peerId
            || Boolean(state.secureMessageQueues[peerId]?.length);
        if (!shouldReconnect || state.dataChannels[peerId]?.readyState === 'open' || isPeerBlocked(peerId)) return;

        const connection = state.webrtcConnections[peerId];
        if (connection && isStale(connection)) {
            cleanupPeerConnection(peerId, connection);
        } else if (connection && ['new', 'connecting', 'connected'].includes(connection.connectionState)) {
            // Laeuft noch (oder steht schon): nicht doppelt anstossen.
            return;
        }
        state.connectionRetryCounts[peerId] = 0;
        initiateP2PConnection(peerId).catch(error => {
            logDebug(`Could not reconnect to peer ${peerId}: ${error.message}`);
        });
    });
}

// Schluesselaustausch auf dem offenen Kanal. Kommt keine Antwort (Sitzungsschluessel fehlt nach
// KEY_HELLO_RETRY_MS), wird KEY_HELLO erneut gesendet; die Ableitung ist idempotent.
const KEY_HELLO_RETRY_MS = 4000;
const MAX_KEY_HELLO_ATTEMPTS = 4;

function sendKeyHello(peerId, channel, attempt, force = false) {
    if (!channel || state.dataChannels[peerId] !== channel || channel.readyState !== 'open') return;
    if (state.sessionKeys[peerId] && !force) return;
    if (attempt > 0) logDebug(`Kein Schluesselaustausch mit ${peerId}, sende KEY_HELLO erneut (${attempt + 1}/${MAX_KEY_HELLO_ATTEMPTS}).`);
    channel.send(JSON.stringify({
        type: 'KEY_HELLO',
        publicKey: state.myKeys.jwkPublic,
        profileSigningKey: state.myKeys.jwkEcdsaPublic
    }));
    if (!force && attempt + 1 < MAX_KEY_HELLO_ATTEMPTS) setTimeout(() => sendKeyHello(peerId, channel, attempt + 1), KEY_HELLO_RETRY_MS);
}

function setupDataChannel(peerId, channel) {
    state.dataChannels[peerId] = channel;

    channel.onopen = () => {
        clearTimeout(state.connectionWatchdogs[peerId]);
        delete state.stalledOffers[peerId];
        logDebug(`DataChannel opened with ${peerId}. Starting key handshake.`);
        updateChatConnectionStatus(peerId, 'Securing channel...', 'bg-sky-500/10 text-sky-400 border-sky-500/30');
        renderActivePeerList();
        sendKeyHello(peerId, channel, 0);
    };
    channel.onmessage = (event) => handleDataChannelMessage(peerId, event.data);
    channel.onclose = () => {
        if (state.dataChannels[peerId] === channel) {
            delete state.dataChannels[peerId];
            delete state.sessionKeys[peerId];
            updateChatConnectionStatus(peerId, 'Disconnected', 'bg-red-500/10 text-red-400 border-red-500/30');
            renderActivePeerList();
        }
    };
    channel.onerror = () => {
        updateChatConnectionStatus(peerId, 'Channel error', 'bg-red-500/10 text-red-400 border-red-500/30');
    };
}

// Neues Offer auf einer bestehenden Verbindung (z. B. nach addTrack/removeTrack fuer Live-Snaps).
async function renegotiatePeerConnection(peerId) {
    const connection = state.webrtcConnections[peerId];
    if (!connection || connection.signalingState === 'closed') return;
    try {
        state.makingOffer[peerId] = true;
        await connection.setLocalDescription(await connection.createOffer());
        sendSignalingMessage({
            type: 'SDP_OFFER',
            targetPeerId: peerId,
            senderNodeId: state.myProfile.id,
            sdp: connection.localDescription
        });
    } finally {
        state.makingOffer[peerId] = false;
    }
}

// Wachhund fuer einen Verbindungsversuch: kommt auf das Angebot keine Antwort (verloren, Gegenseite
// startete gerade) oder oeffnet sich der Kanal trotz Antwort nicht, wird neu angeboten. Sonst bliebe der
// Kanal fuer immer "connecting" und jeder weitere Versuch wuerde uebersprungen (Nachrichten nur noch
// ueber Pfad C).
const OFFER_ANSWER_TIMEOUT_MS = 8000;
const CHANNEL_OPEN_TIMEOUT_MS = 20000;
const MAX_STALLED_OFFERS = 3;

function watchConnectionAttempt(peerId, connection) {
    clearTimeout(state.connectionWatchdogs[peerId]);
    const check = () => {
        if (state.webrtcConnections[peerId] !== connection || state.dataChannels[peerId]?.readyState === 'open') return;
        // Mit Antwort, aber noch ohne Kanal: mehr Zeit (ICE ueber TURN kann dauern).
        const answered = Boolean(connection.remoteDescription);
        if (answered && Date.now() - startedAt < CHANNEL_OPEN_TIMEOUT_MS) {
            state.connectionWatchdogs[peerId] = setTimeout(check, CHANNEL_OPEN_TIMEOUT_MS - (Date.now() - startedAt));
            return;
        }
        const stalled = state.stalledOffers[peerId] || 0;
        logDebug(`Verbindung zu ${peerId} haengt (${answered ? 'Kanal oeffnet nicht' : 'keine Antwort auf das Angebot'}), Versuch ${stalled + 1}/${MAX_STALLED_OFFERS}.`);
        cleanupPeerConnection(peerId, connection);
        if (stalled >= MAX_STALLED_OFFERS || isPeerBlocked(peerId)) return;
        state.stalledOffers[peerId] = stalled + 1;
        initiateP2PConnection(peerId).catch(logBackgroundError('watchConnectionAttempt'));
    };
    const startedAt = Date.now();
    state.connectionWatchdogs[peerId] = setTimeout(check, OFFER_ANSWER_TIMEOUT_MS);
}

async function initiateP2PConnection(peerId) {
    if (isPeerBlocked(peerId)) return;
    if (state.dataChannels[peerId]?.readyState === 'open') return;
    if (state.dataChannels[peerId]?.readyState === 'connecting') return;
    if (state.connectionAttempts[peerId]) return state.connectionAttempts[peerId];

    state.connectionAttempts[peerId] = (async () => {
        updateChatConnectionStatus(peerId, 'Connecting...', 'bg-sky-500/10 text-sky-400 border-sky-500/30');
        const connection = getOrCreatePeerConnection(peerId);
        const channel = connection.createDataChannel('opengrid-e2ee');
        setupDataChannel(peerId, channel);
        try {
            state.makingOffer[peerId] = true;
            await connection.setLocalDescription(await connection.createOffer());
            sendSignalingMessage({
                type: 'SDP_OFFER',
                targetPeerId: peerId,
                senderNodeId: state.myProfile.id,
                sdp: connection.localDescription
            });
            logDebug(`Sent P2P offer to ${peerId}`);
            watchConnectionAttempt(peerId, connection);
        } finally {
            state.makingOffer[peerId] = false;
        }
    })();

    try {
        await state.connectionAttempts[peerId];
    } catch (error) {
        updateChatConnectionStatus(peerId, 'Connection failed', 'bg-red-500/10 text-red-400 border-red-500/30');
        showDebugToast(`Could not start P2P connection: ${error.message}`, 'error');
        throw error;
    } finally {
        delete state.connectionAttempts[peerId];
    }
}

async function deriveSessionKey(peerId, publicJwk, profileSigningKey) {
    if (!profileSigningKey) throw new Error('Peer did not provide a profile signing key.');
    const knownIdentity = await getPeerIdentity(peerId);
    if (knownIdentity?.jwkPublic && !publicKeysMatch(knownIdentity.jwkPublic, publicJwk)) {
        throw new Error('Peer ECDH identity key changed.');
    }
    if (knownIdentity?.profileSigningKey && !publicJwksMatch(knownIdentity.profileSigningKey, profileSigningKey)) {
        throw new Error('Peer profile signing key changed.');
    }
    // Per Einladungslink angelegter Kontakt: der Schluessel muss zum Fingerprint im Link passen.
    if (!await verifyInvitedPeerKey(peerId, profileSigningKey)) {
        showToast('Achtung: Dieser Kontakt hat nicht den Schluessel aus der Einladung. Verbindung abgebrochen.', 'error');
        const connection = state.webrtcConnections[peerId];
        if (connection) cleanupPeerConnection(peerId, connection);
        throw new Error('Peer key does not match the invite fingerprint.');
    }
    await persistPeerIdentityKey(peerId, publicJwk, profileSigningKey);
    const publicKey = await window.crypto.subtle.importKey(
        'jwk',
        publicJwk,
        {name: 'ECDH', namedCurve: 'P-256'},
        false,
        []
    );
    state.sessionKeys[peerId] = await window.crypto.subtle.deriveKey(
        {name: 'ECDH', public: publicKey},
        state.myKeys.keyPair.privateKey,
        {name: 'AES-GCM', length: 256},
        false,
        ['encrypt', 'decrypt']
    );
    updateChatConnectionStatus(peerId, 'E2EE connected', 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30');
    if (isChatVisibleFor(peerId)) sendChatFocus(peerId, true);
    // Profil-Handshake: neuer Kontakt (Einladung, erste Nachricht) ohne bekanntes Profil.
    if (!state.cachedProfiles[peerId]) sendSecurePayload(peerId, { type: 'PROFILE_REQUEST' }).catch(logBackgroundError('deriveSessionKey'));
    // Alben v2: Betrachter bekommen beim Verbinden die aktuellen Schluessel-Buendel.
    pushAlbumKeysToPeer(peerId).catch(logBackgroundError('deriveSessionKey'));
    pushStatusesToPeer(peerId).catch(logBackgroundError('deriveSessionKey'));
    requestMissingOriginals(peerId).catch(logBackgroundError('deriveSessionKey'));
    await beginChatSync(peerId);
    await flushSecureMessageQueue(peerId);
}

async function encryptSecurePayload(peerId, payload) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = await window.crypto.subtle.encrypt(
        {name: 'AES-GCM', iv},
        state.sessionKeys[peerId],
        plaintext
    );
    return {
        type: 'SECURE_ENVELOPE',
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(new Uint8Array(ciphertext))
    };
}

async function decryptSecurePayload(peerId, envelope) {
    const plaintext = await window.crypto.subtle.decrypt(
        {name: 'AES-GCM', iv: base64ToBytes(envelope.iv)},
        state.sessionKeys[peerId],
        base64ToBytes(envelope.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
}

async function handleIncomingProfileRequest(peerId) {
    // Sichtbarkeit: jeder Peer bekommt nur, was seine Match-Stufe erlaubt.
    const profilePayload = buildProfilePayloadFor(peerId);
    const signedEnvelope = await signProfileData(profilePayload, state.myKeys.ecdsaKeyPair.privateKey, state.myKeys.jwkEcdsaPublic);
    sendSecurePayload(peerId, { type: 'PROFILE_RESPONSE', signedEnvelope }).catch(logBackgroundError('handleIncomingProfileRequest'));
}

async function handleIncomingProfileResponse(peerId, signedEnvelopeOrProfile) {
    let profile;
    if (!signedEnvelopeOrProfile) return;
    if (signedEnvelopeOrProfile.signature && signedEnvelopeOrProfile.payload) {
        const identity = await getPeerIdentity(peerId);
        const verdict = await verifySignedProfile(
            signedEnvelopeOrProfile,
            peerId,
            identity?.profileSigningKey
        );
        // Auf dem direkten Weg geht dem Profil immer ein KEY_HELLO voraus, der
        // den Signaturschluessel pinnt. Ein ungepinnter Schluessel waere hier
        // also ein Protokollfehler und wird nicht akzeptiert.
        if (verdict !== 'trusted') {
            if (verdict === 'unpinned') {
                logDebug(`Direktes Profil von ${peerId} ohne gepinnten Signaturschluessel verworfen.`);
            }
            return;
        }
        profile = {
            ...signedEnvelopeOrProfile.payload,
            signedEnvelope: signedEnvelopeOrProfile,
            trustLevel: 'trusted'
        };
    } else if (signedEnvelopeOrProfile.fields) {
        profile = signedEnvelopeOrProfile; // Legacy Profil ohne Signatur
    }
    if (!profile || !isProfileAudienceAcceptable(profile)) return;
    const acceptedProfile = await cachePeerProfile(peerId, profile);
    if (state.activeModalPeerId === peerId && typeof renderProfileModalData === 'function') {
        renderProfileModalData(acceptedProfile);
    }
    // Name und Bild in Chatliste und Kontaktleiste nachziehen.
    renderActivePeerList();
    if (state.activeChatPeerId === peerId) renderChatPeerHeader(peerId);
}

async function handleIncomingImageRequest(peerId, imageId) {
    // Nur Galeriebilder und Bilder aus Alben, fuer die der Peer freigeschaltet ist.
    if (typeof imageId !== 'string' || !canPeerAccessImage(peerId, imageId)) {
        logDebug(`Denied image ${imageId} for ${peerId}.`);
        return;
    }
    // Albumbilder gehen nur verschluesselt mit dem Schluessel des Betrachters raus.
    if (findOwnAlbumForImage(imageId)) {
        await serveAlbumImage(peerId, imageId);
        return;
    }
    const media = await loadMedia(imageId);
    if (media) sendSecurePayload(peerId, { type: 'IMAGE_RESPONSE', imageId, version: media.version, data: media.data }).catch(logBackgroundError('handleIncomingImageRequest'));
}

async function handleIncomingImageResponse(peerId, imageId, version, data) {
    const requestKey = `${peerId}:${imageId}`;
    const requestedVersion = state.pendingImageRequests[requestKey];
    const galleryEntry = state.cachedProfiles[peerId]?.gallery?.find(item => item.id === imageId);
    if (requestedVersion !== version || galleryEntry?.version !== version || !isSafeInlineImage(data)) {
        logDebug(`Rejected unsolicited gallery image ${imageId} from ${peerId}.`);
        return;
    }
    delete state.pendingImageRequests[requestKey];
    const currentMedia = await loadMedia(imageId);
    if (currentMedia && currentMedia.version > version) return;
    await cacheMedia(imageId, data, version);
    if (typeof renderModalGalleryImage === 'function') renderModalGalleryImage(imageId, data);
}

async function handleDataChannelMessage(peerId, rawMessage) {
    try {
        // Uebergrosse oder binaere Nachrichten gar nicht erst parsen.
        if (typeof rawMessage !== 'string' || rawMessage.length > MAX_SECURE_MESSAGE_LENGTH) {
            throw new Error('Message too large or not text.');
        }
        const message = JSON.parse(rawMessage);
        if (message.type === 'KEY_HELLO') {
            logDebug(`KEY_HELLO von ${peerId} empfangen.`);
            const hadKey = Boolean(state.sessionKeys[peerId]);
            await deriveSessionKey(peerId, message.publicKey, message.profileSigningKey);
            logDebug(`Sitzungsschluessel fuer ${peerId} bereit.`);
            // Die Gegenseite fragt erneut (unser KEY_HELLO ging verloren): antworten.
            if (hadKey) sendKeyHello(peerId, state.dataChannels[peerId], 0, true);
            return;
        }
        if (message.type !== 'SECURE_ENVELOPE' || !state.sessionKeys[peerId]) return;
        await handleSecurePayload(peerId, await decryptSecurePayload(peerId, message));
    } catch (error) {
        logDebug(`Rejected P2P message from ${peerId}: ${error.message}`);
    }
}

async function handleSecurePayload(peerId, payload, deliveredVia = 'E2EE P2P') {
    if (isPeerBlocked(peerId)) return;
    // Gilt fuer P2P und Pfad C: nur bekannte Typen mit plausiblen Feldern (payload-validation.js).
    if (!isValidSecurePayload(payload)) {
        logDebug(`Rejected invalid ${typeof payload?.type === 'string' ? payload.type.substring(0, 40) : 'unknown'} payload from ${peerId}.`);
        return;
    }
    if (payload.type === 'CHAT_OPERATION') {
        await applyChatOperation(peerId, payload.operation, deliveredVia);
    } else if (payload.type === 'CHAT_FOCUS') {
        receiveChatFocus(peerId, payload.open);
    } else if (payload.type === 'CHAT_SYNC_HELLO') {
        await handleChatSyncHello(peerId, payload);
    } else if (payload.type === 'CHAT_SYNC_INVENTORY_REQUEST') {
        await sendChatSyncInventory(peerId, payload.cursor || 0);
    } else if (payload.type === 'CHAT_SYNC_INVENTORY') {
        await handleChatSyncInventory(peerId, payload);
    } else if (payload.type === 'CHAT_SYNC_OPERATION_REQUEST') {
        await sendRequestedChatOperations(peerId, payload.operationIds || []);
    } else if (payload.type === 'CHAT_SYNC_OPERATIONS') {
        for (const operation of payload.operations || []) {
            await applyChatOperation(peerId, operation, 'E2EE Sync');
        }
    } else if (payload.type === 'CHAT_MESSAGE') {
        await receiveChatMessage(peerId, payload);
    } else if (payload.type === 'PRESENCE_PING') {
        await sendSecurePayload(peerId, {
            type: 'PRESENCE_PONG',
            nonce: payload.nonce
        });
    } else if (payload.type === 'PRESENCE_PONG') {
        const probe = state.presenceProbes[peerId];
        if (probe?.nonce === payload.nonce) {
            clearTimeout(probe.timeout);
            delete state.presenceProbes[peerId];
            updateProfilePresence(peerId, 'online');
        }
    } else if (payload.type === 'PROFILE_REQUEST') {
        await handleIncomingProfileRequest(peerId);
    } else if (payload.type === 'PROFILE_RESPONSE') {
        await handleIncomingProfileResponse(peerId, payload.signedEnvelope || payload.profile);
    } else if (payload.type === 'SWARM_PROFILE_REQUEST') {
        const targetId = payload.targetNodeId;
        // Wenn wir selbst das Ziel sind, senden wir normal (direkt)
        if (targetId === state.myProfile.id) {
            await handleIncomingProfileRequest(peerId);
        } else {
            // Wenn wir das Profil eines Dritten haben, servieren wir es dem Schwarm
            const cachedProfile = state.cachedProfiles[targetId];
            // Match-Profile sind an einen Empfaenger gebunden und werden nie weitergegeben.
            if (cachedProfile && cachedProfile.signedEnvelope && isProfileShareable(cachedProfile)) {
                sendSecurePayload(peerId, {
                    type: 'SWARM_PROFILE_RESPONSE',
                    targetNodeId: targetId,
                    signedEnvelope: cachedProfile.signedEnvelope
                }).catch(() => {
                });
            }
        }
    } else if (payload.type === 'SWARM_PROFILE_RESPONSE') {
        const {targetNodeId, signedEnvelope} = payload;
        const identity = await getPeerIdentity(targetNodeId);
        const verdict = await verifySignedProfile(signedEnvelope, targetNodeId, identity?.profileSigningKey);
        if (!verdict) {
            logDebug(`Gefaelschtes Schwarm-Profil fuer ${targetNodeId} von ${peerId} verworfen.`);
            return;
        }
        if (verdict === 'unpinned') {
            logDebug(`Schwarm-Profil fuer ${targetNodeId} von ${peerId} erhalten (Signatur gueltig, `
                + 'Schluessel noch unbestaetigt - wird erst bei direkter Verbindung gepinnt).');
        } else {
            logDebug(`Gueltiges Schwarm-Profil fuer ${targetNodeId} von ${peerId} erhalten!`);
        }
        if (!isProfileShareable(signedEnvelope.payload)) return;
        const profile = {
            ...signedEnvelope.payload,
            signedEnvelope,
            // Ueber Dritte bezogene Profile sind nicht endgueltig bestaetigt.
            // Das Flag erlaubt der UI, sie entsprechend zu kennzeichnen.
            trustLevel: verdict
        };
        const acceptedProfile = await cachePeerProfile(targetNodeId, profile);
        if (state.activeModalPeerId === targetNodeId && typeof renderProfileModalData === 'function') {
            renderProfileModalData(acceptedProfile);
        }
        renderActivePeerList();
        if (state.activeChatPeerId === targetNodeId) renderChatPeerHeader(targetNodeId);
    } else if (payload.type === 'ALBUM_REQUEST') {
        await handleAlbumRequest(peerId, payload.albumId);
    } else if (payload.type === 'ALBUM_RESPONSE') {
        await handleAlbumResponse(peerId, payload);
    } else if (payload.type === 'ALBUM_DENIED') {
        await handleAlbumDenied(peerId, payload.albumId);
    } else if (payload.type === 'SNAP_VIEW_REQUEST') {
        await handleSnapViewRequest(peerId, payload);
    } else if (payload.type === 'SNAP_VIEW_GRANT') {
        await handleSnapViewGrant(peerId, payload);
    } else if (payload.type === 'SNAP_VIEW_DENIED') {
        await handleSnapViewDenied(peerId, payload);
    } else if (payload.type === 'SNAP_STREAM_START') {
        await handleSnapStreamStart(peerId, payload);
    } else if (payload.type === 'SNAP_STREAM_PLAYING') {
        handleSnapStreamPlaying(peerId, payload);
    } else if (payload.type === 'SNAP_STREAM_END') {
        handleSnapStreamEnd(peerId, payload);
    } else if (payload.type === 'SNAP_VIEW_CLOSED') {
        handleSnapViewClosed(peerId, payload);
    } else if (payload.type === 'ALBUM_KEY_REQUEST') {
        await handleAlbumKeyRequest(peerId, payload);
    } else if (payload.type === 'ALBUM_REVOKED') {
        await forgetReceivedAlbum(peerId, payload.albumId);
    } else if (payload.type === 'IMAGE_REQUEST') {
        await handleIncomingImageRequest(peerId, payload.imageId);
    } else if (payload.type === 'ORIGINAL_REQUEST') {
        await handleOriginalRequest(peerId, payload);
    } else if (payload.type === 'ORIGINAL_CHUNK') {
        await handleOriginalChunk(peerId, payload);
    } else if (payload.type === 'SWARM_IMAGE_REQUEST') {
        await handleSwarmImageRequest(peerId, payload);
    } else if (payload.type === 'SWARM_IMAGE_RESPONSE') {
        await handleSwarmImageResponse(peerId, payload);
    } else if (payload.type === 'SWARM_ALBUM_REQUEST') {
        await handleSwarmAlbumRequest(peerId, payload);
    } else if (payload.type === 'SWARM_ALBUM_RESPONSE') {
        await handleSwarmAlbumResponse(peerId, payload);
    } else if (payload.type === 'SWARM_ALBUM_IMAGE_REQUEST') {
        await handleSwarmAlbumImageRequest(peerId, payload);
    } else if (payload.type === 'SWARM_ALBUM_IMAGE_RESPONSE') {
        await handleSwarmAlbumImageResponse(peerId, payload);
    } else if (payload.type === 'IMAGE_RESPONSE' && payload.encrypted) {
        await handleAlbumImageResponse(peerId, payload);
    } else if (payload.type === 'IMAGE_RESPONSE') {
        await handleIncomingImageResponse(peerId, payload.imageId, payload.version, payload.data);
    }
}
