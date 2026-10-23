import { createHash } from 'node:crypto';

const MAX_PRESENCE_SUBSCRIPTIONS = 500;

export function registerSignalingRoute(app, store) {
    const activeSockets = new Map();
    // Grid-Zelle pro verbundenem Peer, im Speicher indiziert: PEER_OFFLINE erreicht so nur die
    // Peers der eigenen Zelle, ohne bei jedem Verbindungsende alle Sockets abzufragen.
    const peerCells = new Map();
    const cellMembers = new Map();
    // Presence fuer Chat-Partner: wer wen beobachten moechte (sichtbar nur gegenseitig).
    const subscriptions = new Map();

    const isOnline = (peerId) => activeSockets.get(peerId)?.readyState === 1;

    const send = (peerId, message) => {
        if (isOnline(peerId)) activeSockets.get(peerId).send(JSON.stringify(message));
    };

    const removeFromCell = (peerId) => {
        const cell = peerCells.get(peerId);
        if (!cell) return;
        peerCells.delete(peerId);
        const members = cellMembers.get(cell.geohash);
        members?.delete(peerId);
        if (members && !members.size) cellMembers.delete(cell.geohash);
    };

    const setPeerCell = (peerId, geohash, silent) => {
        removeFromCell(peerId);
        if (!geohash) return;
        peerCells.set(peerId, { geohash, silent: Boolean(silent) });
        if (!cellMembers.has(geohash)) cellMembers.set(geohash, new Set());
        cellMembers.get(geohash).add(peerId);
    };

    // Gegenseitig abonniert und keiner hat den anderen blockiert.
    const canSeePresence = (viewerId, targetId) => {
        if (!subscriptions.get(viewerId)?.has(targetId) || !subscriptions.get(targetId)?.has(viewerId)) return false;
        try {
            return !store.isBlocked(targetId, viewerId) && !store.isBlocked(viewerId, targetId);
        } catch {
            // Beim Herunterfahren kann der Store bereits geschlossen sein.
            return false;
        }
    };

    const notifyPresence = (peerId, online) => {
        for (const watcherId of subscriptions.get(peerId) || []) {
            if (isOnline(watcherId) && canSeePresence(watcherId, peerId)) {
                send(watcherId, { type: 'PRESENCE', peerId, online });
            }
        }
    };

    const handlePresenceSubscribe = (peerId, peerIds) => {
        const targets = new Set((Array.isArray(peerIds) ? peerIds : [])
            .filter(id => typeof id === 'string' && id !== peerId)
            .slice(0, MAX_PRESENCE_SUBSCRIPTIONS)
            .map(id => id.substring(0, 200)));
        subscriptions.set(peerId, targets);
        const online = [...targets].filter(targetId => isOnline(targetId) && canSeePresence(peerId, targetId));
        send(peerId, { type: 'PRESENCE_SNAPSHOT', online });
        // Wer jetzt gegenseitig sichtbar ist, erfaehrt, dass dieser Peer online ist.
        online.forEach(targetId => send(targetId, { type: 'PRESENCE', peerId, online: true }));
    };

    const notifyPeerOffline = (peerId) => {
        const cell = peerCells.get(peerId);
        removeFromCell(peerId);
        if (!cell || cell.silent) return;
        for (const memberId of cellMembers.get(cell.geohash) || []) {
            send(memberId, { type: 'PEER_OFFLINE', peerId });
        }
    };

    app.get('/ws', { websocket: true }, (socket) => {
        let currentPeerId = null;

        socket.on('message', rawMessage => {
            try {
                const data = JSON.parse(rawMessage.toString());

                if (data.type === 'REGISTER_SOCKET' && typeof data.peerId === 'string' && typeof data.authToken === 'string') {
                    const peerId = data.peerId.substring(0, 200);
                    const authHash = createHash('sha256').update(data.authToken).digest('hex');
                    if (!store.authenticatePeer(peerId, authHash)) {
                        socket.send(JSON.stringify({ type: 'SIGNALING_ERROR', message: 'Peer authentication failed' }));
                        socket.close(1008, 'Peer authentication failed');
                        return;
                    }
                    const previousSocket = activeSockets.get(peerId);
                    if (previousSocket && previousSocket !== socket) {
                        previousSocket.close(1000, 'Replaced by a newer connection');
                    }
                    currentPeerId = peerId;
                    activeSockets.set(peerId, socket);
                    setPeerCell(peerId, store.getPeerGeohash(peerId), !store.isPeerPublic(peerId));
                    socket.send(JSON.stringify({ type: 'SOCKET_REGISTERED', peerId }));
                    return;
                }

                if (data.type === 'PRESENCE_SUBSCRIBE') {
                    if (currentPeerId) handlePresenceSubscribe(currentPeerId, data.peerIds);
                    return;
                }

                if (!currentPeerId || !data.targetPeerId || typeof data.targetPeerId !== 'string') return;
                const targetSocket = activeSockets.get(data.targetPeerId);
                if (targetSocket?.readyState === 1) {
                    targetSocket.send(JSON.stringify({
                        ...data,
                        senderNodeId: currentPeerId
                    }));
                } else {
                    socket.send(JSON.stringify({
                        type: 'PEER_OFFLINE_FALLBACK',
                        targetPeerId: data.targetPeerId,
                        originalMessageType: data.type
                    }));
                }
            } catch {
                socket.send(JSON.stringify({
                    type: 'SIGNALING_ERROR',
                    message: 'Invalid signaling payload'
                }));
            }
        });

        const removeSocket = () => {
            if (!currentPeerId || activeSockets.get(currentPeerId) !== socket) return;
            // Erst austragen, dann benachrichtigen: der Peer gilt ab jetzt als offline.
            activeSockets.delete(currentPeerId);
            notifyPresence(currentPeerId, false);
            subscriptions.delete(currentPeerId);
            notifyPeerOffline(currentPeerId);
        };
        socket.on('close', removeSocket);
        socket.on('error', removeSocket);
    });

    return {
        isPeerOnline: isOnline,
        // Gegenseitige, nicht blockierte Kontakte, die gerade online sind (Freunde-Grid).
        getMutualContacts(peerId) {
            return [...(subscriptions.get(peerId) || [])].filter(targetId => isOnline(targetId) && canSeePresence(peerId, targetId));
        },
        // Vom Register-Endpunkt: Zelle oder Silent-Modus haben sich geaendert.
        updatePeerCell(peerId, geohash, silent) {
            if (activeSockets.has(peerId)) setPeerCell(peerId, geohash, silent);
        }
    };
}
