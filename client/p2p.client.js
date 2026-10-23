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

    const connection = new RTCPeerConnection(rtcConfig);
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
    if (message.type === 'SOCKET_REGISTERED') {
        document.getElementById('network-indicator').className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse';
        document.getElementById('network-status-text').textContent = 'Worker connected';
        refreshChatControls()
            .then(() => {
                subscribePresence();
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
    const needsConnection = Boolean(state.secureMessageQueues[peerId]?.length) || state.activeChatPeerId === peerId;
    if (needsConnection && state.dataChannels[peerId]?.readyState !== 'open' && !isPeerBlocked(peerId)) {
        initiateP2PConnection(peerId).catch(() => {});
    }
}

function renderPresenceChange(peerId = null) {
    renderActivePeerList();
    if (!peerId || state.activeChatPeerId === peerId) renderChatPeerIndicator();
}

function retryVisiblePeerConnections() {
    state.peers.forEach(peer => {
        const shouldReconnect = state.activeChatPeerId === peer.id
            || Boolean(state.secureMessageQueues[peer.id]?.length);
        if (!shouldReconnect || state.dataChannels[peer.id]?.readyState === 'open') return;

        const connection = state.webrtcConnections[peer.id];
        if (connection && ['failed', 'closed', 'disconnected'].includes(connection.connectionState)) {
            cleanupPeerConnection(peer.id, connection);
        }
        state.connectionRetryCounts[peer.id] = 0;
        initiateP2PConnection(peer.id).catch(error => {
            logDebug(`Could not reconnect to visible peer ${peer.id}: ${error.message}`);
        });
    });
}

function setupDataChannel(peerId, channel) {
    state.dataChannels[peerId] = channel;

    channel.onopen = () => {
        logDebug(`DataChannel opened with ${peerId}. Starting key handshake.`);
        updateChatConnectionStatus(peerId, 'Securing channel...', 'bg-sky-500/10 text-sky-400 border-sky-500/30');
        renderActivePeerList();
        channel.send(JSON.stringify({
            type: 'KEY_HELLO',
            publicKey: state.myKeys.jwkPublic,
            profileSigningKey: state.myKeys.jwkEcdsaPublic
        }));
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
    const profilePayload = {
        id: state.myProfile.id,
        fields: state.myProfile.fields,
        avatar: state.myProfile.avatar,
        gallery: state.myProfile.gallery || [],
        version: state.myProfile.version,
        updatedAt: state.myProfile.updatedAt
    };
    const signedEnvelope = await signProfileData(profilePayload, state.myKeys.ecdsaKeyPair.privateKey, state.myKeys.jwkEcdsaPublic);
    sendSecurePayload(peerId, { type: 'PROFILE_RESPONSE', signedEnvelope }).catch(() => {});
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
    if (!profile) return;
    const acceptedProfile = await cachePeerProfile(peerId, profile);
    if (state.activeModalPeerId === peerId && typeof renderProfileModalData === 'function') {
        renderProfileModalData(acceptedProfile);
    }
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
    if (media) sendSecurePayload(peerId, { type: 'IMAGE_RESPONSE', imageId, version: media.version, data: media.data }).catch(() => {});
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
        const message = JSON.parse(rawMessage);
        if (message.type === 'KEY_HELLO') {
            await deriveSessionKey(peerId, message.publicKey, message.profileSigningKey);
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
            if (cachedProfile && cachedProfile.signedEnvelope) {
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
    } else if (payload.type === 'ALBUM_KEY_RESPONSE') {
        await handleAlbumKeyResponse(peerId, payload);
    } else if (payload.type === 'ALBUM_REVOKED') {
        await forgetReceivedAlbum(peerId, payload.albumId);
    } else if (payload.type === 'IMAGE_REQUEST') {
        await handleIncomingImageRequest(peerId, payload.imageId);
    } else if (payload.type === 'IMAGE_RESPONSE' && payload.encrypted) {
        await handleAlbumImageResponse(peerId, payload);
    } else if (payload.type === 'IMAGE_RESPONSE') {
        await handleIncomingImageResponse(peerId, payload.imageId, payload.version, payload.data);
    }
}

async function beginChatSync(peerId) {
    if (state.chatSyncInProgress[peerId]) return;
    state.chatSyncInProgress[peerId] = true;
    try {
        const operations = await getChatOperations(peerId);
        await sendSecurePayload(peerId, {
            type: 'CHAT_SYNC_HELLO',
            recentOperationIds: operations.slice(0, 20).map(operation => operation.operationId),
            hasMore: operations.length > 20
        });
    } finally {
        delete state.chatSyncInProgress[peerId];
    }
}

async function handleChatSyncHello(peerId, payload) {
    await confirmDeliveredOperations(peerId, payload.recentOperationIds || []);
    const operations = await getChatOperations(peerId);
    const localIds = new Set(operations.map(operation => operation.operationId));
    const missingIds = (payload.recentOperationIds || []).filter(operationId => !localIds.has(operationId));
    if (missingIds.length) {
        await sendSecurePayload(peerId, {
            type: 'CHAT_SYNC_OPERATION_REQUEST',
            operationIds: missingIds
        });
    }
    if (payload.hasMore) {
        await sendSecurePayload(peerId, {
            type: 'CHAT_SYNC_INVENTORY_REQUEST',
            cursor: 20
        });
    }
}

async function sendChatSyncInventory(peerId, cursor) {
    const operations = await getChatOperations(peerId);
    const pageSize = 50;
    await sendSecurePayload(peerId, {
        type: 'CHAT_SYNC_INVENTORY',
        operationIds: operations
            .slice(cursor, cursor + pageSize)
            .map(operation => operation.operationId),
        nextCursor: cursor + pageSize < operations.length ? cursor + pageSize : null
    });
}

async function handleChatSyncInventory(peerId, payload) {
    await confirmDeliveredOperations(peerId, payload.operationIds || []);
    const localIds = new Set(
        (await getChatOperations(peerId)).map(operation => operation.operationId)
    );
    const missingIds = (payload.operationIds || []).filter(operationId => !localIds.has(operationId));
    if (missingIds.length) {
        await sendSecurePayload(peerId, {
            type: 'CHAT_SYNC_OPERATION_REQUEST',
            operationIds: missingIds
        });
    }
    if (payload.nextCursor !== null && payload.nextCursor !== undefined) {
        await sendSecurePayload(peerId, {
            type: 'CHAT_SYNC_INVENTORY_REQUEST',
            cursor: payload.nextCursor
        });
    }
}

async function sendRequestedChatOperations(peerId, operationIds) {
    const requestedIds = new Set(operationIds.slice(0, 50));
    const operations = (await getChatOperations(peerId))
        .filter(operation => requestedIds.has(operation.operationId))
        .map(({peerId: _localPeerId, ...operation}) => operation);
    if (!operations.length) return;
    await sendSecurePayload(peerId, {
        type: 'CHAT_SYNC_OPERATIONS',
        operations
    });
}

async function sendSecurePayload(peerId, payload, onSent = null) {
    if (isPeerBlocked(peerId)) return false;
    const channel = state.dataChannels[peerId];

    // Wenn der P2P/TURN-Kanal offen und sicher ist -> Direkt senden
    if (channel?.readyState === 'open' && state.sessionKeys[peerId]) {
        try {
            channel.send(JSON.stringify(await encryptSecurePayload(peerId, payload)));
            if (onSent) onSent('p2p');
            return true;
        } catch (error) {
            logDebug(`P2P send failed: ${error.message}`);
        }
    }

    // Andernfalls: In die lokale Warteschlange einreihen und Verbindung aufbauen/abwarten
    if (!state.secureMessageQueues[peerId]) {
        state.secureMessageQueues[peerId] = [];
    }

    const item = {payload, onSent, cacheQueued: false};
    state.secureMessageQueues[peerId].push(item);
    logDebug(`P2P/TURN-Kanal fuer ${peerId} noch nicht bereit. Nachricht in Queue eingereiht, starte Verbindung...`);
    if (onSent) scheduleQueueFallback(peerId, item);

    initiateP2PConnection(peerId).catch(error => {
        logDebug(`Could not initiate P2P connection: ${error.message}`);
    });

    return false;
}

// Steht der Kanal nach SECURE_QUEUE_FALLBACK_MS noch nicht, geht die Operation ueber Path C.
// Klappt auch das nicht, bleibt sie im Operations-Log und wird beim naechsten Chat-Sync zugestellt.
const SECURE_QUEUE_FALLBACK_MS = 10000;

function scheduleQueueFallback(peerId, item) {
    setTimeout(async () => {
        if (!state.secureMessageQueues[peerId]?.includes(item) || item.cacheQueued || item.discarded) return;
        let queued = false;
        try {
            queued = await queuePayloadInCache(peerId, item);
        } catch (error) {
            logDebug(`Path C fallback for ${peerId} failed: ${error.message}`);
        }
        if (!queued && !item.discarded) item.onSent('pending');
    }, SECURE_QUEUE_FALLBACK_MS);
}

async function flushSecureMessageQueue(peerId) {
    const queue = state.secureMessageQueues[peerId] || [];
    state.secureMessageQueues[peerId] = [];
    for (const item of queue) {
        if (item.cacheQueued) continue;
        await sendSecurePayload(peerId, item.payload, item.onSent);
    }
}

async function deriveCacheEncryptionKey(publicJwk) {
    const publicKey = await window.crypto.subtle.importKey(
        'jwk',
        publicJwk,
        {name: 'ECDH', namedCurve: 'P-256'},
        false,
        []
    );
    return window.crypto.subtle.deriveKey(
        {name: 'ECDH', public: publicKey},
        state.myKeys.keyPair.privateKey,
        {name: 'AES-GCM', length: 256},
        false,
        ['encrypt', 'decrypt']
    );
}

async function queuePayloadInCache(peerId, item) {
    if (item.cacheQueued || item.payload?.type !== 'CHAT_OPERATION') return false;
    if (!state.gridSettings.cacheEnabled) {
        logDebug(`Path C skipped for ${peerId}: message cache is disabled locally.`);
        return false;
    }
    const peerPublicKey = await getPeerIdentityKey(peerId);
    if (!peerPublicKey) {
        logDebug(`Path C skipped for ${peerId}: no trusted peer identity key is cached.`);
        return false;
    }

    const encryptionKey = await deriveCacheEncryptionKey(peerPublicKey);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await window.crypto.subtle.encrypt(
        {name: 'AES-GCM', iv},
        encryptionKey,
        new TextEncoder().encode(JSON.stringify(item.payload))
    );
    const response = await fetch(`${API_BASE}/api/cache`, {
        method: 'POST',
        headers: peerAuthHeaders({'Content-Type': 'application/json'}),
        body: JSON.stringify({
            recipientId: peerId,
            senderId: state.myProfile.id,
            ciphertextPayload: JSON.stringify({
                version: 1,
                senderPublicKey: state.myKeys.jwkPublic,
                ciphertext: bytesToBase64(new Uint8Array(ciphertext))
            }),
            ivHex: bytesToBase64(iv),
            ttlHours: 24,
            // Nur neue Nachrichten wecken den Empfaenger per Web Push.
            notify: item.payload.operation?.type === 'MESSAGE_PUT'
        })
    });
    if (response.status === 403) {
        item.discarded = true;
        if (item.onSent) item.onSent('rejected');
        logDebug(`Path C delivery to ${peerId} was rejected by the recipient.`);
        return false;
    }
    if (!response.ok) throw new Error(`Cache API returned ${response.status}.`);
    item.cacheQueued = true;
    const queued = await response.json().catch(() => ({}));
    if (item.onSent) item.onSent('cache', { expiresAt: queued.expiresAt });
    return true;
}

async function flushPeerQueueToCache(peerId) {
    const queue = state.secureMessageQueues[peerId] || [];
    try {
        for (const item of queue) {
            try {
                await queuePayloadInCache(peerId, item);
            } catch (error) {
                logDebug(`Could not queue operation for ${peerId}: ${error.message}`);
            }
        }
    } finally {
        state.secureMessageQueues[peerId] = queue.filter(item => !item.cacheQueued && !item.discarded);
    }
}

function publicKeysMatch(left, right) {
    return Boolean(left && right)
        && left.kty === right.kty
        && left.crv === right.crv
        && left.x === right.x
        && left.y === right.y;
}

async function fetchQueuedCacheMessages() {
    if (state.cacheFetchInFlight || !state.myKeys) return;
    state.cacheFetchInFlight = true;
    try {
        const response = await fetch(`${API_BASE}/api/cache/${encodeURIComponent(state.myProfile.id)}`, {
            cache: 'no-store',
            headers: peerAuthHeaders()
        });
        if (!response.ok) throw new Error(`Cache API returned ${response.status}.`);
        const {messages = []} = await response.json();

        for (const cachedMessage of messages) {
            try {
                if (isPeerBlocked(cachedMessage.senderId)) throw new Error('Sender is blocked.');
                const envelope = JSON.parse(cachedMessage.ciphertextPayload);
                const trustedSenderKey = await getPeerIdentityKey(cachedMessage.senderId);
                if (!trustedSenderKey || !publicKeysMatch(trustedSenderKey, envelope.senderPublicKey)) {
                    throw new Error('Sender identity key does not match the trusted P2P key.');
                }
                const decryptionKey = await deriveCacheEncryptionKey(envelope.senderPublicKey);
                const plaintext = await window.crypto.subtle.decrypt(
                    {name: 'AES-GCM', iv: base64ToBytes(cachedMessage.ivHex)},
                    decryptionKey,
                    base64ToBytes(envelope.ciphertext)
                );
                const payload = JSON.parse(new TextDecoder().decode(plaintext));
                if (payload.type !== 'CHAT_OPERATION') throw new Error('Unsupported cached payload type.');
                await handleSecurePayload(cachedMessage.senderId, payload, 'Encrypted Path C');
                const deleteResponse = await fetch(
                    `${API_BASE}/api/cache/${encodeURIComponent(cachedMessage.msgId)}`,
                    {method: 'DELETE', headers: peerAuthHeaders()}
                );
                if (!deleteResponse.ok) throw new Error(`Cache delete returned ${deleteResponse.status}.`);
            } catch (error) {
                logDebug(`Rejected Path C message ${cachedMessage.msgId}: ${error.message}`);
            }
        }
    } catch (error) {
        logDebug(`Path C retrieval failed: ${error.message}`);
    } finally {
        state.cacheFetchInFlight = false;
    }
}