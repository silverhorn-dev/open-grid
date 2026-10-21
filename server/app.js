import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './database.js';
import { registerSignalingRoute } from './signaling.js';

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(serverDirectory, '..');
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

export async function buildApp(options = {}) {
    const app = Fastify({
        logger: options.logger ?? false,
        trustProxy: options.trustProxy ?? true,
        bodyLimit: 128 * 1024
    });
    const store = options.store || createStore(options.databasePath || process.env.DATABASE_PATH || join(projectDirectory, 'data', 'open-grid.sqlite'));
    const ownsStore = !options.store;
    const buildVersion = options.buildVersion || process.env.BUILD_VERSION || 'self-hosted';
    const buildTimestamp = options.buildTimestamp || process.env.BUILD_TIMESTAMP || new Date().toISOString();
    const profileSchema = options.profileSchema || parseProfileSchema(process.env.PROFILE_SCHEMA);
    const [indexTemplate, cryptoClient, gridClient, p2pClient] = await Promise.all([
        readFile(join(projectDirectory, 'index.html'), 'utf8'),
        readFile(join(projectDirectory, 'client', 'crypto.client.js'), 'utf8'),
        readFile(join(projectDirectory, 'client', 'grid.client.js'), 'utf8'),
        readFile(join(projectDirectory, 'client', 'p2p.client.js'), 'utf8')
    ]);
    const clientScripts = new Map([
        ['/client/crypto.client.js', cryptoClient],
        ['/client/grid.client.js', gridClient],
        ['/client/p2p.client.js', p2pClient]
    ]);

    await app.register(websocket, {
        options: {
            maxPayload: 128 * 1024
        }
    });
    registerSignalingRoute(app);

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

    app.get('/', async (_request, reply) => {
        const html = indexTemplate
            .replace('{{versionTag}}', buildVersion)
            .replace('{{timestamp}}', buildTimestamp)
            .replace('{{profileSchema}}', JSON.stringify(profileSchema));
        return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html);
    });
    app.get('/index.html', async (_request, reply) => {
        const html = indexTemplate
            .replace('{{versionTag}}', buildVersion)
            .replace('{{timestamp}}', buildTimestamp)
            .replace('{{profileSchema}}', JSON.stringify(profileSchema));
        return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html);
    });

    for (const [path, source] of clientScripts) {
        app.get(path, async (_request, reply) => {
            return reply
                .type('text/javascript; charset=utf-8')
                .header('Cache-Control', 'no-cache')
                .send(source);
        });
    }

    app.post('/api/register', async (request, reply) => {
        const { peerId, geohash, registrationId, thumbnail, name } = request.body || {};
        if (!isString(peerId, 200) || !isString(geohash, 64) || !isString(registrationId, 200)) {
            return reply.code(400).send({ error: 'Invalid payload' });
        }
        if (thumbnail != null && typeof thumbnail !== 'string') {
            return reply.code(400).send({ error: 'Invalid thumbnail' });
        }

        const session = {
            peerId,
            registrationId,
            geohash: geohash.substring(0, 10),
            thumbnail: thumbnail ? thumbnail.substring(0, 50000) : null,
            name: typeof name === 'string' ? name.substring(0, 100) : 'Peer'
        };
        store.registerPeer(session);
        return {
            status: 'registered',
            geohash: session.geohash,
            peerId
        };
    });

    async function unregister(request, reply) {
        const payload = request.method === 'DELETE' ? request.query : request.body;
        const { peerId, registrationId, geohash } = payload || {};
        if (!isString(peerId, 200) || !isString(registrationId, 200)) {
            return reply.code(400).send({ error: 'Missing peerId or registrationId' });
        }
        const removed = store.unregisterPeer(peerId, registrationId, geohash || null);
        return { status: 'unregistered', peerId, removed };
    }

    app.delete('/api/register', unregister);
    app.post('/api/unregister', unregister);

    app.get('/api/grid', async (request, reply) => {
        const { geohash } = request.query || {};
        if (!isString(geohash, 64)) {
            return reply.code(400).send({ error: 'Missing geohash param' });
        }
        const normalizedGeohash = geohash.substring(0, 10);
        const { peers, removedPeerIds } = store.getGrid(normalizedGeohash);
        return {
            geohash: normalizedGeohash,
            count: peers.length,
            peers: peers.map(peer => ({
                id: peer.peerId,
                geohash: peer.geohash,
                avatar: peer.thumbnail,
                name: peer.name
            })),
            removedPeerIds
        };
    });

    app.post('/api/cache', async (request, reply) => {
        const { recipientId, senderId, ciphertextPayload, ivHex, ttlHours } = request.body || {};
        if (!isString(recipientId, 200) || !isString(ciphertextPayload, 102400)) {
            return reply.code(400).send({ error: 'Missing or invalid parameters' });
        }
        if (senderId != null && typeof senderId !== 'string') {
            return reply.code(400).send({ error: 'Invalid senderId' });
        }
        if (ivHex != null && typeof ivHex !== 'string') {
            return reply.code(400).send({ error: 'Invalid ivHex' });
        }
        const message = store.enqueueMessage({
            recipientId,
            senderId: senderId?.substring(0, 200),
            ciphertextPayload,
            ivHex: ivHex?.substring(0, 200),
            ttlHours
        });
        return reply.code(201).send({
            status: 'queued',
            msgId: message.msgId,
            expiresAt: message.expiresAt
        });
    });

    app.get('/api/cache/:recipientId', async request => {
        const recipientId = request.params.recipientId;
        const messages = store.getMessages(recipientId);
        return {
            recipientId,
            count: messages.length,
            messages
        };
    });

    app.delete('/api/cache/:msgId', async request => {
        const { msgId } = request.params;
        const removed = store.deleteMessage(msgId);
        return { status: 'deleted', msgId, removed };
    });

    app.setNotFoundHandler(async (_request, reply) => {
        return reply.code(404).type('text/plain').send('OpenGrid API Active - Route Not Found.');
    });

    return app;
}
