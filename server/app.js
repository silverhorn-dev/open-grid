import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto, { createHash, randomBytes } from 'node:crypto';
import { createStore } from './database.js';
import { registerSignalingRoute } from './signaling.js';
import { loadTranslations, translationScript } from './i18n.js';
import { infoSiteUrl, registerInfoSite } from './info-site.js';
import {
    GRID_PRECISION,
    MAX_GRID_RING,
    decodeGeohash,
    distanceBucket,
    distanceKm,
    gridRingCells,
    isGeohash
} from './geohash.js';
import { MAX_PUSH_PLAINTEXT_BYTES, createPushSender, generateVapidKeys } from './push.js';
import {
    DEFAULT_RATE_LIMITS,
    buildLoggerOptions,
    createRateLimiter,
    scaleRateLimits,
    isAllowedPushEndpoint,
    parsePushHostAllowlist,
    parseTrustProxy,
    securityHeaders
} from './security.js';

const MAX_GRID_RESULTS = 100;
// Quoten fuer den Pfad-C-Zwischenspeicher, damit niemand die Queue eines Empfaengers flutet.
const MAX_QUEUED_MESSAGES_PER_RECIPIENT = 500;
const MAX_QUEUED_BYTES_PER_RECIPIENT = 20 * 1024 * 1024;
const MAX_CACHE_CIPHERTEXT_LENGTH = 256 * 1024;
const CACHE_BODY_LIMIT = MAX_CACHE_CIPHERTEXT_LENGTH + 32 * 1024;
const MAX_QUEUED_MESSAGES_PER_SENDER = 200;
const FALLBACK_STUN_URL = 'stun:stun.l.google.com:19302';

// STUN: STUN_SERVER (Host[:Port] oder "none"), sonst der eigene coturn (kann auch STUN),
// erst ohne beides der oeffentliche Google-STUN.
export function resolveStunServers(stunServer, turnServer, turnPort = '3478') {
    const configured = String(stunServer || '').trim();
    if (configured.toLowerCase() === 'none') return [];
    if (configured) return [{ urls: configured.startsWith('stun:') ? configured : `stun:${configured}` }];
    if (turnServer) return [{ urls: `stun:${turnServer}:${turnPort}` }];
    return [{ urls: FALLBACK_STUN_URL }];
}
const APP_MODES = ['discovery', 'chat', 'friends', 'event'];

// Vom Betreiber erlaubte App-Modi (APP_MODES, kommagetrennt). Ungueltiges faellt auf alle zurueck.
export function parseAppModes(value) {
    const modes = String(value || '').split(',').map(mode => mode.trim()).filter(mode => APP_MODES.includes(mode));
    return modes.length ? [...new Set(modes)] : [...APP_MODES];
}

// Standardwerte fuer Client-Einstellungen (CLIENT_DEFAULTS, JSON). Nur bekannte Schluessel mit
// erlaubten Werten; der Client nimmt sie, solange der Nutzer nichts Eigenes gespeichert hat.
const CLIENT_DEFAULT_RULES = {
    language: ['auto', 'de', 'en'],
    chatSwitchEnabled: 'boolean',
    chatSwitchStyle: ['bar', 'arrows', 'swipe'],
    pullUpAction: ['reload', 'next', 'switcher', 'snap', 'album'],
    listSwitchEnabled: 'boolean',
    listSwitchBehavior: ['mode', 'view'],
    statusDirectOnly: 'boolean',
    traceWatermark: 'boolean',
    mediaDownload: ['friends', 'all'],
    snapSaveable: 'boolean',
    secureSnaps: 'boolean',
    snapNextGesture: ['doubletap', 'swipe', 'swipeup'],
    snapExpiry: ['15m', '30m', '60m', 'off'],
    albumKeyEpochMinutes: [0, 15, 60, 180, 1440],
    albumKeyEpochsAhead: [1, 2, 3]
};

export function parseClientDefaults(value) {
    if (!value) return {};
    let parsed;
    try {
        parsed = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, entry]) => {
        const rule = CLIENT_DEFAULT_RULES[key];
        if (!rule) return false;
        return rule === 'boolean' ? typeof entry === 'boolean' : rule.includes(entry);
    }));
}

