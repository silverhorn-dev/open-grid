/**
 * OpenGrid Cloudflare Worker entry point.
 *
 * HTTP routing and app-shell delivery live here. Grid persistence and
 * WebRTC signaling are implemented in dedicated server modules.
 */

// Ephemeral Store-and-Forward Send-Cache
const cloudCache = new Map();

import index from "./index.html";
import gridClient from "./client/grid.client.js";
import p2pClient from "./client/p2p.client.js";
import {
    getPeerRegistrations,
    getRemovedPeerIds,
    removePeerRegistration,
    storePeerRegistration
} from "./server/grid-store.js";
import { handleWebSocketSession, SignalingHub } from "./server/signaling.js";

const clientScripts = new Map([
    ['/client/grid.client.js', gridClient],
    ['/client/p2p.client.js', p2pClient]
]);

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
            handleWebSocketSession(server);
            return new Response(null, { status: 101, webSocket: client });
        }

        if (request.method === 'GET' && clientScripts.has(path)) {
            return new Response(clientScripts.get(path), {
                headers: {
                    'Content-Type': 'text/javascript;charset=UTF-8',
                    'Cache-Control': 'no-cache'
                }
            });
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
                name: session.name
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

export { SignalingHub };
