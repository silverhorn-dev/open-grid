import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto, { createHash, randomBytes } from 'node:crypto';
import { createStore } from './database.js';
import { registerSignalingRoute } from './signaling.js';
import {
    GRID_PRECISION,
    MAX_GRID_RING,
    decodeGeohash,
    distanceBucket,
    distanceKm,
    gridRingCells,
    isGeohash
} from './geohash.js';

const MAX_GRID_RESULTS = 100;
import { MAX_PUSH_PLAINTEXT_BYTES, createPushSender, generateVapidKeys } from './push.js';

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(serverDirectory, '..');
// Feste Liste statt Verzeichnis-Scan: nur diese Dateien unter /client werden ausgeliefert.
const clientAssetFiles = [
    'crypto.client.js',
    'geohash.client.js',
    'grid.client.js',
    'p2p.client.js',
    'styles.css',
    'app/tailwind.config.js',
    'app/config.js',
    'app/storage.js',
    'app/profile.js',
    'app/chat.js',
    'app/viewer.js',
    'app/albums.js',
    'app/settings.js',
    'app/router.js',
    'app/push.js',
    'app/main.js'
];
const defaultSchema = [
    { key: 'displayName', label: 'Display Name', type: 'string', required: true, default: 'Alex' },
    { key: 'age', label: 'Age', type: 'number', min: 18, max: 99, default: 26 },
    { key: 'role', label: 'Position / Role', type: 'select', options: ['Top', 'Bottom', 'Versatile', 'Side'], default: 'Versatile' },
    { key: 'bio', label: 'About Me', type: 'description', default: 'Privacy-first tech enthusiast!' }
];

function parseProfileSchema(value) {
    if (!value) return defaultSchema;
    const schema = JSON.parse(value);
    if (!Array.isArray(schema) || schema.length === 0) {
        throw new Error('PROFILE_SCHEMA must be a non-empty JSON array.');
    }
    return schema;
}

function isString(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isPushSubscription(subscription) {
    if (!subscription || !isString(subscription.endpoint, 2048)) return false;
    if (!isString(subscription.keys?.p256dh, 200) || !isString(subscription.keys?.auth, 100)) return false;
    try {
        return new URL(subscription.endpoint).protocol === 'https:';
    } catch {
        return false;
    }
}

function loadVapidKeys(store) {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    }
    // Ohne feste Schluessel wuerden alle Browser-Subscriptions nach einem
    // Neustart ungueltig. Deshalb einmal erzeugen und in SQLite behalten.
    return JSON.parse(store.getOrCreateSetting('vapid-keys', () => JSON.stringify(generateVapidKeys())));
}