function isEventHash(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
const DEFAULT_MEDIA_KEY_EPOCH_MINUTES = 5;
const MAX_MEDIA_KEY_EPOCH_MINUTES = 7 * 24 * 60;

// Laenge einer Schluessel-Epoche fuer Album- und View-once-Medien (MEDIA_KEY_EPOCH_MINUTES).
export function parseMediaKeyEpochMinutes(value) {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes < 1) return DEFAULT_MEDIA_KEY_EPOCH_MINUTES;
    return Math.min(Math.floor(minutes), MAX_MEDIA_KEY_EPOCH_MINUTES);
}

const serverDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = join(serverDirectory, '..');
// Feste Liste statt Verzeichnis-Scan: nur diese Dateien unter /client werden ausgeliefert.
const clientAssetFiles = [
    'i18n.js',
    'crypto.client.js',
    'geohash.client.js',
    'app/payload-validation.js',
    'grid.client.js',
    'p2p.client.js',
    'delivery.client.js',
    'styles.css',
    'tailwind.css',
    'icon.svg',
    'app/theme.js',
    'app/config.js',
    'app/ui.js',
    'app/markdown.js',
    'info/site.js',
    'app/storage.js',
    'app/profile.js',
    'app/chat.js',
    'app/chat-tools.js',
    'app/chat-switch.js',
    'app/unread.js',
    'app/snaps.js',
    'app/originals.js',
    'app/voice.js',
    'app/video.js',
    'app/snap-editor.js',
    'app/snap-camera.js',
    'app/viewer.js',
    'app/watermark.js',
    'app/secure-canvas.js',
    'app/media-rights.js',
    'app/albums.js',
    'app/swarm.js',
    'app/secure-snaps.js',
    'app/matching.js',
    'app/friends.js',
    'app/status.js',
    'app/gestures.js',
    'app/modes.js',
    'app/settings.js',
    'app/router.js',
    'app/actions.js',
    'app/push.js',
    'app/share-target.js',
    'app/main.js'
];
const defaultSchema = [
    { key: 'displayName', label: { de: 'Anzeigename', en: 'Display name' }, type: 'string', required: true, default: 'Alex' },
    { key: 'age', label: { de: 'Alter', en: 'Age' }, type: 'number', min: 18, max: 99, default: 26 },
    { key: 'role', label: { de: 'Position / Rolle', en: 'Position / Role' }, type: 'select', options: ['Top', 'Bottom', 'Versatile', 'Side'], default: 'Versatile' },
    { key: 'bio', label: { de: 'Ueber mich', en: 'About me' }, type: 'description', default: { de: 'Hey, ich nutze OpenGrid.', en: 'Hey, I am using OpenGrid.' } }
];

// Im Modus "Nur Chat" reicht ein schlankes Profil: Name und Status.
const defaultChatSchema = [
    { key: 'displayName', label: { de: 'Anzeigename', en: 'Display name' }, type: 'string', required: true, default: 'Alex' },
    { key: 'status', label: { de: 'Status', en: 'Status' }, type: 'string', default: { de: 'Hey, ich nutze OpenGrid.', en: 'Hey, I am using OpenGrid.' } }
];

function parseProfileSchema(value) {
    if (!value) return defaultSchema;
    const schema = JSON.parse(value);
    if (!Array.isArray(schema) || schema.length === 0) {
        throw new Error('PROFILE_SCHEMA must be a non-empty JSON array.');
    }
    return schema;
}

// Profil-Schema pro App-Modus (PROFILE_SCHEMAS als JSON-Objekt, z. B. {"chat": [...]}).
// Fehlende Modi: Chat nutzt das schlanke Schema, alle anderen PROFILE_SCHEMA.
export function parseProfileSchemas(value, baseSchema, modes) {
    const overrides = value ? JSON.parse(value) : {};
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        throw new Error('PROFILE_SCHEMAS must be a JSON object keyed by app mode.');
    }
    return Object.fromEntries(modes.map(mode => {
        const schema = overrides[mode] ?? (mode === 'chat' ? defaultChatSchema : baseSchema);
        if (!Array.isArray(schema) || schema.length === 0) {
            throw new Error(`PROFILE_SCHEMAS.${mode} must be a non-empty JSON array.`);
        }
        return [mode, schema];
    }));
}

