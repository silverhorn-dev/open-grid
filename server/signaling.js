import { createHash } from 'node:crypto';

const MAX_PRESENCE_SUBSCRIPTIONS = 500;

// Heartbeat: halb offene Verbindungen (Smartphone im Hintergrund, WLAN-Wechsel) erkennen. Wer auf
// einen Ping bis zum naechsten nicht antwortet, wird getrennt; Signaling an ihn bekommt dann sofort
// PEER_OFFLINE_FALLBACK statt ins Leere zu laufen.
export const HEARTBEAT_INTERVAL_MS = 30000;

export function registerSignalingRoute(app, store, { messageLimiter = null, heartbeatMs = HEARTBEAT_INTERVAL_MS } = {}) {
    const activeSockets = new Map();
    const allSockets = new Set();
    const heartbeat = setInterval(() => {
        for (const socket of allSockets) {
            if (socket.isAlive === false) {
                socket.terminate();
                continue;
            }
            socket.isAlive = false;
            try {
                socket.ping();
            } catch {
                socket.terminate();
            }
        }
    }, heartbeatMs);
    heartbeat.unref?.();
    app.addHook('onClose', async () => clearInterval(heartbeat));
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

    // "Abwesend": App/Tab verbunden, aber nicht sichtbar (vom Client per PRESENCE_AWAY gemeldet).
    // `away` steht nur in der Meldung, wenn es gilt oder sich gerade aendert.
    const awayPeers = new Set();
    const presenceMessage = (peerId, online, awayChanged = false) => {
        const away = online && awayPeers.has(peerId);
        return away || awayChanged ? { type: 'PRESENCE', peerId, online, away } : { type: 'PRESENCE', peerId, online };
    };

    const notifyPresence = (peerId, online, awayChanged = false) => {
        for (const watcherId of subscriptions.get(peerId) || []) {
            if (isOnline(watcherId) && canSeePresence(watcherId, peerId)) {
                send(watcherId, presenceMessage(peerId, online, awayChanged));
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
        send(peerId, { type: 'PRESENCE_SNAPSHOT', online, away: online.filter(targetId => awayPeers.has(targetId)) });
        // Wer jetzt gegenseitig sichtbar ist, erfaehrt, dass dieser Peer online ist.
        online.forEach(targetId => send(targetId, presenceMessage(peerId, true)));
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
        socket.isAlive = true;
        allSockets.add(socket);
        socket.on('pong', () => {
            socket.isAlive = true;
        });
        const limiter = messageLimiter?.();
        let warned = false;

        socket.on('message', rawMessage => {
            // Pro Verbindung begrenzt: zu viele Nachrichten werden verworfen.
            if (limiter && limiter.take('socket') !== true) {
                if (!warned) socket.send(JSON.stringify({ type: 'SIGNALING_ERROR', message: 'Rate limit exceeded' }));
                warned = true;
                return;
            }
            warned = false;
            try {
                const data = JSON.parse(rawMessage.toString());
                socket.isAlive = true;
                // Anwendungs-Ping des Clients (Browser koennen keine WebSocket-Pings senden).
                if (data.type === 'PING') {
                    socket.send(JSON.stringify({ type: 'PONG', nonce: typeof data.nonce === 'string' ? data.nonce.substring(0, 40) : null }));
                    return;
                }

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

                if (data.type === 'PRESENCE_AWAY') {
                    if (!currentPeerId) return;
                    const away = data.away === true;
                    if (away === awayPeers.has(currentPeerId)) return;
                    if (away) awayPeers.add(currentPeerId);
                    else awayPeers.delete(currentPeerId);
                    notifyPresence(currentPeerId, true, true);
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
            awayPeers.delete(currentPeerId);
            notifyPresence(currentPeerId, false);
            subscriptions.delete(currentPeerId);
            notifyPeerOffline(currentPeerId);
        };
        socket.on('close', () => {
            allSockets.delete(socket);
            removeSocket();
        });
        socket.on('error', removeSocket);
    });

    return {
        isPeerOnline: isOnline,
        // Nach dem Loeschen eines Profils: offene Verbindung schliessen (Abmeldung wie beim Trennen).
        disconnectPeer(peerId) {
            activeSockets.get(peerId)?.close();
        },
        isPeerAway: peerId => isOnline(peerId) && awayPeers.has(peerId),
        // Gegenseitige, nicht blockierte Kontakte, die gerade online sind (Freunde-Grid).
        getMutualContacts(peerId) {
            return [...(subscriptions.get(peerId) || [])].filter(targetId => isOnline(targetId) && canSeePresence(peerId, targetId));
        },
        // Neue Nachricht im Zwischenspeicher: ein online Empfaenger holt sie sofort ab (ohne Inhalt,
        // nur der Hinweis). Sonst laege sie bis zum naechsten Verbinden oder einem Web Push dort.
        notifyCacheWaiting(peerId) {
            if (isOnline(peerId)) send(peerId, { type: 'CACHE_WAITING' });
        },
        // Vom Register-Endpunkt: Zelle oder Silent-Modus haben sich geaendert.
        updatePeerCell(peerId, geohash, silent) {
            if (activeSockets.has(peerId)) setPeerCell(peerId, geohash, silent);
        }
    };
}
