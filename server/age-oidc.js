// Altersnachweis ueber einen beliebigen OpenID-Connect-Dienst (AGE_PROVIDER=oidc, Board T2).
// Gedacht fuer KJM-anerkannte Pruefdienste und eID-Service-Anbieter, die OIDC anbieten
// (documentation/ALTERSNACHWEIS-DEUTSCHLAND.md). Ablauf: Authorization Code + PKCE; der Dienst leitet
// auf die App zurueck (/age-callback), die App reicht code + state an /api/safety/age/finish weiter.
// Der Router prueft das ID-Token (Signatur ueber JWKS, iss, aud, exp, nonce) und liest genau einen
// Claim ("ab 18"). "Unter 18" gilt nur, wenn der Dienst das ausdruecklich sagt (Wert = minorValue);
// fehlt der Claim oder ist er unklar, wird abgelehnt. Gespeichert wird nur die Altersgruppe und ein
// HMAC von "oidc:<iss>:<sub>" (fuer Sperren), nie Name, Geburtsdatum oder Tokens.
import { createHash, createPublicKey, randomBytes, verify as verifySignature, constants } from 'node:crypto';

const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 2000;
const METADATA_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 120;
const FETCH_TIMEOUT_MS = 10000;
const MAX_FIELD_LENGTH = 2048;

// Signaturverfahren -> Parameter fuer node:crypto. "none" und HMAC (HS*) gibt es bewusst nicht.
const ALGORITHMS = {
    RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
    PS256: { hash: 'sha256', pss: 32 }, PS384: { hash: 'sha384', pss: 48 }, PS512: { hash: 'sha512', pss: 64 },
    ES256: { hash: 'sha256', ecdsa: true }, ES384: { hash: 'sha384', ecdsa: true }, ES512: { hash: 'sha512', ecdsa: true },
    EdDSA: { hash: null }
};

const base64url = bytes => Buffer.from(bytes).toString('base64url');

function parseJsonValue(value, fallback) {
    if (value === undefined) return fallback;
    if (value === null) return null;
    if (typeof value !== 'string') return value;
    const text = value.trim();
    if (text === '') return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function validUrl(value, name) {
    let url;
    try {
        url = new URL(String(value));
    } catch {
        throw new Error(`${name} must be a URL`);
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error(`${name} must use https`);
    return url.toString().replace(/\/$/, '');
}

function field(value, name, { required = false } = {}) {
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (required && !text) throw new Error(`${name} is missing`);
    if (text.length > MAX_FIELD_LENGTH) throw new Error(`${name} is too long`);
    return text || null;
}

// Konfiguration aus Umgebung oder Admin-Panel. null = nicht eingerichtet (kein Aussteller).
// adultValue/minorValue: JSON-Werte, Standard true/false; minorValue null = nie "unter 18".
export function parseOidcConfig(source = {}) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('AGE_OIDC must be a JSON object');
    const issuer = field(source.issuer, 'issuer');
    if (!issuer) return null;
    const claim = field(source.claim, 'claim') || 'age_over_18';
    const adultValue = parseJsonValue(source.adultValue, true);
    if (adultValue === null) throw new Error('adultValue must not be empty');
    const minorValue = parseJsonValue(source.minorValue, false);
    if (minorValue !== null && JSON.stringify(minorValue) === JSON.stringify(adultValue)) throw new Error('adultValue and minorValue must differ');
    const scope = field(source.scope, 'scope') || 'openid';
    return {
        issuer: validUrl(issuer, 'issuer'),
        clientId: field(source.clientId, 'clientId', { required: true }),
        clientSecret: field(source.clientSecret, 'clientSecret'),
        scope: scope.split(/\s+/).includes('openid') ? scope : `openid ${scope}`,
        claim,
        adultValue,
        minorValue,
        redirectUri: source.redirectUri ? validUrl(source.redirectUri, 'redirectUri') : null
    };
}

// Fuer Anzeige (Admin-Panel, Status): das Geheimnis nur als "gesetzt".
export function describeOidcConfig(config) {
    if (!config) return null;
    const { clientSecret, ...visible } = config;
    return { ...visible, clientSecretSet: Boolean(clientSecret) };
}

// Wert eines Claims, auch verschachtelt ("age.over_18").
export function claimValue(claims, path) {
    let value = claims;
    for (const part of String(path).split('.')) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
        value = value[part];
    }
    return value;
}

