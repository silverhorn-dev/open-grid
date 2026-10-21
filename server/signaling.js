export function registerSignalingRoute(app) {
    const activeSockets = new Map();

    app.get('/ws', { websocket: true }, (socket) => {
        let currentPeerId = null;

        socket.on('message', rawMessage => {
            try {
                const data = JSON.parse(rawMessage.toString());

                if (data.type === 'REGISTER_SOCKET' && typeof data.peerId === 'string') {
                    const peerId = data.peerId.substring(0, 200);
                    const previousSocket = activeSockets.get(peerId);
                    if (previousSocket && previousSocket !== socket) {
                        previousSocket.close(1000, 'Replaced by a newer connection');
                    }
                    currentPeerId = peerId;
                    activeSockets.set(peerId, socket);
                    socket.send(JSON.stringify({ type: 'SOCKET_REGISTERED', peerId }));
                    return;
                }

                if (!data.targetPeerId || typeof data.targetPeerId !== 'string') return;
                const targetSocket = activeSockets.get(data.targetPeerId);
                if (targetSocket?.readyState === 1) {
                    targetSocket.send(JSON.stringify(data));
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
            if (currentPeerId && activeSockets.get(currentPeerId) === socket) {
                activeSockets.delete(currentPeerId);
            }
        };
        socket.on('close', removeSocket);
        socket.on('error', removeSocket);
    });
}