export async function buildApp(options = {}) {
    const app = Fastify({
        logger: options.logger ?? false,
        trustProxy: options.trustProxy ?? true,
        bodyLimit: 128 * 1024
    });
    const store = options.store || createStore(options.databasePath || process.env.DATABASE_PATH || join(projectDirectory, 'data', 'open-grid.sqlite'));

    // Fehlendes TURN faellt im Browser nur als "keine relay-Kandidaten" auf.
    // Deshalb beim Start klar benennen, dass die Variablen fehlen.
    if (!process.env.TURN_SECRET || !process.env.TURN_SERVER) {
        app.log.warn(
            'TURN ist deaktiviert: TURN_SECRET und/oder TURN_SERVER sind nicht gesetzt. '
            + 'Es werden ausschliesslich STUN-Kandidaten ausgeliefert.'
        );
    }
    const ownsStore = !options.store;
    const buildVersion = options.buildVersion || process.env.BUILD_VERSION || 'self-hosted';
    const buildTimestamp = options.buildTimestamp || process.env.BUILD_TIMESTAMP || new Date().toISOString();
    const assetVersion = encodeURIComponent(`${buildVersion}-${buildTimestamp}`);
    const profileSchema = options.profileSchema || parseProfileSchema(process.env.PROFILE_SCHEMA);
    const [indexTemplate, serviceWorker, ...clientAssetSources] = await Promise.all([
        readFile(join(projectDirectory, 'index.html'), 'utf8'),
        readFile(join(projectDirectory, 'client', 'sw.js'), 'utf8'),
        ...clientAssetFiles.map(file => readFile(join(projectDirectory, 'client', file), 'utf8'))
    ]);
    const vapidKeys = options.vapidKeys || loadVapidKeys(store);
    const vapidSubject = options.vapidSubject || process.env.VAPID_SUBJECT || 'mailto:admin@localhost';
    if (!options.pushSender && !process.env.VAPID_SUBJECT) {
        app.log.warn(
            'VAPID_SUBJECT ist nicht gesetzt. Einige Push-Dienste (z. B. Apple) lehnen '
            + 'den Standardwert ab. Setze eine erreichbare mailto:- oder https:-Adresse.'
        );
    }
    const sendPush = options.pushSender || createPushSender({
        vapidKeys,
        subject: vapidSubject,
        logger: app.log
    });
    const clientAssets = new Map(clientAssetFiles.map((file, index) => [`/client/${file}`, clientAssetSources[index]]));

    await app.register(websocket, {
        options: {
            maxPayload: 128 * 1024
        }
    });
    const signaling = registerSignalingRoute(app, store);

    app.addHook('onClose', async () => {
        if (ownsStore) store.close();
    });

    app.addHook('onRequest', async (request, reply) => {
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    });

    app.options('*', async (_request, reply) => reply.code(204).send());

    app.get('/health', async () => ({
        status: 'ok',
        version: buildVersion
    }));

    const serveAppShell = async (_request, reply) => {
        const html = indexTemplate
            .replaceAll('{{versionTag}}', buildVersion)
            .replaceAll('{{timestamp}}', buildTimestamp)
            .replaceAll('{{assetVersion}}', assetVersion)
            .replace('{{profileSchema}}', JSON.stringify(profileSchema));
        return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html);
    };
    // Client-Routen (client/app/router.js) liefern dieselbe App-Shell.
    for (const path of ['/', '/index.html', '/grid', '/chat', '/chat/:peerId', '/profile', '/settings', '/cloud']) {
        app.get(path, serveAppShell);
    }

    // Der Service Worker muss unter dem Wurzelpfad liegen, damit sein Scope
    // die ganze App abdeckt. no-cache sorgt dafuer, dass Updates erkannt werden.
    app.get('/sw.js', async (_request, reply) => {
        return reply
            .type('text/javascript; charset=utf-8')
            .header('Cache-Control', 'no-cache')
            .header('Service-Worker-Allowed', '/')
            .send(serviceWorker);
    });

    for (const [path, source] of clientAssets) {
        const contentType = path.endsWith('.css') ? 'text/css' : 'text/javascript';
        app.get(path, async (_request, reply) => {
            return reply
                .type(`${contentType}; charset=utf-8`)
                .header('Cache-Control', 'no-cache')
                .send(source);
        });
    }

    app.get('/api/ice-config', async (request, reply) => {
        const turnSecret = process.env.TURN_SECRET;
        const turnServer = process.env.TURN_SERVER;

        // Ohne Secret oder Host kann coturn keine Allocation autorisieren. Das
        // wird explizit gemeldet, damit der Client nicht faelschlich meldet, es
        // seien TURN-Credentials geladen worden.
        if (!turnSecret || !turnServer) {
            const missing = [
                turnSecret ? null : 'TURN_SECRET',
                turnServer ? null : 'TURN_SERVER'
            ].filter(Boolean);
            return {
                turnEnabled: false,
                reason: `Missing server configuration: ${missing.join(', ')}`,
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
            };
        }

        // Temporaere Credentials (Gueltig fuer 24 Stunden)
        const unixTimeStamp = Math.floor(Date.now() / 1000) + 24 * 3600;
        // Der Namensteil darf keine Doppelpunkte enthalten, sonst ist das
        // coturn-Schema "<ablaufzeit>:<name>" nicht mehr eindeutig zerlegbar
        // (IPv6-Adressen aus request.ip enthalten welche).
        const identity = String(request.ip || 'guest').replace(/:/g, '-');
        const username = `${unixTimeStamp}:${identity}`;
        const password = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');

        // Ohne expliziten transport-Parameter nutzt der Browser laut RFC 7065
        // ausschliesslich UDP. In Netzen, die UDP blockieren, gaebe es dann
        // keinen nutzbaren Relay-Pfad, deshalb die TCP-Variante.
        const turnPort = process.env.TURN_PORT || '3478';
        const turnUrls = [
            `turn:${turnServer}:${turnPort}?transport=udp`,
            `turn:${turnServer}:${turnPort}?transport=tcp`
        ];
        if (process.env.TURN_TLS_PORT) {
            turnUrls.push(`turns:${turnServer}:${process.env.TURN_TLS_PORT}?transport=tcp`);
        }

        return {
            turnEnabled: true,
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                {
                    urls: turnUrls,
                    username: username,
                    credential: password
                }
            ]
        };
    });

    function hashAuthToken(token) {
        return typeof token === 'string' && token.length >= 32
            ? createHash('sha256').update(token).digest('hex')
            : null;
    }

    function getBearerToken(request) {
        const authorization = request.headers.authorization;
        return typeof authorization === 'string' && authorization.startsWith('Bearer ')
            ? authorization.slice(7)
            : null;
    }

    function requirePeerAuth(request, reply, peerId) {
        const authHash = hashAuthToken(getBearerToken(request));
        if (!store.authenticatePeer(peerId, authHash)) {
            reply.code(401).send({ error: 'Peer authentication required' });
            return false;
        }
        return true;
    }

    function verifyRegistrationProof(peerId, registrationId, authToken, proof) {
        if (!proof?.publicKey || !isString(proof.signature, 512)) return false;
        try {
            const payload = JSON.stringify({ peerId, registrationId, authToken });
            const publicKey = crypto.createPublicKey({
                key: proof.publicKey,
                format: 'jwk'
            });
            return crypto.verify(
                'sha256',
                Buffer.from(payload),
                { key: publicKey, dsaEncoding: 'ieee-p1363' },
                Buffer.from(proof.signature, 'base64')
            );
        } catch {
            return false;
        }
    }

    app.post('/api/register', async (request, reply) => {
        const {
            peerId,
            geohash,
            registrationId,
            thumbnail,
            name,
            authToken: suppliedToken,
            registrationProof,
            silent,
            ttlMinutes
        } = request.body || {};
        if (!isString(peerId, 200) || !isGeohash(geohash, GRID_PRECISION) || !isString(registrationId, 200)) {
            return reply.code(400).send({ error: 'Invalid payload' });
        }
        if (thumbnail != null && typeof thumbnail !== 'string') {
            return reply.code(400).send({ error: 'Invalid thumbnail' });
        }
        if (suppliedToken != null && !hashAuthToken(suppliedToken)) {
            return reply.code(400).send({ error: 'Invalid authToken' });
        }
        if ((silent != null && typeof silent !== 'boolean')
            || (ttlMinutes != null && !Number.isFinite(ttlMinutes))) {
            return reply.code(400).send({ error: 'Invalid visibility settings' });
        }

        const authToken = suppliedToken != null
            ? suppliedToken
            : randomBytes(32).toString('base64url');
        const authHash = hashAuthToken(authToken);
        const existingTokenMatches = store.authenticatePeer(peerId, authHash);
        if (!existingTokenMatches && !verifyRegistrationProof(peerId, registrationId, authToken, registrationProof)) {
            return reply.code(400).send({ error: 'Invalid registration proof' });
        }
        const session = {
            peerId,
            registrationId,
            authHash,
            identityJwk: registrationProof?.publicKey
                ? JSON.stringify(registrationProof.publicKey)
                : null,
            // Der Router speichert nie mehr als eine Zelle mit Praezision 6 (~1,2 x 0,6 km).
            geohash: geohash.substring(0, GRID_PRECISION),
            thumbnail: thumbnail ? thumbnail.substring(0, 150000) : null,
            name: typeof name === 'string' ? name.substring(0, 100) : 'Peer',
            silent: silent === true,
            ttlMs: ttlMinutes != null ? ttlMinutes * 60 * 1000 : undefined
        };
        if (!store.registerPeer(session)) {
            return reply.code(403).send({ error: 'Peer identity is already registered' });
        }
        return {
            status: 'registered',
            geohash: session.geohash,
            peerId,
            authToken
        };
    });

    async function unregister(request, reply) {
        const payload = request.method === 'DELETE' ? request.query : request.body;
        const { peerId, registrationId, geohash } = payload || {};
        if (!isString(peerId, 200) || !isString(registrationId, 200)) {
            return reply.code(400).send({ error: 'Missing peerId or registrationId' });
        }
        if (!requirePeerAuth(request, reply, peerId)) return;
        const removed = store.unregisterPeer(peerId, registrationId, geohash || null);
        return { status: 'unregistered', peerId, removed };
    }

    app.delete('/api/register', unregister);
    app.post('/api/unregister', unregister);

    app.get('/api/grid', async (request, reply) => {
        const { geohash, live } = request.query || {};
        if (!isGeohash(geohash, GRID_PRECISION)) {
            return reply.code(400).send({ error: 'Missing geohash param' });
        }
        const ring = request.query.ring == null ? 0 : Number(request.query.ring);
        if (!Number.isInteger(ring) || ring < 0 || ring > MAX_GRID_RING) {
            return reply.code(400).send({ error: 'Invalid ring' });
        }
        const normalizedGeohash = geohash.substring(0, GRID_PRECISION);
        const origin = decodeGeohash(normalizedGeohash);
        const liveOnly = live === '1';
        const visible = peer => !liveOnly || signaling.isPeerOnline(peer.peerId);

        const grid = store.getGridArea(gridRingCells(normalizedGeohash, ring));
        // Entfernung nur zwischen Zellmittelpunkten; die Antwort enthaelt weder Koordinaten noch Geohash.
        const peers = grid.peers
            .filter(visible)
            .map(peer => ({ peer, km: distanceKm(origin, decodeGeohash(peer.geohash)) }))
            .sort((left, right) => left.km - right.km || left.peer.peerId.localeCompare(right.peer.peerId))
            .slice(0, MAX_GRID_RESULTS);
        const hasMore = ring < MAX_GRID_RING
            && store.getGridArea(gridRingCells(normalizedGeohash, ring + 1)).peers.filter(visible).length > grid.peers.filter(visible).length;
        return {
            geohash: normalizedGeohash,
            ring,
            count: peers.length,
            hasMore,
            peers: peers.map(({ peer, km }) => ({
                id: peer.peerId,
                avatar: peer.thumbnail,
                name: peer.name,
                distanceBucket: distanceBucket(km)
            })),
            removedPeerIds: grid.removedPeerIds
        };
    });

    async function notifyRecipient(message) {
        const subscription = store.getPushSubscription(message.recipientId);
        if (!subscription) return;
        const fullPayload = {
            type: 'PATH_C',
            msgId: message.msgId,
            senderId: message.senderId,
            ciphertextPayload: message.ciphertextPayload,
            ivHex: message.ivHex
        };
        // Grosse Payloads (z. B. Snaps) passen nicht in einen Push. Dann geht
        // nur der Hinweis raus und der Service Worker holt den Rest aus der Queue.
        const payload = Buffer.byteLength(JSON.stringify(fullPayload)) <= MAX_PUSH_PLAINTEXT_BYTES
            ? fullPayload
            : { type: 'PATH_C', msgId: message.msgId, senderId: message.senderId };
        try {
            const result = await sendPush(subscription, payload);
            if (result.expired) store.deletePushSubscription(message.recipientId, subscription.endpoint);
        } catch (error) {
            app.log.warn(`Web Push delivery failed: ${error.message}`);
        }
    }

    app.get('/api/push/vapid-public-key', async () => ({ publicKey: vapidKeys.publicKey }));

    app.post('/api/push/subscribe', async (request, reply) => {
        const { peerId, subscription } = request.body || {};
        if (!isString(peerId, 200)) {
            return reply.code(400).send({ error: 'Invalid peerId' });
        }
        if (!requirePeerAuth(request, reply, peerId)) return;
        if (!isPushSubscription(subscription)) {
            return reply.code(400).send({ error: 'Invalid push subscription' });
        }
        store.setPushSubscription(peerId, subscription);
        return reply.code(201).send({ status: 'subscribed', peerId });
    });

    app.delete('/api/push/subscribe/:peerId', async (request, reply) => {
        const { peerId } = request.params;
        if (!requirePeerAuth(request, reply, peerId)) return;
        const removed = store.deletePushSubscription(peerId);
        return { status: 'unsubscribed', peerId, removed };
    });

    app.post('/api/cache', async (request, reply) => {
        const { recipientId, senderId, ciphertextPayload, ivHex, ttlHours, notify } = request.body || {};
        if (!isString(recipientId, 200) || !isString(ciphertextPayload, 102400)) {
            return reply.code(400).send({ error: 'Missing or invalid parameters' });
        }
        if (!isString(senderId, 200)) {
            return reply.code(400).send({ error: 'Missing or invalid senderId' });
        }
        if (!requirePeerAuth(request, reply, senderId)) return;
        if (ivHex != null && typeof ivHex !== 'string') {
            return reply.code(400).send({ error: 'Invalid ivHex' });
        }
        if (store.isBlocked(recipientId, senderId)) {
            return reply.code(403).send({ error: 'Recipient does not accept messages from this sender' });
        }
        const message = store.enqueueMessage({
            recipientId,
            senderId: senderId?.substring(0, 200),
            ciphertextPayload,
            ivHex: ivHex?.substring(0, 200),
            ttlHours
        });
        // Der Push laeuft im Hintergrund, damit der Sender nicht auf den
        // Push-Dienst des Empfaengers warten muss.
        const pushRequested = notify === true && Boolean(store.getPushSubscription(recipientId));
        if (pushRequested) notifyRecipient(message);
        return reply.code(201).send({
            status: 'queued',
            msgId: message.msgId,
            expiresAt: message.expiresAt,
            pushRequested
        });
    });

    app.get('/api/cache/:recipientId', async (request, reply) => {
        const recipientId = request.params.recipientId;
        if (!requirePeerAuth(request, reply, recipientId)) return;
        const messages = store.getMessages(recipientId);
        return {
            recipientId,
            count: messages.length,
            messages
        };
    });

    app.delete('/api/cache/:msgId', async (request, reply) => {
        const { msgId } = request.params;
        const recipientId = store.getMessageRecipient(msgId);
        if (!recipientId) return reply.code(404).send({ error: 'Message not found' });
        if (!requirePeerAuth(request, reply, recipientId)) return;
        const removed = store.deleteMessage(msgId);
        return { status: 'deleted', msgId, removed };
    });

    app.get('/api/chat-controls/:ownerId', async (request, reply) => {
        const { ownerId } = request.params;
        if (!isString(ownerId, 200)) {
            return reply.code(400).send({ error: 'Invalid ownerId' });
        }
        if (!requirePeerAuth(request, reply, ownerId)) return;
        const controls = store.getChatControls(ownerId);
        return { ownerId, count: controls.length, controls };
    });

    app.post('/api/chat-controls', async (request, reply) => {
        const { ownerId, peerId, action } = request.body || {};
        if (!isString(ownerId, 200) || !isString(peerId, 200) || ownerId === peerId) {
            return reply.code(400).send({ error: 'Invalid ownerId or peerId' });
        }
        if (!requirePeerAuth(request, reply, ownerId)) return;
        if (!['DELETE_CHAT', 'BLOCK'].includes(action)) {
            return reply.code(400).send({ error: 'Invalid chat control action' });
        }
        const control = store.setChatControl(ownerId, peerId, action);
        return reply.code(201).send({ status: 'stored', control });
    });

    app.delete('/api/chat-controls/:ownerId/:peerId/block', async (request, reply) => {
        const { ownerId, peerId } = request.params;
        if (!isString(ownerId, 200) || !isString(peerId, 200)) {
            return reply.code(400).send({ error: 'Invalid ownerId or peerId' });
        }
        if (!requirePeerAuth(request, reply, ownerId)) return;
        const control = store.clearBlock(ownerId, peerId);
        return { status: 'unblocked', ownerId, peerId, control };
    });

    app.setNotFoundHandler(async (_request, reply) => {
        return reply.code(404).type('text/plain').send('OpenGrid API Active - Route Not Found.');
    });

    return app;
}