// Strenger Vergleich: true != "true", 1 != true.
function sameValue(left, right) {
    return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

export function classifyAgeClaim(value, config) {
    if (sameValue(value, config.adultValue)) return 'adult';
    if (config.minorValue !== null && sameValue(value, config.minorValue)) return 'minor';
    return null;
}

function decodeJwt(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('id_token is not a JWS');
    const [header, payload] = parts.slice(0, 2).map(part => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
    return { header, payload, signingInput: Buffer.from(`${parts[0]}.${parts[1]}`), signature: Buffer.from(parts[2], 'base64url') };
}

function verifyJws(jwt, jwk) {
    const algorithm = ALGORITHMS[jwt.header.alg];
    if (!algorithm) throw new Error(`id_token algorithm ${jwt.header.alg} is not allowed`);
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const options = algorithm.pss
        ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: algorithm.pss }
        : algorithm.ecdsa ? { key, dsaEncoding: 'ieee-p1363' } : key;
    return verifySignature(algorithm.hash, jwt.signingInput, options, jwt.signature);
}

export function createOidcAgeProvider({ getConfig, fetch: fetchFn = globalThis.fetch, now = Date.now, defaultRedirectUri = () => null, log }) {
    const pending = new Map();
    let metadataCache = null;
    let jwksCache = null;

    async function getJson(url, init = {}) {
        const response = await fetchFn(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        const text = await response.text();
        let data = null;
        try {
            data = JSON.parse(text);
        } catch {
            data = null;
        }
        if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}${data?.error ? ` (${data.error})` : ''}`);
        if (!data || typeof data !== 'object') throw new Error(`${new URL(url).host} did not answer with JSON`);
        return data;
    }

    // Discovery (.well-known/openid-configuration), eine Stunde zwischengespeichert.
    async function metadata(config) {
        if (metadataCache?.issuer === config.issuer && metadataCache.expiresAt > now()) return metadataCache.value;
        const value = await getJson(`${config.issuer}/.well-known/openid-configuration`);
        if (String(value.issuer || '').replace(/\/$/, '') !== config.issuer) throw new Error('Issuer in the discovery document does not match');
        for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) validUrl(value[key], key);
        metadataCache = { issuer: config.issuer, value, expiresAt: now() + METADATA_TTL_MS };
        return value;
    }

    // Schluessel des Dienstes; unbekannte kid -> einmal neu laden (Schluesselwechsel).
    async function signingKey(meta, header) {
        const pick = keys => {
            const usable = keys.filter(key => (!key.use || key.use === 'sig') && (!key.alg || key.alg === header.alg));
            return header.kid ? usable.find(key => key.kid === header.kid) : usable.length === 1 ? usable[0] : null;
        };
        if (jwksCache?.uri === meta.jwks_uri && jwksCache.expiresAt > now()) {
            const key = pick(jwksCache.keys);
            if (key) return key;
        }
        const jwks = await getJson(meta.jwks_uri);
        const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
        jwksCache = { uri: meta.jwks_uri, keys, expiresAt: now() + METADATA_TTL_MS };
        const key = pick(keys);
        if (!key) throw new Error('No matching signing key for the id_token');
        return key;
    }

    function prunePending() {
        const time = now();
        for (const [state, entry] of pending) if (entry.expiresAt <= time) pending.delete(state);
        while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    }

    return {
        id: 'oidc',
        get configured() {
            return Boolean(getConfig());
        },

        async start({ peerId, origin }) {
            const config = getConfig();
            if (!config) return { kind: 'unavailable' };
            const meta = await metadata(config);
            const redirectUri = config.redirectUri || defaultRedirectUri(origin);
            if (!redirectUri) throw new Error('No redirect URI (set APP_URL or redirectUri)');
            prunePending();
            const state = base64url(randomBytes(24));
            const nonce = base64url(randomBytes(24));
            const verifier = base64url(randomBytes(48));
            pending.set(state, { peerId, nonce, verifier, redirectUri, issuer: config.issuer, expiresAt: now() + PENDING_TTL_MS });
            const url = new URL(meta.authorization_endpoint);
            for (const [key, value] of Object.entries({
                response_type: 'code',
                client_id: config.clientId,
                redirect_uri: redirectUri,
                scope: config.scope,
                state,
                nonce,
                code_challenge: base64url(createHash('sha256').update(verifier).digest()),
                code_challenge_method: 'S256'
            })) url.searchParams.set(key, value);
            return { kind: 'redirect', url: url.toString() };
        },

        async finish({ peerId, payload }) {
            const config = getConfig();
            if (!config) return { over18: false, reason: 'not configured' };
            if (typeof payload?.state !== 'string' || typeof payload?.code !== 'string' || payload.code.length > MAX_FIELD_LENGTH) {
                return { over18: false, reason: payload?.error ? `provider: ${String(payload.error).slice(0, 80)}` : 'code missing' };
            }
            const entry = pending.get(payload.state);
            pending.delete(payload.state);
            // state gehoert zu genau diesem Peer (kein Unterschieben fremder Nachweise).
            if (!entry || entry.expiresAt <= now() || entry.peerId !== peerId || entry.issuer !== config.issuer) return { over18: false, reason: 'unknown or expired state' };
            try {
                const meta = await metadata(config);
                const body = new URLSearchParams({ grant_type: 'authorization_code', code: payload.code, redirect_uri: entry.redirectUri, code_verifier: entry.verifier });
                const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
                if (config.clientSecret) {
                    const encode = value => encodeURIComponent(value).replace(/%20/g, '+');
                    headers.authorization = `Basic ${Buffer.from(`${encode(config.clientId)}:${encode(config.clientSecret)}`).toString('base64')}`;
                } else {
                    body.set('client_id', config.clientId);
                }
                const tokens = await getJson(meta.token_endpoint, { method: 'POST', headers, body: body.toString() });
                const jwt = decodeJwt(tokens.id_token);
                if (!verifyJws(jwt, await signingKey(meta, jwt.header))) return { over18: false, reason: 'id_token signature invalid' };
                const claims = jwt.payload;
                const time = Math.floor(now() / 1000);
                const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
                if (String(claims.iss || '').replace(/\/$/, '') !== config.issuer) return { over18: false, reason: 'iss mismatch' };
                if (!audiences.includes(config.clientId) || (audiences.length > 1 && claims.azp !== config.clientId)) return { over18: false, reason: 'aud mismatch' };
                if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < time) return { over18: false, reason: 'id_token expired' };
                if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > time) return { over18: false, reason: 'id_token from the future' };
                if (claims.nonce !== entry.nonce) return { over18: false, reason: 'nonce mismatch' };
                if (typeof claims.sub !== 'string' || !claims.sub) return { over18: false, reason: 'sub missing' };

                // Claim im ID-Token, sonst am userinfo-Endpunkt (gleiches sub).
                let value = claimValue(claims, config.claim);
                if (value === undefined && meta.userinfo_endpoint && tokens.access_token) {
                    const userinfo = await getJson(validUrl(meta.userinfo_endpoint, 'userinfo_endpoint'), { headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' } });
                    if (userinfo.sub === claims.sub) value = claimValue(userinfo, config.claim);
                }
                const group = classifyAgeClaim(value, config);
                if (!group) return { over18: false, reason: value === undefined ? `claim ${config.claim} missing` : `claim ${config.claim} is not conclusive` };
                return { over18: group === 'adult', minor: group === 'minor', subject: `oidc:${config.issuer}:${claims.sub}` };
            } catch (error) {
                log?.warn?.(`OIDC age check failed: ${error.message}`);
                return { over18: false, reason: error.message };
            }
        }
    };
}