function isString(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isPushSubscription(subscription, allowedHosts) {
    if (!subscription || !isString(subscription.endpoint, 2048)) return false;
    if (!isString(subscription.keys?.p256dh, 200) || !isString(subscription.keys?.auth, 100)) return false;
    return isAllowedPushEndpoint(subscription.endpoint, allowedHosts);
}

function loadVapidKeys(store) {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    }
    // Ohne feste Schluessel wuerden alle Browser-Subscriptions nach einem
    // Neustart ungueltig. Deshalb einmal erzeugen und in SQLite behalten.
    return JSON.parse(store.getOrCreateSetting('vapid-keys', () => JSON.stringify(generateVapidKeys())));
}

// Web-App-Manifest (vorher als data:-URL im Markup); share_target fuer "Teilen nach OpenGrid".
const WEB_APP_MANIFEST = JSON.stringify({
    "name": "OpenGrid",
    "short_name": "OpenGrid",
    "start_url": "/grid",
    "scope": "/",
    "display": "standalone",
    "background_color": "#0f172a",
    "theme_color": "#0f172a",
    "icons": [
        {
            "src": "/client/icon-192.png",
            "sizes": "192x192",
            "type": "image/png"
        },
        {
            "src": "/client/icon-512.png",
            "sizes": "512x512",
            "type": "image/png"
        },
        {
            "src": "/client/icon.svg",
            "sizes": "any",
            "type": "image/svg+xml",
            "purpose": "any"
        }
    ],
    "share_target": {
        "action": "/share-target",
        "method": "POST",
        "enctype": "multipart/form-data",
        "params": {
            "title": "title",
            "text": "text",
            "url": "url",
            "files": [
                {
                    "name": "files",
                    "accept": [
                        "image/*"
                    ]
                }
            ]
        }
    }
});

