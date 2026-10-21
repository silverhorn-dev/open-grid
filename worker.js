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
const removedPeers = new Map();

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
            if (env.SIGNALING_HUB) {
                const hubId = env.SIGNALING_HUB.idFromName('opengrid-global-signaling');
                return env.SIGNALING_HUB.get(hubId).fetch(request);
            }
            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);
            handleWebSocketSession(server, url);
            return new Response(null, { status: 101, webSocket: client });
        }

        if (path === '/api/register' && request.method === 'POST') {
            try {
                const body = await request.json();
                const { peerId, geohash, registrationId, thumbnail, name } = body;

                if (!peerId || typeof peerId !== 'string' || !geohash || typeof geohash !== 'string' || !registrationId || typeof registrationId !== 'string') {
                    return new Response(JSON.stringify({ error: 'Invalid payload' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
                }

                const session = {
                    peerId,
                    registrationId,
                    geohash: geohash.substring(0, 10),
                    thumbnail: thumbnail ? String(thumbnail).substring(0, 50000) : null,
                    name: typeof name === 'string' ? name.substring(0, 100) : 'Peer'
                };
                await storePeerRegistration(env, session);

                return new Response(JSON.stringify({ status: 'registered', geohash, peerId }), {
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            } catch (err) {
                return new Response(JSON.stringify({ error: 'Malformed JSON' }), { status: 400, headers: corsHeaders });
            }
        }

        if ((path === '/api/register' && request.method === 'DELETE') || (path === '/api/unregister' && request.method === 'POST')) {
            try {
                const body = path === '/api/register' ? null : await request.json();
                const peerId = path === '/api/register' ? url.searchParams.get('peerId') : body.peerId;
                const registrationId = path === '/api/register' ? url.searchParams.get('registrationId') : body.registrationId;
                const geohash = path === '/api/register' ? url.searchParams.get('geohash') : body.geohash;

                if (!peerId || typeof peerId !== 'string' || !registrationId || typeof registrationId !== 'string') {
                    return new Response(JSON.stringify({ error: 'Missing peerId or registrationId' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
                }

                const removed = await removePeerRegistration(env, peerId, registrationId, geohash);
                return new Response(JSON.stringify({ status: 'unregistered', peerId, removed }), {
                    headers: { 'Content-Type': 'application/json', ...corsHeaders }
                });
            } catch (err) {
                return new Response(JSON.stringify({ error: 'Malformed JSON' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }
        }

        if (path === '/api/grid' && request.method === 'GET') {
            const geohash = url.searchParams.get('geohash');
            if (!geohash) {
                return new Response(JSON.stringify({ error: 'Missing geohash param' }), { status: 400, headers: corsHeaders });
            }

            const sessions = await getPeerRegistrations(env, geohash);
            const peers = sessions.map(session => ({
                id: session.peerId,
                geohash: session.geohash,
                avatar: session.thumbnail,
                name: session.name,
                online: session.online
            }));
            const activePeerIds = new Set(peers.map(peer => peer.id));
            const removedPeerIds = (await getRemovedPeerIds(env, geohash)).filter(peerId => !activePeerIds.has(peerId));

            return new Response(JSON.stringify({ geohash, count: peers.length, peers, removedPeerIds }), {
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
                { key: 'displayName', label: 'Display Name', type: 'string', required: true, default: 'Alex' },
                { key: 'age', label: 'Age', type: 'number', min: 18, max: 99, default: 26 },
                { key: 'role', label: 'Position / Role', type: 'select', options: ['Top', 'Bottom', 'Versatile', 'Side'], default: 'Versatile' },
                { key: 'bio', label: 'About Me', type: 'description', default: 'Privacy-first tech enthusiast!' }
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

async function storePeerRegistration(env, session) {
    if (env.OPENGRID_KV) {
        const previousGeohash = await env.OPENGRID_KV.get(`peer:${session.peerId}`);
        if (previousGeohash && previousGeohash !== session.geohash) {
            await Promise.all([
                env.OPENGRID_KV.delete(`grid:${previousGeohash}:${session.peerId}`),
                env.OPENGRID_KV.put(`removed:${previousGeohash}:${session.peerId}`, String(Date.now()), { expirationTtl: 2592000 })
            ]);
        }
        const gridRecord = {
            name: session.name,
            thumbnail: session.thumbnail
        };
        const presenceRecord = {
            registrationId: session.registrationId,
            lastSeen: Date.now()
        };
        await Promise.all([
            env.OPENGRID_KV.put(`grid:${session.geohash}:${session.peerId}`, JSON.stringify(gridRecord), { expirationTtl: 2592000 }),
            env.OPENGRID_KV.put(`peer:${session.peerId}`, session.geohash, { expirationTtl: 600 }),
            env.OPENGRID_KV.put(`presence:${session.peerId}`, JSON.stringify(presenceRecord), { expirationTtl: 600 }),
            env.OPENGRID_KV.delete(`removed:${session.geohash}:${session.peerId}`)
        ]);
        return;
    }

    removePeerFromMemoryGrid(session.peerId);
    session.lastSeen = Date.now();
    session.online = true;
    removedPeers.get(session.geohash)?.delete(session.peerId);
    if (!spatialGrid.has(session.geohash)) spatialGrid.set(session.geohash, new Map());
    spatialGrid.get(session.geohash).set(session.peerId, session);
}

async function getPeerRegistrations(env, geohash) {
    if (env.OPENGRID_KV) {
        const entries = await env.OPENGRID_KV.list({ prefix: `grid:${geohash}:`, limit: 1000 });
        const sessions = await Promise.all(entries.keys.map(async (key) => {
            const record = await env.OPENGRID_KV.get(key.name, 'json');
            if (!record) return null;
            const peerId = key.name.substring(`grid:${geohash}:`.length);
            const presence = await env.OPENGRID_KV.get(`presence:${peerId}`, 'json');
            return {
                peerId,
                geohash,
                online: Boolean(presence && Date.now() - presence.lastSeen < 45000),
                ...record
            };
        }));
        return sessions.filter(Boolean);
    }

    const cellMap = spatialGrid.get(geohash);
    if (!cellMap) return [];
    const now = Date.now();
    return Array.from(cellMap.values(), session => ({
        ...session,
        online: now - session.lastSeen < 45000
    }));
}

async function getRemovedPeerIds(env, geohash) {
    if (!env.OPENGRID_KV) return Array.from(removedPeers.get(geohash) || []);
    const prefix = `removed:${geohash}:`;
    const entries = await env.OPENGRID_KV.list({ prefix, limit: 1000 });
    return entries.keys.map(key => key.name.substring(prefix.length));
}

async function removePeerRegistration(env, peerId, registrationId, geohash = null) {
    if (env.OPENGRID_KV) {
        const registeredGeohash = geohash || await env.OPENGRID_KV.get(`peer:${peerId}`);
        if (!registeredGeohash) return 0;

        const key = `grid:${registeredGeohash}:${peerId}`;
        const presence = await env.OPENGRID_KV.get(`presence:${peerId}`, 'json');
        if (!presence || presence.registrationId !== registrationId) return 0;

        await Promise.all([
            env.OPENGRID_KV.delete(key),
            env.OPENGRID_KV.delete(`peer:${peerId}`),
            env.OPENGRID_KV.delete(`presence:${peerId}`),
            env.OPENGRID_KV.put(`removed:${registeredGeohash}:${peerId}`, String(Date.now()), { expirationTtl: 2592000 })
        ]);
        return 1;
    }

    const removed = removePeerFromMemoryGrid(peerId, geohash, registrationId);
    if (removed && geohash) {
        if (!removedPeers.has(geohash)) removedPeers.set(geohash, new Set());
        removedPeers.get(geohash).add(peerId);
    }
    return removed;
}

function removePeerFromMemoryGrid(peerId, geohash = null, registrationId = null) {
    let removed = 0;
    const cells = geohash ? [[geohash, spatialGrid.get(geohash)]] : spatialGrid.entries();

    for (const [cellGeohash, cellMap] of cells) {
        const session = cellMap?.get(peerId);
        if (!session || (registrationId && session.registrationId !== registrationId)) continue;
        cellMap.delete(peerId);
        removed += 1;
        if (cellMap.size === 0) spatialGrid.delete(cellGeohash);
    }

    return removed;
}

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