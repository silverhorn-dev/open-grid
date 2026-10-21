/**
 * OpenGrid Cloudflare Worker Server (Hardened for Live Scenario)
 *
 * Functions:
 * 1. Serves PWA App Shell (via ES Module HTML Import & Template Injection)
 * 2. Geohash Spatial Grid Indexing (In-Memory)
 * 3. Ephemeral Store-and-Forward Cloud Send-Cache (24h TTL)
 * 4. WebSocket WebRTC Signaling Relay
 */

// In-Memory Geohash Spatial Index
const spatialGrid = new Map();

// Ephemeral Store-and-Forward Send-Cache
const cloudCache = new Map();

// Active WebSocket Signaling Connections
const activeSockets = new Map();

import index from "./index.html";

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Access-Control-Max-Age': '86400'
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders, status: 204 });
        }

        if (path === '/ws') {
            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response('Expected WebSocket upgrade', { status: 426, headers: corsHeaders });
            }
            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);
            handleWebSocketSession(server, url);
            return new Response(null, { status: 101, webSocket: client });
        }

        if (path === '/api/register' && request.method === 'POST') {
            try {
                const body = await request.json();
                const { peerId, geohash, thumbnail, publicEncKey, fields } = body;

                if (!peerId || typeof peerId !== 'string' || !geohash || typeof geohash !== 'string') {
                    return new Response(JSON.stringify({ error: 'Invalid payload' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
                }

                if (!spatialGrid.has(geohash)) {
                    spatialGrid.set(geohash, new Map());
                }

                spatialGrid.get(geohash).set(peerId, {
                    peerId,
                    geohash: geohash.substring(0, 10),
                    thumbnail: thumbnail ? String(thumbnail).substring(0, 50000) : null,
                    publicEncKey: publicEncKey || null,
                    fields: fields || {},
                    lastSeen: Date.now()
                });

                return new Response(JSON.stringify({ status: 'registered', geohash, peerId }), {
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            } catch (err) {
                return new Response(JSON.stringify({ error: 'Malformed JSON' }), { status: 400, headers: corsHeaders });
            }
        }

        if (path === '/api/grid' && request.method === 'GET') {
            const geohash = url.searchParams.get('geohash');
            if (!geohash) {
                return new Response(JSON.stringify({ error: 'Missing geohash param' }), { status: 400, headers: corsHeaders });
            }

            const cellMap = spatialGrid.get(geohash);
            const peers = [];

            if (cellMap) {
                const now = Date.now();
                for (const [peerId, session] of cellMap.entries()) {
                    if (now - session.lastSeen < 600000) {
                        peers.push({
                            id: session.peerId,
                            geohash: session.geohash,
                            avatar: session.thumbnail,
                            publicEncKey: session.publicEncKey,
                            fields: session.fields,
                            online: activeSockets.has(session.peerId)
                        });
                    } else {
                        cellMap.delete(peerId);
                    }
                }
            }

            return new Response(JSON.stringify({ geohash, count: peers.length, peers }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        if (path === '/api/cache' && request.method === 'POST') {
            try {
                const body = await request.json();
                const { recipientId, senderId, ciphertextPayload, ivHex, ttlHours } = body;

                if (!recipientId || !ciphertextPayload) {
                    return new Response(JSON.stringify({ error: 'Missing parameters' }), { status: 400, headers: corsHeaders });
                }

                if (!cloudCache.has(recipientId)) {
                    cloudCache.set(recipientId, []);
                }

                const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
                const safeTtl = Math.min(Number(ttlHours) || 24, 72);
                const expiresAt = Date.now() + (safeTtl * 3600 * 1000);

                cloudCache.get(recipientId).push({
                    msgId,
                    senderId,
                    ciphertextPayload: String(ciphertextPayload).substring(0, 102400),
                    ivHex,
                    expiresAt
                });

                return new Response(JSON.stringify({ status: 'queued', msgId, expiresAt }), {
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            } catch (err) {
                return new Response(JSON.stringify({ error: 'Internal Error' }), { status: 500, headers: corsHeaders });
            }
        }

        if (path.startsWith('/api/cache/') && request.method === 'GET') {
            const recipientId = path.split('/')[3];
            const messages = cloudCache.get(recipientId) || [];
            const now = Date.now();

            const valid = messages.filter(m => m.expiresAt > now);
            if (valid.length !== messages.length) cloudCache.set(recipientId, valid);

            return new Response(JSON.stringify({ recipientId, count: valid.length, messages: valid }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        if (path.startsWith('/api/cache/') && request.method === 'DELETE') {
            const msgId = path.split('/')[3];
            for (const [recipientId, msgs] of cloudCache.entries()) {
                const filtered = msgs.filter(m => m.msgId !== msgId);
                cloudCache.set(recipientId, filtered);
            }
            return new Response(JSON.stringify({ status: 'deleted', msgId }), {
                headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
        }

        if (path === '/' || path === '/index.html') {
            const metadata = env.METADATA || { id: "dev-build", timestamp: new Date().toISOString() };

            // Fallback for schema just in case the env var isn't bound properly yet
            const defaultSchema = [
                { key: 'displayName', label: 'Display Name', type: 'string', required: true, default: 'Local User' }
            ];
            const schemaToInject = env.PROFILE_SCHEMA || defaultSchema;

            const injectedHtml = index
                .replace("{{versionTag}}", metadata.id)
                .replace("{{timestamp}}", metadata.timestamp)
                .replace("{{profileSchema}}", JSON.stringify(schemaToInject));

            return new Response(injectedHtml, {
                headers: { 'content-type': 'text/html;charset=UTF-8' },
            });
        }

        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response('OpenGrid API Active - Route Not Found.', {
            status: 404,
            headers: { 'Content-Type': 'text/plain', ...corsHeaders }
        });
    }
};

function handleWebSocketSession(webSocket, url) {
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
        } catch (err) {
            console.error('WS Payload Error', err);
        }
    });

    webSocket.addEventListener('close', () => {
        if (currentPeerId) activeSockets.delete(currentPeerId);
    });

    webSocket.addEventListener('error', () => {
        if (currentPeerId) activeSockets.delete(currentPeerId);
    });
}