const FONT_AWESOME_DIRECTORY = join(projectDirectory, 'node_modules', '@fortawesome', 'fontawesome-free');
// PNG-Icons fuer Home-Bildschirm/Manifest (iOS nutzt kein SVG als apple-touch-icon).
const ICON_FILES = ['icon-180.png', 'icon-192.png', 'icon-512.png'];
const FONT_CONTENT_TYPES = { '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

async function loadVendorAssets() {
    const assets = new Map();
    assets.set('/vendor/fontawesome/css/all.min.css', {
        contentType: 'text/css; charset=utf-8',
        body: await readFile(join(FONT_AWESOME_DIRECTORY, 'css', 'all.min.css'))
    });
    // QR-Codes fuer Einladungslinks (Modus "Nur Chat"/"Freunde").
    assets.set('/vendor/qrcode/qrcode.js', {
        contentType: 'text/javascript; charset=utf-8',
        body: await readFile(join(projectDirectory, 'node_modules', 'qrcode-generator', 'qrcode.js'))
    });
    for (const file of ICON_FILES) {
        assets.set(`/client/${file}`, {
            contentType: 'image/png',
            body: await readFile(join(projectDirectory, 'client', file))
        });
    }
    for (const file of await readdir(join(FONT_AWESOME_DIRECTORY, 'webfonts'))) {
        const extension = file.slice(file.lastIndexOf('.'));
        // Moderne Browser laden nur woff2; ttf bleibt als Fallback der CSS-Datei erreichbar.
        if (!FONT_CONTENT_TYPES[extension]) continue;
        assets.set(`/vendor/fontawesome/webfonts/${file}`, {
            contentType: FONT_CONTENT_TYPES[extension],
            body: await readFile(join(FONT_AWESOME_DIRECTORY, 'webfonts', file))
        });
    }
    return assets;
}

export async function buildApp(options = {}) {
    const app = Fastify({
        // Logs ohne Query-Strings und IP-Adressen (security.js).
        logger: buildLoggerOptions(options.logger ?? false),
        trustProxy: parseTrustProxy(options.trustProxy ?? process.env.TRUST_PROXY),
        bodyLimit: 128 * 1024
    });
    const store = options.store || createStore(
        options.databasePath || process.env.DATABASE_PATH || join(projectDirectory, 'data', 'open-grid.sqlite'),
        { credentialRetentionDays: process.env.CREDENTIAL_RETENTION_DAYS }
    );

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
    const [indexTemplate, serviceWorkerTemplate, ...clientAssetSources] = await Promise.all([
        readFile(join(projectDirectory, 'index.html'), 'utf8'),
        readFile(join(projectDirectory, 'client', 'sw.js'), 'utf8'),
        ...clientAssetFiles.map(file => readFile(join(projectDirectory, 'client', file), 'utf8'))
    ]);
    const vendorAssets = await loadVendorAssets();
    // Uebersetzungen (i18n/*.properties) als ein Skript pro Sprache.
    const translations = await loadTranslations(join(projectDirectory, 'i18n'));
    const translationAssets = Object.entries(translations)
        .map(([language, messages]) => [`/client/i18n/${language}.js`, translationScript(language, messages)]);
    // Alles, was die App-Shell offline braucht. Der Service Worker laedt die Liste beim
    // Installieren in einen eigenen Cache und prueft jede Antwort.
    const precacheUrls = [
        '/',
        ...clientAssetFiles.map(file => `/client/${file}?v=${assetVersion}`),
        ...translationAssets.map(([path]) => `${path}?v=${assetVersion}`),
        // Schriften: nur woff2, die ttf-Varianten laedt kein aktueller Browser.
        ...[...vendorAssets.keys()].filter(path => !path.endsWith('.ttf'))
    ];
    // Nur die Benachrichtigungstexte (sw.*) wandern in den Service Worker.
    const serviceWorkerTexts = Object.fromEntries(Object.entries(translations).map(([language, messages]) => [
        language,
        Object.fromEntries(Object.entries(messages).filter(([key]) => key.startsWith('sw.')))
    ]));
    const serviceWorker = serviceWorkerTemplate
        .replace('__ASSET_VERSION__', assetVersion)
        .replace('__PRECACHE_URLS__', JSON.stringify(precacheUrls))
        .replace('__SW_TEXTS__', JSON.stringify(serviceWorkerTexts));
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
    const clientAssets = new Map([
        ...clientAssetFiles.map((file, index) => [`/client/${file}`, clientAssetSources[index]]),
        ...translationAssets
    ]);

    await app.register(websocket, {
        options: {
            maxPayload: 128 * 1024
        }
    });
    const limits = scaleRateLimits({ ...DEFAULT_RATE_LIMITS, ...(options.rateLimits || {}) }, options.rateLimitScale ?? process.env.RATE_LIMIT_SCALE);
    const signaling = registerSignalingRoute(app, store, { messageLimiter: () => createRateLimiter(limits.websocket), heartbeatMs: options.heartbeatMs });

    app.addHook('onClose', async () => {
        if (ownsStore) store.close();
    });

    // Die App laeuft komplett same-origin: keine CORS-Header, dafuer Sicherheits-Header.
    app.addHook('onRequest', async (request, reply) => {
        reply.headers(securityHeaders(request.headers.host));
    });

    // Info-Seite fuer alle (info-site/, server/info-site.js), auf eigener Domain oder unter /info.
    const infoHost = String(options.infoHost ?? process.env.INFO_HOST ?? '').trim().toLowerCase() || null;
    await registerInfoSite(app, {
        projectDirectory,
        assetVersion,
        infoHost,
        appUrl: options.appUrl ?? process.env.APP_URL ?? ''
    });

    const rateLimiters = Object.fromEntries(Object.entries(limits).map(([name, config]) => [name, createRateLimiter(config)]));
    // false = Anfrage wurde mit 429 beantwortet.
    function allowRequest(name, key, reply) {
        const result = rateLimiters[name].take(key);
        if (result === true) return true;
        reply.code(429).header('Retry-After', String(result)).send({ error: 'Too many requests' });
        return false;
    }
    const pushHostAllowlist = parsePushHostAllowlist(options.pushHostAllowlist ?? process.env.PUSH_HOST_ALLOWLIST);

    const mediaKeyEpochMs = parseMediaKeyEpochMinutes(options.mediaKeyEpochMinutes ?? process.env.MEDIA_KEY_EPOCH_MINUTES) * 60 * 1000;
    const now = options.now || Date.now;
    const appModes = parseAppModes(options.appModes ?? process.env.APP_MODES);
    const isLanMode = String(options.lanMode ?? process.env.LAN_MODE ?? '').toLowerCase() === 'true';
    const requestedDefaultMode = options.defaultAppMode ?? process.env.DEFAULT_APP_MODE;
    const defaultAppMode = appModes.includes(requestedDefaultMode) ? requestedDefaultMode : appModes[0];
    const clientDefaults = parseClientDefaults(options.clientDefaults ?? process.env.CLIENT_DEFAULTS);
    const profileSchemas = options.profileSchemas
        || parseProfileSchemas(process.env.PROFILE_SCHEMAS, profileSchema, appModes);

    // Verlaessliche Zeit fuer die Schluessel-Rotation; die Geraetezeit wird dafuer ignoriert.
    app.get('/api/time', async (_request, reply) => {
        const timestamp = now();
        const epoch = Math.floor(timestamp / mediaKeyEpochMs);
        return reply.header('Cache-Control', 'no-store').send({
            now: timestamp,
            epoch,
            epochMs: mediaKeyEpochMs,
            epochEndsAt: (epoch + 1) * mediaKeyEpochMs
        });
    });

    app.get('/health', async () => ({
        status: 'ok',
        version: buildVersion
    }));

    const serveAppShell = async (_request, reply) => {
        const html = indexTemplate
            .replaceAll('{{versionTag}}', buildVersion)
            .replaceAll('{{timestamp}}', buildTimestamp)
            .replaceAll('{{assetVersion}}', assetVersion)
            .replace('{{profileSchema}}', JSON.stringify(profileSchemas));
        return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html);
    };
    // Client-Routen (client/app/router.js) liefern dieselbe App-Shell.
    for (const path of ['/', '/index.html', '/grid', '/chat', '/chat/:peerId', '/profile', '/settings', '/cloud', '/invite']) {
        app.get(path, serveAppShell);
    }

    // Der Service Worker muss unter dem Wurzelpfad liegen, damit sein Scope
    // die ganze App abdeckt. no-cache sorgt dafuer, dass Updates erkannt werden.
    // Changelog (im Debug-Modus im Menue). Wird bei jedem Abruf gelesen, damit Updates ohne Neustart sichtbar sind.
    app.get('/changelog.md', async (_request, reply) => {
        const text = await readFile(join(projectDirectory, 'CHANGELOG.md'), 'utf8').catch(() => '# Changelog\n\nNicht verfuegbar.');
        return reply.type('text/markdown; charset=utf-8').header('Cache-Control', 'no-cache').send(text);
    });

    // Web-App-Manifest, mit share_target: installiert erscheint OpenGrid im Teilen-Menue anderer Apps.
    app.get('/manifest.webmanifest', async (_request, reply) => reply
        .type('application/manifest+json; charset=utf-8')
        .header('Cache-Control', 'no-cache')
        .send(WEB_APP_MANIFEST));

    // Geteilte Dateien faengt der Service Worker ab und behaelt sie lokal. Kommt der POST doch hier an
    // (kein aktiver Worker), wird nichts gespeichert, nur zur App weitergeleitet.
    app.addContentTypeParser('multipart/form-data', (_request, payload, done) => {
        payload.resume();
        payload.on('end', () => done(null, null));
        payload.on('error', done);
    });
    app.post('/share-target', async (_request, reply) => reply.redirect('/chat?share=unavailable', 303));

    app.get('/sw.js', async (_request, reply) => {
        return reply
            .type('text/javascript; charset=utf-8')
            .header('Cache-Control', 'no-cache')
            .header('Service-Worker-Allowed', '/')
            .send(serviceWorker);
    });

    for (const [path, source] of clientAssets) {
        const contentType = path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript';
        app.get(path, async (_request, reply) => {
            return reply
                .type(`${contentType}; charset=utf-8`)
                .header('Cache-Control', 'no-cache')
                .send(source);
        });
    }

    // Font Awesome aus node_modules statt vom CDN (offline nutzbar, keine IP an Dritte).
    for (const [path, asset] of vendorAssets) {
        app.get(path, async (_request, reply) => {
            return reply
                .type(asset.contentType)
                .header('Cache-Control', 'public, max-age=604800')
                .send(asset.body);
        });
    }

    app.get('/api/ice-config', async (request, reply) => {
        const turnSecret = process.env.TURN_SECRET;
        const turnServer = process.env.TURN_SERVER;
        const turnPort = process.env.TURN_PORT || '3478';
        // Club-/LAN-Betrieb: nur lokale (host/mDNS) Kandidaten, keine Anfrage an fremde Server.
        if (isLanMode) {
            return { turnEnabled: false, lanMode: true, reason: 'LAN_MODE is enabled', iceServers: [] };
        }
        const stunServers = resolveStunServers(process.env.STUN_SERVER, turnServer, turnPort);

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
                iceServers: stunServers
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
                ...stunServers,
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
        if (!allowRequest('register', request.ip, reply)) return;
        const {
            peerId,
            geohash,
            registrationId,
            thumbnail,
            name,
            authToken: suppliedToken,
            registrationProof,
            silent,
            ttlMinutes,
            scope,
            eventHash
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
        // Sichtbarkeit je App-Modus; nur Modi, die der Betreiber erlaubt.
        const peerScope = scope == null ? 'public' : scope;
        const scopeMode = { public: 'discovery', friends: 'friends', event: 'event' }[peerScope];
        if (!scopeMode || (peerScope !== 'public' && !appModes.includes(scopeMode))) {
            return reply.code(400).send({ error: 'Invalid scope' });
        }
        if (peerScope === 'event' && !isEventHash(eventHash)) {
            return reply.code(400).send({ error: 'Invalid eventHash' });
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
            ttlMs: ttlMinutes != null ? ttlMinutes * 60 * 1000 : undefined,
            scope: peerScope,
            eventHash: peerScope === 'event' ? eventHash : null
        };
        if (!store.registerPeer(session)) {
            return reply.code(403).send({ error: 'Peer identity is already registered' });
        }
        signaling.updatePeerCell(peerId, session.geohash, session.silent || peerScope !== 'public');
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

    app.get('/api/config', async () => ({ modes: appModes, defaultMode: defaultAppMode, profileSchemas, lanMode: isLanMode, clientDefaults, infoUrl: infoSiteUrl(infoHost) }));

    const toGridPeer = (origin) => ({ peer, km }) => ({
        id: peer.peerId,
        avatar: peer.thumbnail,
        name: peer.name,
        distanceBucket: origin ? distanceBucket(km) : null
    });
    const withDistance = (origin, peers) => peers
        .map(peer => ({ peer, km: origin && isGeohash(peer.geohash) ? distanceKm(origin, decodeGeohash(peer.geohash)) : Infinity }))
        .sort((left, right) => left.km - right.km || left.peer.peerId.localeCompare(right.peer.peerId))
        .slice(0, MAX_GRID_RESULTS);

    app.get('/api/grid', async (request, reply) => {
        if (!allowRequest('grid', request.ip, reply)) return;
        const { geohash, live, scope = 'public' } = request.query || {};
        if (!isGeohash(geohash, GRID_PRECISION)) {
            return reply.code(400).send({ error: 'Missing geohash param' });
        }
        const normalizedGeohash = geohash.substring(0, GRID_PRECISION);
        const origin = decodeGeohash(normalizedGeohash);

        // Freunde in der Naehe: nur gegenseitige Kontakte des anfragenden Peers.
        if (scope === 'friends') {
            if (!appModes.includes('friends')) return reply.code(403).send({ error: 'Mode not enabled' });
            const { peerId } = request.query;
            if (!isString(peerId, 200)) return reply.code(400).send({ error: 'Missing peerId' });
            if (!requirePeerAuth(request, reply, peerId)) return;
            const peers = withDistance(origin, store.getVisiblePeers(signaling.getMutualContacts(peerId)));
            return { geohash: normalizedGeohash, scope, count: peers.length, hasMore: false, peers: peers.map(toGridPeer(origin)), removedPeerIds: [] };
        }

        // Event: alle Teilnehmer mit demselben Code-Hash, unabhaengig vom Ort.
        if (scope === 'event') {
            if (!appModes.includes('event')) return reply.code(403).send({ error: 'Mode not enabled' });
            const { eventHash } = request.query;
            if (!isEventHash(eventHash)) return reply.code(400).send({ error: 'Invalid eventHash' });
            const peers = withDistance(origin, store.getEventPeers(eventHash));
            return { geohash: normalizedGeohash, scope, count: peers.length, hasMore: false, peers: peers.map(toGridPeer(origin)), removedPeerIds: [] };
        }

        if (scope !== 'public') return reply.code(400).send({ error: 'Invalid scope' });
        if (!appModes.includes('discovery')) return reply.code(403).send({ error: 'Mode not enabled' });
        const ring = request.query.ring == null ? 0 : Number(request.query.ring);
        if (!Number.isInteger(ring) || ring < 0 || ring > MAX_GRID_RING) {
            return reply.code(400).send({ error: 'Invalid ring' });
        }
        const liveOnly = live === '1';
        const visible = peer => !liveOnly || signaling.isPeerOnline(peer.peerId);

        const grid = store.getGridArea(gridRingCells(normalizedGeohash, ring));
        // Entfernung nur zwischen Zellmittelpunkten; die Antwort enthaelt weder Koordinaten noch Geohash.
        const peers = withDistance(origin, grid.peers.filter(visible));
        const hasMore = ring < MAX_GRID_RING
            && store.getGridArea(gridRingCells(normalizedGeohash, ring + 1)).peers.filter(visible).length > grid.peers.filter(visible).length;
        return {
            geohash: normalizedGeohash,
            ring,
            count: peers.length,
            hasMore,
            peers: peers.map(toGridPeer(origin)),
            removedPeerIds: grid.removedPeerIds
        };
    });

    async function notifyRecipient(message) {
        const subscription = store.getPushSubscription(message.recipientId);
        // Auch alte, vor der Allowlist gespeicherte Subscriptions nie an fremde Hosts.
        if (!subscription || !isAllowedPushEndpoint(subscription.endpoint, pushHostAllowlist)) return;
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
        if (!allowRequest('push', request.ip, reply)) return;
        const { peerId, subscription } = request.body || {};
        if (!isString(peerId, 200)) {
            return reply.code(400).send({ error: 'Invalid peerId' });
        }
        if (!requirePeerAuth(request, reply, peerId)) return;
        if (!isPushSubscription(subscription, pushHostAllowlist)) {
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

    // Groesseres Limit nur hier: Sprachnachrichten (bis 60 s) gehen als Ganzes durch den Cache.
    app.post('/api/cache', { bodyLimit: CACHE_BODY_LIMIT }, async (request, reply) => {
        const { recipientId, senderId, ciphertextPayload, ivHex, ttlHours, notify } = request.body || {};
        if (!isString(recipientId, 200) || !isString(ciphertextPayload, MAX_CACHE_CIPHERTEXT_LENGTH)) {
            return reply.code(400).send({ error: 'Missing or invalid parameters' });
        }
        if (!isString(senderId, 200)) {
            return reply.code(400).send({ error: 'Missing or invalid senderId' });
        }
        if (!requirePeerAuth(request, reply, senderId)) return;
        if (!allowRequest('cache', senderId, reply)) return;
        if (ivHex != null && typeof ivHex !== 'string') {
            return reply.code(400).send({ error: 'Invalid ivHex' });
        }
        if (store.isBlocked(recipientId, senderId)) {
            return reply.code(403).send({ error: 'Recipient does not accept messages from this sender' });
        }
        const usage = store.getQueueUsage(recipientId, senderId);
        if (usage.count >= MAX_QUEUED_MESSAGES_PER_RECIPIENT
            || usage.bytes + ciphertextPayload.length > MAX_QUEUED_BYTES_PER_RECIPIENT
            || usage.fromSender >= MAX_QUEUED_MESSAGES_PER_SENDER) {
            return reply.code(429).send({ error: 'Recipient queue is full' });
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
        signaling.notifyCacheWaiting(recipientId);
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
        if (!allowRequest('chatControls', request.ip, reply)) return;
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
        if (!allowRequest('chatControls', request.ip, reply)) return;
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
