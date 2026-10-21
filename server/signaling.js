const activeSockets = new Map();

export function handleWebSocketSession(webSocket) {
    webSocket.accept();
    let currentPeerId = null;

    webSocket.addEventListener('message', async (event) => {
        try {
            const data = JSON.parse(event.data);

            if (data.type === 'REGISTER_SOCKET') {
                currentPeerId = data.peerId;
                activeSockets.set(currentPeerId, webSocket);
                webSocket.send(JSON.stringify({ type: 'SOCKET_REGISTERED', peerId: currentPeerId }));
                return;
            }

            if (data.targetPeerId) {
                if (activeSockets.has(data.targetPeerId)) {
                    const targetSocket = activeSockets.get(data.targetPeerId);
                    targetSocket.send(JSON.stringify(data));
                } else {
                    webSocket.send(JSON.stringify({
                        type: 'PEER_OFFLINE_FALLBACK',
                        targetPeerId: data.targetPeerId,
                        originalMessageType: data.type
                    }));
                }
            }
        } catch (error) {
            console.error('WS Payload Error', error);
        }
    });

    webSocket.addEventListener('close', () => {
        if (currentPeerId && activeSockets.get(currentPeerId) === webSocket) activeSockets.delete(currentPeerId);
    });

    webSocket.addEventListener('error', () => {
        if (currentPeerId && activeSockets.get(currentPeerId) === webSocket) activeSockets.delete(currentPeerId);
    });
}

export class SignalingHub {
    constructor(state) {
        this.state = state;
    }

    async fetch(request) {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('Expected WebSocket upgrade', { status: 426 });
        }

        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.serializeAttachment({ peerId: null });
        this.state.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
    }

    webSocketMessage(webSocket, message) {
        try {
            const data = JSON.parse(message);
            if (data.type === 'REGISTER_SOCKET' && typeof data.peerId === 'string') {
                for (const socket of this.state.getWebSockets()) {
                    if (socket !== webSocket && socket.deserializeAttachment()?.peerId === data.peerId) {
                        socket.close(1000, 'Replaced by a newer connection');
                    }
                }
                webSocket.serializeAttachment({ peerId: data.peerId });
                webSocket.send(JSON.stringify({ type: 'SOCKET_REGISTERED', peerId: data.peerId }));
                return;
            }

            if (!data.targetPeerId) return;
            const targetSocket = this.state.getWebSockets().find(socket => {
                return socket.deserializeAttachment()?.peerId === data.targetPeerId;
            });
            if (targetSocket) {
                targetSocket.send(JSON.stringify(data));
            } else {
                webSocket.send(JSON.stringify({
                    type: 'PEER_OFFLINE_FALLBACK',
                    targetPeerId: data.targetPeerId,
                    originalMessageType: data.type
                }));
            }
        } catch (error) {
            webSocket.send(JSON.stringify({ type: 'SIGNALING_ERROR', message: 'Invalid signaling payload' }));
        }
    }

    webSocketClose() {}

    webSocketError() {}
}
