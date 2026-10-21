const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

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

    connection.onicecandidate = (event) => {
        if (!event.candidate) return;
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

    connection.ondatachannel = (event) => setupDataChannel(peerId, event.channel);
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
            recoverPeerConnection(peerId, connection);
        } else if (status === 'disconnected') {
            updateChatConnectionStatus(peerId, 'Reconnecting...', 'bg-amber-500/10 text-amber-400 border-amber-500/30');
            clearTimeout(state.disconnectTimers[peerId]);
            state.disconnectTimers[peerId] = setTimeout(() => {
                if (connection.connectionState === 'disconnected') recoverPeerConnection(peerId, connection);
            }, 5000);
        } else if (status === 'closed') {
            cleanupPeerConnection(peerId, connection);
        }
    };
    return connection;
}

function cleanupPeerConnection(peerId, connection) {
    clearTimeout(state.disconnectTimers[peerId]);
    delete state.disconnectTimers[peerId];
    if (state.webrtcConnections[peerId] === connection) {
        delete state.webrtcConnections[peerId];
        delete state.dataChannels[peerId];
        delete state.sessionKeys[peerId];
        delete state.pendingIceCandidates[peerId];
    }
    if (connection.signalingState !== 'closed') connection.close();
}

function recoverPeerConnection(peerId, connection) {
    cleanupPeerConnection(peerId, connection);
    const retries = state.connectionRetryCounts[peerId] || 0;
    if ((state.secureMessageQueues[peerId]?.length || state.activeChatPeerId === peerId) && retries < 1) {
        state.connectionRetryCounts[peerId] = retries + 1;
        setTimeout(() => initiateP2PConnection(peerId).catch(() => {}), 1000);
    } else if (state.secureMessageQueues[peerId]?.length) {
        showToast('The secure P2P connection failed. Messages remain queued for retry.', 'error');
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
        return;
    }

    if (message.type === 'PEER_OFFLINE_FALLBACK') {
        updateChatConnectionStatus(message.targetPeerId, 'Peer unavailable', 'bg-amber-500/10 text-amber-400 border-amber-500/30');
        showToast('Peer is currently unavailable for a direct P2P connection.', 'warning');
        return;
    }
    if (message.type === 'SIGNALING_ERROR') {
        logDebug(`Signaling server rejected a message: ${message.message}`);
        return;
    }

    const peerId = message.senderNodeId;
    if (!peerId || peerId === state.myProfile.id) return;
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
                connection.setLocalDescription({ type: 'rollback' }),
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

function setupDataChannel(peerId, channel) {
    state.dataChannels[peerId] = channel;

    channel.onopen = () => {
        logDebug(`DataChannel opened with ${peerId}. Starting key handshake.`);
        updateChatConnectionStatus(peerId, 'Securing channel...', 'bg-sky-500/10 text-sky-400 border-sky-500/30');
        renderActivePeerList();
        channel.send(JSON.stringify({
            type: 'KEY_HELLO',
            publicKey: state.myKeys.jwkPublic
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

async function initiateP2PConnection(peerId) {
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
        showToast(`Could not start P2P connection: ${error.message}`, 'error');
        throw error;
    } finally {
        delete state.connectionAttempts[peerId];
    }
}

async function deriveSessionKey(peerId, publicJwk) {
    const publicKey = await window.crypto.subtle.importKey(
        'jwk',
        publicJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
    );
    state.sessionKeys[peerId] = await window.crypto.subtle.deriveKey(
        { name: 'ECDH', public: publicKey },
        state.myKeys.keyPair.privateKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
    updateChatConnectionStatus(peerId, 'E2EE connected', 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30');
    await flushSecureMessageQueue(peerId);
}

async function encryptSecurePayload(peerId, payload) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
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
        { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
        state.sessionKeys[peerId],
        base64ToBytes(envelope.ciphertext)
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
}

async function handleDataChannelMessage(peerId, rawMessage) {
    try {
        const message = JSON.parse(rawMessage);
        if (message.type === 'KEY_HELLO') {
            await deriveSessionKey(peerId, message.publicKey);
            return;
        }
        if (message.type !== 'SECURE_ENVELOPE' || !state.sessionKeys[peerId]) return;
        await handleSecurePayload(peerId, await decryptSecurePayload(peerId, message));
    } catch (error) {
        logDebug(`Rejected P2P message from ${peerId}: ${error.message}`);
    }
}

async function handleSecurePayload(peerId, payload) {
    if (payload.type === 'CHAT_MESSAGE') {
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
        await sendSecurePayload(peerId, {
            type: 'PROFILE_RESPONSE',
            profile: {
                id: state.myProfile.id,
                avatar: state.myProfile.avatar,
                fields: state.myProfile.fields,
                version: state.myProfile.version,
                updatedAt: state.myProfile.updatedAt
            }
        });
    } else if (payload.type === 'PROFILE_RESPONSE') {
        const peer = state.peers.find(candidate => candidate.id === peerId);
        const currentProfile = await cachePeerProfile(peerId, payload.profile);
        if (peer) {
            peer.fullProfile = currentProfile;
            peer.name = currentProfile.fields?.displayName || peer.name;
            peer.avatar = currentProfile.avatar || peer.avatar;
            await cacheGridPeer(peer);
            renderDiscoveryGrid();
        }
        if (state.activeModalPeerId === peerId) renderProfileModalData(currentProfile);
    }
}

async function sendSecurePayload(peerId, payload, onSent = null) {
    const channel = state.dataChannels[peerId];
    if (channel?.readyState === 'open' && state.sessionKeys[peerId]) {
        channel.send(JSON.stringify(await encryptSecurePayload(peerId, payload)));
        if (onSent) onSent();
        return true;
    }

    if (!state.secureMessageQueues[peerId]) state.secureMessageQueues[peerId] = [];
    state.secureMessageQueues[peerId].push({ payload, onSent });
    initiateP2PConnection(peerId).catch(() => {});
    return false;
}

async function flushSecureMessageQueue(peerId) {
    const queue = state.secureMessageQueues[peerId] || [];
    state.secureMessageQueues[peerId] = [];
    for (const item of queue) {
        await sendSecurePayload(peerId, item.payload, item.onSent);
    }
}
