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
import { createSafety, createSafetyCrypto, loadSafetyKey, parseSafetyConfig, registerSafetyRoutes } from './safety.js';
import { registerAdminRoutes } from './admin.js';
import { createMetrics } from './metrics.js';
import { createLiveConfig } from './live-config.js';
import { registerReportRoutes } from './reports.js';
import { createEudiAgeProvider, parseEudiDoctypes, registerEudiTestRoutes } from './age-eudi.js';
import { createOidcAgeProvider, describeOidcConfig, parseOidcConfig } from './age-oidc.js';
import { createAgeTrustStore, EU_AGE_TEST_TRUSTED_LIST_SIGNERS, EU_AGE_TEST_TRUSTED_LIST_URL, EU_AGE_TRUSTED_LIST_SIGNERS, EU_AGE_TRUSTED_LIST_URL, parseAgeTrustConfig } from './age-trust.js';
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
import { applyAudienceMinimum, parseAudienceMinimum } from './audience.js';
import { MAX_THRESHOLD, MIN_THRESHOLD, nudityPublicConfig as describeNudityModels, parseNudityConfig, parseNudityThreshold, registerNudityModelRoutes } from './nudity-model.js';

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
    inputSwipeClosesChat: 'boolean',
    chatPagesByDay: 'boolean',
    reloadMode: ['full', 'app'],
    notifyMatch: 'boolean',
    notifyFlame: 'boolean',
    notifyAdd: 'boolean',
    notifyDiscovery: 'boolean',
    notifyChat: 'boolean',
    notifyProfileView: 'boolean',
    notifyChatEvents: 'boolean',
    shareProfileViews: 'boolean',
    // Startregel fuer "Nur zeigen fuer ..." (Objekt, eigene Pruefung in isAudienceRule).
    audience: 'audience',
    listSwitchEnabled: 'boolean',
    listSwitchBehavior: ['mode', 'view'],
    statusDirectOnly: 'boolean',
    hideDiscoveryHistory: 'boolean',
    traceWatermark: 'boolean',
    nudityFilter: 'boolean',
    nudityWarnBeforeSend: 'boolean',
    mediaDownload: ['friends', 'all'],
    snapSaveable: 'boolean',
    secureSnaps: 'boolean',
    snapNextGesture: ['doubletap', 'swipe', 'swipeup'],
    snapExpiry: ['15m', '30m', '60m', 'off'],
    ownSnapKeep: ['now', '15m', '1h', '24h'],
    albumKeyEpochMinutes: [0, 15, 60, 180, 1440, 10080],
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
        if (rule === 'audience') return isAudienceRule(entry);
        return rule === 'boolean' ? typeof entry === 'boolean' : rule.includes(entry);
    }));
}

// Regel { ranges: { feld: { min, max } | { relative: 'same'|'older'|'younger' } }, options: { feld: [werte] | 'same' } }.
const AUDIENCE_RELATIVE = ['same', 'older', 'younger'];
function isAudienceRule(rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
    const keyOk = key => /^[A-Za-z0-9_-]{1,64}$/.test(key);
    const ranges = rule.ranges ?? {};
    const options = rule.options ?? {};
    if (typeof ranges !== 'object' || Array.isArray(ranges) || typeof options !== 'object' || Array.isArray(options)) return false;
    const rangeOk = range => range && typeof range === 'object' && (AUDIENCE_RELATIVE.includes(range.relative)
        || ((range.min == null || (Number.isFinite(range.min) && range.min >= 0 && range.min <= 255))
            && (range.max == null || (Number.isFinite(range.max) && range.max >= 0 && range.max <= 255))));
    const optionOk = value => value === 'same' || (Array.isArray(value) && value.length <= 32 && value.every(item => typeof item === 'string' && item.length <= 100));
    return Object.keys(ranges).length + Object.keys(options).length <= 32
        && Object.entries(ranges).every(([key, range]) => keyOk(key) && rangeOk(range))
        && Object.entries(options).every(([key, value]) => keyOk(key) && optionOk(value));
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
    'app/features.js',
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
    'app/nudity.js',
    'app/nudity-model.js',
    'app/nudity-worker.js',
    'app/media-rights.js',
    'app/albums.js',
    'app/swarm.js',
    'app/secure-snaps.js',
    'app/matching.js',
    'app/friends.js',
    'app/grid-tabs.js',
    'app/grid-filter.js',
    'app/audience.js',
    'app/account.js',
    'app/status.js',
    'app/gestures.js',
    'app/modes.js',
    'app/settings.js',
    'app/router.js',
    'app/actions.js',
    'app/push.js',
    'app/safety.js',
    'app/age-test.js',
    'app/share-target.js',
    'app/main.js'
];
// Abschaltbare Teile (client/app/features.js): ist ein Teil aus, liefert der Router weder diese Dateien
// noch die markierte Oberflaeche (<!-- feature:<name> --> in index.html) aus.
const FEATURE_ASSET_FILES = {
    nudity: ['app/nudity.js', 'app/nudity-model.js', 'app/nudity-worker.js'],
    safety: ['app/safety.js'],
    agetest: ['app/age-test.js']
};
const featureOfAsset = new Map(Object.entries(FEATURE_ASSET_FILES).flatMap(([name, files]) => files.map(file => [`/client/${file}`, name])));

