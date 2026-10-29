import { isIP } from 'node:net';

// ================= Rate-Limits =================
// Einfacher Token-Zaehler pro Schluessel (IP, Peer) im Speicher. Reicht fuer einen einzelnen
// Container; jeder buildApp-Aufruf bekommt eigene Zaehler.
export function createRateLimiter({ windowMs, max }) {
    const buckets = new Map();
    let lastSweep = Date.now();
    return {
        // true = erlaubt; sonst die Wartezeit in Sekunden.
        take(key, now = Date.now()) {
            if (now - lastSweep > windowMs) {
                for (const [bucketKey, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(bucketKey);
                lastSweep = now;
            }
            let bucket = buckets.get(key);
            if (!bucket || bucket.resetAt <= now) {
                bucket = { count: 0, resetAt: now + windowMs };
                buckets.set(key, bucket);
            }
            bucket.count += 1;
            return bucket.count <= max ? true : Math.ceil((bucket.resetAt - now) / 1000);
        }
    };
}

export const DEFAULT_RATE_LIMITS = {
    register: { windowMs: 60_000, max: 30 },
    admin: { windowMs: 60_000, max: 120 },
    // Meldungen aus der App: je Peer hoechstens 10 pro Stunde.
    reports: { windowMs: 60 * 60_000, max: 10 },
    grid: { windowMs: 60_000, max: 90 },
    cache: { windowMs: 60_000, max: 120 },
    chatControls: { windowMs: 60_000, max: 30 },
    push: { windowMs: 60_000, max: 10 },
    safety: { windowMs: 60_000, max: 20 },
    nudge: { windowMs: 60_000, max: 30 },
    websocket: { windowMs: 10_000, max: 300 }
};

// Testumgebungen mit vielen Clients hinter einer IP (z. B. E2E) heben die Grenzen per
// RATE_LIMIT_SCALE an (Faktor fuer `max`, 1 bis 100; Standard 1).
export function scaleRateLimits(limits, scale) {
    const factor = Math.min(100, Math.max(1, Math.floor(Number(scale) || 1)));
    return Object.fromEntries(Object.entries(limits).map(([name, config]) => [name, { ...config, max: config.max * factor }]));
}

// ================= Push-Endpunkte =================
// Der Server sendet Web Pushes an die Endpoint-URL der Subscription. Ohne Allowlist koennte ein
// Client den Server so gegen beliebige (auch interne) https-Hosts schicken (SSRF).
export const DEFAULT_PUSH_HOSTS = [
    'fcm.googleapis.com',
    'android.googleapis.com',
    '*.push.services.mozilla.com',
    'web.push.apple.com',
    '*.push.apple.com',
    '*.notify.windows.com'
];

export function parsePushHostAllowlist(value) {
    const extra = String(value || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
    return [...new Set([...DEFAULT_PUSH_HOSTS, ...extra])];
}

function hostMatches(hostname, pattern) {
    if (pattern.startsWith('*.')) return hostname.endsWith(pattern.slice(1)) && hostname.length > pattern.length - 1;
    return hostname === pattern;
}

export function isAllowedPushEndpoint(endpoint, allowlist) {
    let url;
    try {
        url = new URL(endpoint);
    } catch {
        return false;
    }
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    // IP-Adressen nie, auch keine oeffentlichen: Push-Dienste haben Hostnamen.
    if (isIP(hostname)) return false;
    return allowlist.some(pattern => hostMatches(hostname, pattern));
}

// ================= Logs =================
// Keine Query-Strings (geohash, peerId, eventHash) und keine IP-Adressen in Logs.
export function buildLoggerOptions(logger) {
    if (!logger) return false;
    const serializers = {
        req(request) {
            return { method: request.method, url: String(request.url || '').split('?')[0] };
        },
        res(reply) {
            return { statusCode: reply.statusCode };
        }
    };
    return logger === true ? { serializers } : { ...logger, serializers };
}

// ================= Header =================
const NOMINATIM_ORIGIN = 'https://nominatim.openstreetmap.org';

export function securityHeaders(host, { wasm = false } = {}) {
    // Skripte nur von der eigenen Origin, keine Inline-Handler (siehe client/app/actions.js).
    // Inline-Styles (style-Attribute) bleiben erlaubt.
    const socketOrigins = host ? ` ws://${host} wss://${host}` : '';
    return {
        'Content-Security-Policy': [
            "default-src 'self'",
            // 'wasm-unsafe-eval' nur fuer den Nacktbild-Worker (eigene CSP je Worker-Skript).
            wasm ? "script-src 'self' 'wasm-unsafe-eval'" : "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            "font-src 'self'",
            `connect-src 'self'${socketOrigins} ${NOMINATIM_ORIGIN}`,
            "worker-src 'self'",
            "manifest-src 'self' data:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'"
        ].join('; '),
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=(self)',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'X-Frame-Options': 'DENY'
    };
}

// ================= Proxy =================
// Standard: nur Proxies aus Loopback und privaten Netzen (typischer Reverse Proxy im Docker-Netz).
export function parseTrustProxy(value) {
    if (value === undefined || value === null || value === '') return 'loopback,linklocal,uniquelocal';
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    if (/^\d+$/.test(String(value))) return Number(value);
    return String(value);
}