// index.html ohne die Bloecke ausgeschalteter Teile (Marker selbst fallen immer weg).
export function renderFeatureBlocks(html, enabled) {
    return html.replace(/[ \t]*<!-- feature:([a-z]+) -->\n?([\s\S]*?)[ \t]*<!-- \/feature:\1 -->\n?/g,
        (_match, name, body) => (enabled.has(name) ? body : ''));
}

const defaultSchema = [
    { key: 'displayName', label: { de: 'Anzeigename', en: 'Display name' }, type: 'string', required: true, default: 'Alex' },
    { key: 'age', label: { de: 'Alter', en: 'Age' }, type: 'number', min: 18, max: 99, default: 26 },
    { key: 'role', label: { de: 'Position / Rolle', en: 'Position / Role' }, type: 'select', options: ['Top', 'Bottom', 'Versatile', 'Side'], default: 'Versatile' },
    { key: 'height', label: { de: 'Größe (cm)', en: 'Height (cm)' }, type: 'number', min: 120, max: 230 },
    { key: 'weight', label: { de: 'Gewicht (kg)', en: 'Weight (kg)' }, type: 'number', min: 35, max: 250 },
    { key: 'bodyType', label: { de: 'Körperbau', en: 'Body type' }, type: 'select', options: ['Slim', 'Average', 'Athletic', 'Muscular', 'Stocky', 'Large'] },
    { key: 'tribes', label: { de: 'Tribes', en: 'Tribes' }, type: 'multiselect', options: ['Bear', 'Clean-cut', 'Daddy', 'Geek', 'Jock', 'Leather', 'Otter', 'Rugged', 'Trans', 'Twink', 'Femme'] },
    { key: 'lookingFor', label: { de: 'Sucht nach', en: 'Looking for' }, type: 'multiselect', options: ['Chat', 'Dates', 'Friends', 'Relationship', 'Right now', 'Networking'] },
    { key: 'relationship', label: { de: 'Beziehungsstatus', en: 'Relationship status' }, type: 'select', options: ['Single', 'Dating', 'Committed', 'Open relationship', 'Married', 'Partnered'] },
    { key: 'bio', label: { de: 'Über mich', en: 'About me' }, type: 'description', default: { de: 'Hey, ich nutze OpenGrid.', en: 'Hey, I am using OpenGrid.' } }
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
    const databasePath = options.databasePath || process.env.DATABASE_PATH || join(projectDirectory, 'data', 'open-grid.sqlite');
    const store = options.store || createStore(
        databasePath,
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
    const [indexTemplate, adminTemplate, adminScript, serviceWorkerTemplate, ...clientAssetSources] = await Promise.all([
        readFile(join(projectDirectory, 'index.html'), 'utf8'),
        readFile(join(projectDirectory, 'admin.html'), 'utf8'),
        readFile(join(projectDirectory, 'client', 'admin.js'), 'utf8'),
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
        // Abschaltbare Teile nicht: die holt der Service Worker erst, wenn die App sie laedt.
        ...clientAssetFiles.filter(file => !featureOfAsset.has(`/client/${file}`)).map(file => `/client/${file}?v=${assetVersion}`),
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
        // Admin-Panel: nicht in der App-Shell und nicht im Precache des Service Workers.
        ['/client/admin.js', adminScript],
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

    // Auslastung fuer das Admin-Panel (server/metrics.js): alle 10 s eine Messung, nur im Speicher.
    const metrics = createMetrics({
        store, signaling, databasePath,
        dataDirectory: databasePath === ':memory:' ? projectDirectory : dirname(databasePath),
        ...(options.metricsIntervalMs ? { intervalMs: options.metricsIntervalMs } : {})
    });
    if (options.metrics !== false) metrics.start();
    app.addHook('onClose', async () => metrics.stop());
    app.addHook('onResponse', async (request, reply) => {
        metrics.recordResponse(reply.statusCode, reply.elapsedTime);
    });

    // Die App laeuft komplett same-origin: keine CORS-Header, dafuer Sicherheits-Header.
    app.addHook('onRequest', async (request, reply) => {
        // Der Nacktbild-Worker darf WebAssembly kompilieren (NudeNet/onnxruntime-web, TF.js); die Seite nicht.
        reply.headers(securityHeaders(request.headers.host, { wasm: request.url.startsWith('/client/app/nudity-worker.js') }));
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
    // Live aenderbar (Admin-Panel, server/live-config.js): CLIENT_DEFAULTS, AUDIENCE_MINIMUM, NUDITY_*.
    let clientDefaults = parseClientDefaults(options.clientDefaults ?? process.env.CLIENT_DEFAULTS);
    const profileSchemas = options.profileSchemas
        || parseProfileSchemas(process.env.PROFILE_SCHEMAS, profileSchema, appModes);
    // Mindestwerte fuer "Nur zeigen fuer ..." (z. B. {"ranges":{"age":{"min":18}}}), je Grid-Bereich gegen
    // dessen Profil-Schema; der Router mischt sie in jeden Karten-Code.
    let audienceMinimumRule = options.audienceMinimum ?? process.env.AUDIENCE_MINIMUM ?? null;
    const audienceSchemaFor = scope => (scope === 'event' ? profileSchemas.event : null) || profileSchemas.discovery || profileSchema;
    // Nacktbild-Modell (Board T3): vom Router konfiguriert und ausgeliefert, nur bei eingeschaltetem Filter geladen.
    let nudityConfig = parseNudityConfig({
        model: options.nudityModel ?? process.env.NUDITY_MODEL,
        threshold: options.nudityThreshold ?? process.env.NUDITY_THRESHOLD,
        classes: options.nudityClasses ?? process.env.NUDITY_CLASSES
    });
    // Optionale Modelle (Bumble, NudeNet): eigener Ordner im Datenordner (Vorrang), sonst models/ (models/README.md).
    const nudityModelDirectory = options.nudityModelDir ?? process.env.NUDITY_MODEL_DIR ?? join(dirname(databasePath === ':memory:' ? join(projectDirectory, 'data', 'x') : databasePath), 'nudity-models');
    const nudityAssets = await registerNudityModelRoutes(app, nudityConfig, {
        modelDirectories: [nudityModelDirectory, ...(options.nudityBuiltInModels === false ? [] : [join(projectDirectory, 'models')])]
    });
    let nudityPublicConfig = describeNudityModels(nudityConfig, nudityAssets);
    // Pflicht-Scan (Admin-Wahl): 'off', 'minors' (unter 18 kann den Filter nicht abschalten), 'minor-chats'
    // (dazu prueft jeder Empfaenger Bilder von unter 18) oder 'everyone'. Die App setzt es um.
    const NUDITY_SCAN_MODES = ['off', 'minors', 'minor-chats', 'everyone'];
    const parseScanRequired = value => (NUDITY_SCAN_MODES.includes(String(value ?? '').trim()) ? String(value).trim() : null);
    let nudityScanRequired = parseScanRequired(options.nudityScanRequired ?? process.env.NUDITY_SCAN_REQUIRED) || 'off';
    let audienceMinimums = {
        public: parseAudienceMinimum(audienceMinimumRule, audienceSchemaFor('public')),
        event: parseAudienceMinimum(audienceMinimumRule, audienceSchemaFor('event'))
    };

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

    // Wird gesetzt, sobald Nachweise und Nacktbild-Modell eingerichtet sind (weiter unten).
    let enabledFeatures = () => new Set(Object.keys(FEATURE_ASSET_FILES));
    const serveAppShell = async (_request, reply) => {
        const html = renderFeatureBlocks(indexTemplate, enabledFeatures())
            .replaceAll('{{versionTag}}', buildVersion)
            .replaceAll('{{timestamp}}', buildTimestamp)
            .replaceAll('{{assetVersion}}', assetVersion)
            .replace('{{profileSchema}}', JSON.stringify(profileSchemas));
        return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(html);
    };
    // Admin-Panel (eigene Seite, gleiche CSP wie die App).
    const adminHtml = adminTemplate.replaceAll('{{assetVersion}}', assetVersion).replaceAll('{{versionTag}}', buildVersion);
    app.get('/admin', async (_request, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-cache').send(adminHtml));

    // Client-Routen (client/app/router.js) liefern dieselbe App-Shell.
    for (const path of ['/', '/index.html', '/grid', '/chat', '/chat/:peerId', '/profile', '/settings', '/cloud', '/invite', '/age-callback']) {
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
        const feature = featureOfAsset.get(path);
        app.get(path, async (_request, reply) => {
            if (feature && !enabledFeatures().has(feature)) return reply.code(404).send({ error: 'Not found' });
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

    // Alters-/E-Mail-Nachweis, Sperren, IP-Protokoll (server/safety.js); standardmaessig alles aus.
    const safetyConfig = parseSafetyConfig(options.safety ?? {
        ageCheck: process.env.AGE_CHECK,
        ageProvider: process.env.AGE_PROVIDER,
        emailCheck: process.env.EMAIL_CHECK,
        emailTransport: process.env.EMAIL_TRANSPORT,
        abuseLogDays: process.env.ABUSE_LOG_DAYS,
        safetyKey: process.env.SAFETY_KEY,
        smtpUrl: process.env.SMTP_URL,
        smtpFrom: process.env.SMTP_FROM,
        ageSeparation: process.env.AGE_SEPARATION
    });
    // Anbieter fuer AGE_CHECK=provider. Beide werden immer vorbereitet: AGE_PROVIDER laesst sich im Admin-Panel
    // umschalten; Netzverkehr gibt es erst, wenn ein Anbieter gewaehlt ist (activate) bzw. benutzt wird.
    const ageProviders = {};
    const appUrlSetting = String(options.appUrl ?? process.env.APP_URL ?? '').trim();
    // EU-Altersnachweis ueber die Wallet (age-eudi.js) mit Vertrauensankern aus age-trust.js.
    const ageTrust = createAgeTrustStore({
        config: parseAgeTrustConfig(options.ageTrust ?? {
            certs: process.env.AGE_TRUST_CERTS,
            listUrl: process.env.AGE_TRUSTED_LIST_URL,
            listSigners: process.env.AGE_TRUSTED_LIST_SIGNER
        }),
        dataDirectory: databasePath === ':memory:' ? null : dirname(databasePath),
        log: app.log,
        ...(options.ageTrustFetch ? { fetchList: options.ageTrustFetch } : {})
    });
    app.addHook('onClose', async () => ageTrust.stop());
    let eudiOrigins = [];
    try {
        eudiOrigins = appUrlSetting ? [new URL(appUrlSetting).origin] : [];
    } catch {
        app.log.warn('APP_URL is not a valid URL; the EUDI age check binds to the request host.');
    }
    ageProviders.eudi = {
        ...createEudiAgeProvider({
            trust: ageTrust,
            doctypes: parseEudiDoctypes(options.ageEudiDoctypes ?? process.env.AGE_EUDI_DOCTYPES),
            origins: eudiOrigins,
            now: () => new Date(now()),
            log: app.log
        }),
        // Import der EU-Liste erst, wenn die Wallet als Anbieter gewaehlt ist (taeglich, idempotent).
        activate: () => {
            if (options.ageTrustAutoStart !== false) ageTrust.start();
        }
    };
    app.decorate('ageTrust', ageTrust);

    // Beliebiger OpenID-Connect-Dienst (age-oidc.js), z. B. KJM-anerkannte Pruefdienste. Startwert aus
    // AGE_OIDC_*, im Admin-Panel live aenderbar (Eintrag AGE_OIDC, Client-Secret verschluesselt gespeichert).
    let oidcEnvConfig = null;
    try {
        oidcEnvConfig = parseOidcConfig(options.ageOidc ?? {
            issuer: process.env.AGE_OIDC_ISSUER,
            clientId: process.env.AGE_OIDC_CLIENT_ID,
            clientSecret: process.env.AGE_OIDC_CLIENT_SECRET,
            scope: process.env.AGE_OIDC_SCOPE,
            claim: process.env.AGE_OIDC_CLAIM,
            adultValue: process.env.AGE_OIDC_ADULT_VALUE,
            minorValue: process.env.AGE_OIDC_MINOR_VALUE,
            redirectUri: process.env.AGE_OIDC_REDIRECT_URI
        });
    } catch (error) {
        app.log.error(`AGE_OIDC_* is invalid (${error.message}); the OIDC age check stays off until it is set in the admin panel.`);
    }
    let oidcConfig = oidcEnvConfig;
    ageProviders.oidc = createOidcAgeProvider({
        getConfig: () => oidcConfig,
        fetch: options.ageOidcFetch,
        now,
        log: app.log,
        defaultRedirectUri: origin => {
            try {
                return `${new URL(appUrlSetting || origin).origin}/age-callback`;
            } catch {
                return null;
            }
        }
    });
    const safety = createSafety({ config: safetyConfig, store, log: app.log, now, ageProviders });
    const ageTestEnabled = String(options.ageEudiTest ?? process.env.AGE_EUDI_TEST ?? 'true').toLowerCase() !== 'false';
    // Eingeschaltete Teile, je Anfrage (das Admin-Panel kann sie live umschalten).
    enabledFeatures = () => {
        const features = new Set();
        if (nudityPublicConfig.model !== 'off') features.add('nudity');
        const { ageCheck, emailCheck } = safety.publicConfig();
        if (ageCheck !== 'off' || emailCheck === 'required') features.add('safety');
        if (ageTestEnabled) features.add('agetest');
        return features;
    };
    let liveSecretCrypto = null;
    const secretCrypto = () => (liveSecretCrypto ||= createSafetyCrypto(loadSafetyKey(safetyConfig, store)));
    // Live-Konfiguration (server/live-config.js): Panel-Werte gewinnen ueber die Umgebung, ohne Neustart.
    const jsonSetting = (value, name) => {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value !== 'string') return value;
        try {
            return JSON.parse(value);
        } catch {
            throw new Error(`${name} must be JSON`);
        }
    };
    const startNudityModel = nudityConfig.model;
    const refreshNudity = next => {
        nudityConfig = next;
        nudityPublicConfig = describeNudityModels(nudityConfig, nudityAssets);
    };
    const liveConfig = createLiveConfig({
        store, log: app.log, now,
        entries: {
            CLIENT_DEFAULTS: {
                env: clientDefaults,
                apply: value => {
                    const parsed = jsonSetting(value, 'CLIENT_DEFAULTS');
                    if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('CLIENT_DEFAULTS must be a JSON object');
                    clientDefaults = parseClientDefaults(parsed);
                }
            },
            AUDIENCE_MINIMUM: {
                env: jsonSetting(audienceMinimumRule, 'AUDIENCE_MINIMUM'),
                apply: value => {
                    const parsed = jsonSetting(value, 'AUDIENCE_MINIMUM');
                    const next = { public: parseAudienceMinimum(parsed, audienceSchemaFor('public')), event: parseAudienceMinimum(parsed, audienceSchemaFor('event')) };
                    audienceMinimumRule = parsed;
                    audienceMinimums = next;
                }
            },
            NUDITY_MODEL: {
                env: nudityConfig.model,
                apply: value => {
                    const model = String(value ?? 'nudenet').trim().toLowerCase();
                    // Neu gewaehlt nur installierte Modelle; fehlt der Startwert, greift die Ausweichregel (nsfwjs).
                    if (model !== 'off' && model !== startNudityModel && !nudityAssets?.models?.[model]) throw new Error(`Model ${model} is not installed`);
                    refreshNudity({ ...nudityConfig, model });
                },
                options: () => ['off', ...Object.keys(nudityAssets?.models || {})]
            },
            NUDITY_THRESHOLD: {
                // null = Standard des aktiven Modells (NudeNet 0,4, sonst 0,7).
                env: nudityConfig.threshold,
                apply: value => {
                    const threshold = parseNudityThreshold(value);
                    const empty = value === null || value === undefined || String(value).trim() === '';
                    if (threshold === null && !empty) throw new Error(`NUDITY_THRESHOLD must be ${MIN_THRESHOLD}-${MAX_THRESHOLD}`);
                    refreshNudity({ ...nudityConfig, threshold });
                },
                options: () => ({ effective: nudityPublicConfig.threshold ?? null })
            },
            NUDITY_CLASSES: {
                // Leer = Standard des Modells; angezeigt werden die wirksamen Klassen.
                env: nudityConfig.classes.length ? nudityConfig.classes : (nudityPublicConfig.classes || []),
                apply: value => refreshNudity({ ...nudityConfig, classes: (Array.isArray(value) ? value : String(value ?? '').split(',')).map(entry => String(entry).trim()).filter(Boolean) }),
                options: () => nudityAssets?.models?.[nudityPublicConfig.model]?.classes || []
            },
            NUDITY_SCAN_REQUIRED: {
                env: nudityScanRequired,
                apply: value => {
                    const mode = parseScanRequired(value ?? 'off');
                    if (!mode) throw new Error(`NUDITY_SCAN_REQUIRED must be one of ${NUDITY_SCAN_MODES.join(', ')}`);
                    nudityScanRequired = mode;
                },
                options: () => NUDITY_SCAN_MODES
            },
            // Vor AGE_CHECK: ein gespeichertes AGE_CHECK=provider braucht beim Start schon den Anbieter.
            AGE_PROVIDER: {
                env: safetyConfig.ageProvider || 'none',
                apply: value => safety.updateConfig({ ageProvider: value ?? 'none' }),
                options: () => safety.options().ageProviders
            },
            AGE_CHECK: {
                env: safety.publicConfig().ageCheck,
                apply: value => safety.updateConfig({ ageCheck: value }),
                options: () => safety.options().ageCheck
            },
            EMAIL_CHECK: {
                env: safetyConfig.emailCheck,
                apply: value => safety.updateConfig({ emailCheck: value }),
                options: () => safety.options().emailCheck
            },
            ABUSE_LOG_DAYS: {
                env: safetyConfig.abuseLogDays,
                apply: value => safety.updateConfig({ abuseLogDays: Number(value) })
            },
            AGE_OIDC: {
                env: oidcEnvConfig,
                // Ohne clientSecret in der Eingabe bleibt das bisherige (das Panel sieht es nie); "" loescht es.
                prepare: value => {
                    const input = jsonSetting(value, 'AGE_OIDC');
                    if (input === null) return null;
                    if (typeof input !== 'object' || Array.isArray(input)) throw new Error('AGE_OIDC must be a JSON object');
                    const { clientSecretSet, ...rest } = input;
                    return parseOidcConfig(Object.hasOwn(rest, 'clientSecret') ? rest : { ...rest, clientSecret: oidcConfig?.clientSecret ?? null });
                },
                apply: value => {
                    oidcConfig = value ? parseOidcConfig(value) : null;
                },
                encode: value => {
                    if (!value?.clientSecret) return value;
                    const { clientSecret, ...rest } = value;
                    return { ...rest, clientSecretEncrypted: secretCrypto().encrypt(clientSecret) };
                },
                decode: value => {
                    if (!value?.clientSecretEncrypted) return value;
                    const { clientSecretEncrypted, ...rest } = value;
                    return { ...rest, clientSecret: secretCrypto().decrypt(clientSecretEncrypted) };
                },
                view: describeOidcConfig
            }
        }
    });
    // Nur mit Neustart aenderbar: im Panel zur Ansicht, Geheimnisse nur als "gesetzt".
    const RESTART_ONLY = ['APP_MODES', 'DEFAULT_APP_MODE', 'LAN_MODE', 'APP_URL', 'INFO_HOST', 'TURN_SERVER', 'TURN_PORT', 'STUN_SERVER',
        'DATABASE_PATH', 'CREDENTIAL_RETENTION_DAYS', 'MEDIA_KEY_EPOCH_MINUTES', 'TRUST_PROXY', 'RATE_LIMIT_SCALE', 'VAPID_SUBJECT',
        'AGE_TRUST_CERTS', 'AGE_TRUSTED_LIST_URL', 'AGE_EUDI_DOCTYPES', 'AGE_EUDI_TEST', 'EMAIL_TRANSPORT', 'SMTP_FROM', 'NUDITY_MODEL_DIR'];
    const RESTART_ONLY_SECRETS = ['TURN_SECRET', 'SAFETY_KEY', 'SMTP_URL', 'VAPID_PRIVATE_KEY', 'ADMIN_SETUP_TOKEN'];
    const restartOnly = () => [
        ...RESTART_ONLY.map(key => ({ key, value: process.env[key] ?? null })),
        ...RESTART_ONLY_SECRETS.map(key => ({ key, secret: true, set: Boolean(process.env[key]) }))
    ];

    // Meldungen aus der App (server/reports.js), bearbeitet im Admin-Panel.
    registerReportRoutes(app, { store, allowRequest, requirePeerAuth, isString, log: app.log });

    // Admin-Panel (server/admin.js): Passkey-Login, Status, Auslastung, Sperren, Live-Konfiguration, Meldungen.
    registerAdminRoutes(app, {
        liveConfig, restartOnly, safety, disconnectPeer: peerId => signaling.disconnectPeer(peerId),
        isPeerOnline: peerId => signaling.isPeerOnline(peerId),
        store, metrics, allowRequest, log: app.log, now,
        appUrl: options.appUrl ?? process.env.APP_URL ?? '',
        // Fester Setup-Token (z. B. automatisiertes Aufsetzen, E2E); gilt nur, solange kein Passkey existiert.
        setupToken: options.adminSetupToken ?? (process.env.ADMIN_SETUP_TOKEN || null),
        status: () => ({
            version: buildVersion,
            built: buildTimestamp,
            system: metrics.system(),
            peers: { registered: store.admin.peerCount(), online: signaling.onlineCount(), sockets: signaling.socketCount() },
            pushSubscriptions: store.admin.pushCount(),
            queue: store.admin.queueTotals(now()),
            nudity: nudityPublicConfig.model === 'off'
                ? { model: 'off' }
                : { model: nudityPublicConfig.model, threshold: nudityPublicConfig.threshold, classes: nudityPublicConfig.classes, available: Object.keys(nudityPublicConfig.models || {}) },
            safety: { ...safety.publicConfig(), abuseLogDays: safetyConfig.abuseLogDays },
            ageTrust: safety.options().ageProvider === 'eudi' ? ageTrust.status() : null,
            latest: metrics.latest(),
            openReports: store.admin.openReportCount()
        })
    });
    // Testseite fuer den Wallet-Nachweis (Debug-Modus): prueft echt, speichert nichts (age-eudi.js).
    if (ageTestEnabled) {
        let testOrigins = [];
        try {
            const appUrl = String(options.appUrl ?? process.env.APP_URL ?? '').trim();
            testOrigins = appUrl ? [new URL(appUrl).origin] : [];
        } catch {
            testOrigins = [];
        }
        registerEudiTestRoutes(app, {
            allowRequest, requirePeerAuth, isString, appOrigins: testOrigins, log: app.log,
            createTrust: options.ageTestTrust ?? (() => [
                [EU_AGE_TEST_TRUSTED_LIST_URL, EU_AGE_TEST_TRUSTED_LIST_SIGNERS],
                [EU_AGE_TRUSTED_LIST_URL, EU_AGE_TRUSTED_LIST_SIGNERS]
            ].map(([listUrl, listSigners]) => createAgeTrustStore({
                config: { certsDirectory: null, listUrl, listSigners }, dataDirectory: null, log: app.log
            })))
        });
    }
    registerSafetyRoutes(app, { safety, allowRequest, requirePeerAuth, isString });

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
            eventHash,
            profileVersion,
            audience
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
        if (safety.isPeerBanned(peerId)) return reply.code(403).send({ error: 'Banned' });
        // Fehlt ein verlangter Nachweis, ist der Peer registriert (Token fuer /api/safety), aber unsichtbar.
        const missingVerification = safety.missing(peerId);
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
            silent: silent === true || missingVerification.length > 0,
            ttlMs: ttlMinutes != null ? ttlMinutes * 60 * 1000 : undefined,
            scope: peerScope,
            eventHash: peerScope === 'event' ? eventHash : null,
            // Nur der Zaehler der Profil-Version (Clients holen das Profil P2P nur bei Aenderung neu).
            profileVersion: Number.isSafeInteger(profileVersion) && profileVersion >= 0 && profileVersion <= 1e9 ? profileVersion : null,
            // Sichtbarkeitsregel als kurzer Code; der Router prueft die Form und mischt die Mindestwerte
            // des Betreibers hinein (auch ohne eigene Regel), wertet sie aber nie fuer Betrachter aus.
            audience: peerScope === 'friends' ? null : applyAudienceMinimum(
                typeof audience === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(audience) ? audience : null,
                audienceMinimums[peerScope], audienceSchemaFor(peerScope))
        };
        if (!store.registerPeer(session)) {
            return reply.code(403).send({ error: 'Peer identity is already registered' });
        }
        signaling.updatePeerCell(peerId, session.geohash, session.silent || peerScope !== 'public');
        safety.logAccess(peerId, request.ip);
        return {
            status: 'registered',
            geohash: session.geohash,
            peerId,
            authToken,
            ...(missingVerification.length ? { verificationRequired: missingVerification } : {})
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

    // Profil loeschen: alles zu diesem Peer weg (siehe store.deleteIdentity); die Verbindung wird getrennt.
    app.delete('/api/account/:peerId', async (request, reply) => {
        const { peerId } = request.params;
        if (!allowRequest('register', request.ip, reply)) return;
        if (!requirePeerAuth(request, reply, peerId)) return;
        store.deleteIdentity(peerId);
        signaling.disconnectPeer(peerId);
        return { status: 'deleted', peerId };
    });
    app.post('/api/unregister', unregister);

    app.get('/api/config', async () => ({ features: [...enabledFeatures()], modes: appModes, defaultMode: defaultAppMode, profileSchemas, lanMode: isLanMode, clientDefaults, infoUrl: infoSiteUrl(infoHost), safety: safety.publicConfig(), nudity: { ...nudityPublicConfig, required: nudityScanRequired },
        // Fuer die Anzeige in den Einstellungen ("vom Server vorgegeben").
        audienceMinimum: audienceMinimumRule ? (typeof audienceMinimumRule === 'string' ? JSON.parse(audienceMinimumRule) : audienceMinimumRule) : null }));

    const toGridPeer = (origin) => ({ peer, km }) => ({
        id: peer.peerId,
        avatar: peer.thumbnail,
        name: peer.name,
        version: peer.profileVersion ?? null,
        ...(peer.audience ? { audience: peer.audience } : {}),
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

        // Mit Nachweis-Pflicht sieht das Grid nur, wer angemeldet und nachgewiesen ist.
        let sameAgeGroup = () => true;
        if (safety.active) {
            const { peerId } = request.query;
            if (!isString(peerId, 200)) return reply.code(401).send({ error: 'Peer authentication required' });
            if (!requirePeerAuth(request, reply, peerId)) return;
            const missing = safety.missing(peerId);
            if (missing.length) return reply.code(403).send({ error: 'Verification required', verificationRequired: missing });
            // Entdecken und Event getrennt nach Altersgruppe: unter 18 sieht nur unter 18, 18+ nur 18+.
            if (safety.ageSeparationActive) {
                const group = safety.ageGroupOf(peerId);
                sameAgeGroup = peer => safety.ageGroupOf(peer.peerId) === group;
            }
        }

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
            const peers = withDistance(origin, store.getEventPeers(eventHash).filter(sameAgeGroup));
            return { geohash: normalizedGeohash, scope, count: peers.length, hasMore: false, peers: peers.map(toGridPeer(origin)), removedPeerIds: [] };
        }

        if (scope !== 'public') return reply.code(400).send({ error: 'Invalid scope' });
        if (!appModes.includes('discovery')) return reply.code(403).send({ error: 'Mode not enabled' });
        const ring = request.query.ring == null ? 0 : Number(request.query.ring);
        if (!Number.isInteger(ring) || ring < 0 || ring > MAX_GRID_RING) {
            return reply.code(400).send({ error: 'Invalid ring' });
        }
        const liveOnly = live === '1';
        const visible = peer => (!liveOnly || signaling.isPeerOnline(peer.peerId)) && sameAgeGroup(peer);

        const grid = store.getGridArea(gridRingCells(normalizedGeohash, ring));
        // Entfernung nur zwischen Zellmittelpunkten; die Antwort enthaelt weder Koordinaten noch Geohash.
        const peers = withDistance(origin, grid.peers.filter(visible));
        // Naechster Ring, der wirklich neue Peers bringt; leere Ringe dazwischen ueberspringt die App.
        // (Frueher nur ring + 1: war der leer, endete das Nachladen, obwohl weiter weg jemand war.)
        let nextRing = null;
        for (let candidate = ring + 1; candidate <= MAX_GRID_RING && nextRing === null; candidate += 1) {
            if (store.getGridArea(gridRingCells(normalizedGeohash, candidate)).peers.filter(visible).length > peers.length) nextRing = candidate;
        }
        return {
            geohash: normalizedGeohash,
            ring,
            count: peers.length,
            hasMore: nextRing !== null,
            nextRing,
            peers: peers.map(toGridPeer(origin)),
            removedPeerIds: grid.removedPeerIds
        };
    });

    async function notifyRecipient(message, kind = 'chat') {
        const subscription = store.getPushSubscription(message.recipientId);
        // Auch alte, vor der Allowlist gespeicherte Subscriptions nie an fremde Hosts.
        if (!subscription || !isAllowedPushEndpoint(subscription.endpoint, pushHostAllowlist)) return;
        const fullPayload = {
            type: 'PATH_C',
            kind,
            msgId: message.msgId,
            senderId: message.senderId,
            ciphertextPayload: message.ciphertextPayload,
            ivHex: message.ivHex
        };
        // Grosse Payloads (z. B. Snaps) passen nicht in einen Push. Dann geht
        // nur der Hinweis raus und der Service Worker holt den Rest aus der Queue.
        const payload = Buffer.byteLength(JSON.stringify(fullPayload)) <= MAX_PUSH_PLAINTEXT_BYTES
            ? fullPayload
            : { type: 'PATH_C', kind, msgId: message.msgId, senderId: message.senderId };
        try {
            const result = await sendPush(subscription, payload);
            if (result.expired) store.deletePushSubscription(message.recipientId, subscription.endpoint);
        } catch (error) {
            app.log.warn(`Web Push delivery failed: ${error.message}`);
        }
    }

    // Benachrichtigungsarten (Einstellungen > Benachrichtigungen). Der Absender nennt die Art beim Push
    // (Cache-Eintrag oder Anstupsen); der Empfaenger hinterlegt, welche er nicht per Push will. Ohne das
    // muesste der Service Worker Pushes still verwerfen, und Browser zeigen dann eigene Meldungen bzw.
    // entziehen das Push-Recht. Der Server erfaehrt so nur die Art, nie den Inhalt.
    const PUSH_KINDS = ['chat', 'discovery', 'flame', 'match', 'add', 'profileView'];
    const pushWanted = (recipientId, kind) => !store.getPushMutedKinds(recipientId).includes(kind);

    app.get('/api/push/vapid-public-key', async () => ({ publicKey: vapidKeys.publicKey }));

    app.post('/api/push/settings', async (request, reply) => {
        if (!allowRequest('push', request.ip, reply)) return;
        const { peerId, mutedKinds } = request.body || {};
        if (!isString(peerId, 200) || !Array.isArray(mutedKinds) || mutedKinds.length > PUSH_KINDS.length) {
            return reply.code(400).send({ error: 'Invalid parameters' });
        }
        if (!requirePeerAuth(request, reply, peerId)) return;
        const kinds = [...new Set(mutedKinds.filter(kind => PUSH_KINDS.includes(kind)))];
        const updated = store.setPushMutedKinds(peerId, kinds);
        return { status: updated ? 'saved' : 'no-subscription', mutedKinds: kinds };
    });

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

    // Anstupsen: der Absender hat direkt (P2P) zugestellt, der Empfaenger ist aber abwesend (App im
    // Hintergrund) oder offline. Dann kommt sonst keine Benachrichtigung, weil kein Push ueber den
    // Zwischenspeicher lief. Der Push traegt nur die Absender-ID, keinen Inhalt. Nur wenn der Empfaenger
    // wirklich abwesend/offline ist, den Absender nicht blockiert hat und Push eingerichtet hat.
    const NUDGE_PAIR_INTERVAL_MS = 15_000;
    const lastNudges = new Map();
    app.post('/api/push/nudge', async (request, reply) => {
        const { senderId, recipientId } = request.body || {};
        const kind = PUSH_KINDS.includes(request.body?.kind) ? request.body.kind : 'chat';
        if (!isString(senderId, 200) || !isString(recipientId, 200) || senderId === recipientId) {
            return reply.code(400).send({ error: 'Invalid parameters' });
        }
        if (!requirePeerAuth(request, reply, senderId)) return;
        if (!allowRequest('nudge', senderId, reply)) return;
        const pair = `${senderId}:${recipientId}:${kind}`;
        const current = now();
        if (store.isBlocked(recipientId, senderId)) return reply.code(202).send({ status: 'skipped' });
        if (signaling.isPeerOnline(recipientId) && !signaling.isPeerAway(recipientId)) return reply.code(202).send({ status: 'skipped' });
        if (current - (lastNudges.get(pair) || 0) < NUDGE_PAIR_INTERVAL_MS) return reply.code(202).send({ status: 'skipped' });
        if (!pushWanted(recipientId, kind)) return reply.code(202).send({ status: 'skipped' });
        const subscription = store.getPushSubscription(recipientId);
        if (!subscription || !isAllowedPushEndpoint(subscription.endpoint, pushHostAllowlist)) return reply.code(202).send({ status: 'skipped' });
        lastNudges.set(pair, current);
        if (lastNudges.size > 5000) lastNudges.delete(lastNudges.keys().next().value);
        sendPush(subscription, { type: 'NUDGE', senderId, kind })
            .then(result => { if (result.expired) store.deletePushSubscription(recipientId, subscription.endpoint); })
            .catch(error => app.log.warn(`Web Push nudge failed: ${error.message}`));
        return reply.code(202).send({ status: 'sent' });
    });

    // Groesseres Limit nur hier: Sprachnachrichten (bis 60 s) gehen als Ganzes durch den Cache.
    app.post('/api/cache', { bodyLimit: CACHE_BODY_LIMIT }, async (request, reply) => {
        const { recipientId, senderId, ciphertextPayload, ivHex, ttlHours, notify } = request.body || {};
        // Art fuer die Benachrichtigung (ohne Angabe: Chat-Nachricht, wie aeltere Clients).
        const notifyKind = PUSH_KINDS.includes(request.body?.notifyKind) ? request.body.notifyKind : 'chat';
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
        const pushRequested = notify === true && Boolean(store.getPushSubscription(recipientId)) && pushWanted(recipientId, notifyKind);
        if (pushRequested) notifyRecipient(message, notifyKind);
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
