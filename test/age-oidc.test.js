import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';
import { classifyAgeClaim, claimValue, describeOidcConfig, parseOidcConfig } from '../server/age-oidc.js';

const ISSUER = 'https://idp.example.org';
const APP = 'https://og.example.org';
const apps = [];
afterEach(async () => {
    while (apps.length) {
        const { app, store } = apps.pop();
        await app.close();
        store.close();
    }
});

// Nachgebauter OIDC-Dienst: Discovery, JWKS, Token- und Userinfo-Endpunkt ueber einen fetch-Ersatz.
function fakeProvider() {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'ES256', use: 'sig' };
    const provider = {
        claims: { age_over_18: true },
        userinfo: null,
        override: {},
        sign: keys.privateKey,
        authorizations: [],
        tokenRequests: []
    };
    provider.fetch = async (url, init = {}) => {
        const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        const target = new URL(url);
        if (target.pathname === '/.well-known/openid-configuration') {
            return json(200, {
                issuer: ISSUER,
                authorization_endpoint: `${ISSUER}/authorize`,
                token_endpoint: `${ISSUER}/token`,
                jwks_uri: `${ISSUER}/jwks`,
                userinfo_endpoint: `${ISSUER}/userinfo`
            });
        }
        if (target.pathname === '/jwks') return json(200, { keys: [jwk] });
        if (target.pathname === '/token') {
            const body = new URLSearchParams(init.body);
            provider.tokenRequests.push({ body, headers: init.headers });
            const authorization = provider.authorizations.find(entry => entry.code === body.get('code'));
            if (!authorization) return json(400, { error: 'invalid_grant' });
            const header = { alg: 'ES256', kid: 'k1', typ: 'JWT' };
            const now = Math.floor(Date.now() / 1000);
            const payload = {
                iss: ISSUER, aud: 'opengrid', sub: authorization.sub, iat: now, exp: now + 300, nonce: authorization.nonce,
                ...provider.claims, ...provider.override
            };
            const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
            const signature = sign('sha256', Buffer.from(input), { key: provider.sign, dsaEncoding: 'ieee-p1363' }).toString('base64url');
            return json(200, { id_token: `${input}.${signature}`, access_token: 'access-1', token_type: 'Bearer' });
        }
        if (target.pathname === '/userinfo') return json(200, provider.userinfo || {});
        return json(404, { error: 'not found' });
    };
    // Nutzer meldet sich beim Dienst an: der Dienst merkt sich nonce und gibt einen code zurueck.
    provider.authorize = (url, sub = 'person-1') => {
        const params = new URL(url).searchParams;
        const code = randomBytes(8).toString('hex');
        provider.authorizations.push({ code, nonce: params.get('nonce'), sub });
        return { code, state: params.get('state'), params };
    };
    return provider;
}

async function startApp(provider, ageOidc = {}) {
    const store = createStore(':memory:');
    const app = await buildApp({
        store, buildVersion: 'x', buildTimestamp: 'y', appUrl: APP,
        safety: { ageCheck: 'provider', ageProvider: 'oidc' },
        ageOidc: { issuer: ISSUER, clientId: 'opengrid', clientSecret: 's3cret', ...ageOidc },
        ageOidcFetch: provider.fetch
    });
    apps.push({ app, store });
    return { app, store };
}

async function register(app, peerId) {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const registrationId = `registration-${peerId}`;
    const authToken = randomBytes(32).toString('base64url');
    const signature = sign('sha256', Buffer.from(JSON.stringify({ peerId, registrationId, authToken })), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
    await app.inject({
        method: 'POST',
        url: '/api/register',
        payload: {
            peerId, registrationId, geohash: 'u10j2k', authToken,
            registrationProof: { publicKey: keys.publicKey.export({ format: 'jwk' }), signature: signature.toString('base64') }
        }
    });
    return { authorization: `Bearer ${authToken}` };
}

const startCheck = async (app, peerId, headers) => app.inject({ method: 'POST', url: '/api/safety/age/start', headers, payload: { peerId } });
const finishCheck = (app, peerId, headers, payload) => app.inject({ method: 'POST', url: '/api/safety/age/finish', headers, payload: { peerId, payload } });
const statusOf = async (app, peerId, headers) => (await app.inject({ method: 'GET', url: `/api/safety/status?peerId=${peerId}`, headers })).json();

async function runFlow(app, provider, peerId, sub) {
    const headers = await register(app, peerId);
    const start = (await startCheck(app, peerId, headers)).json();
    assert.equal(start.kind, 'redirect');
    const { code, state } = provider.authorize(start.url, sub);
    return { headers, response: await finishCheck(app, peerId, headers, { code, state }) };
}

test('oidc config: defaults, validation, secret only as "set"', () => {
    assert.equal(parseOidcConfig({}), null, 'no issuer = not set up');
    const config = parseOidcConfig({ issuer: `${ISSUER}/`, clientId: 'a', clientSecret: 'b', scope: 'age' });
    assert.equal(config.issuer, ISSUER);
    assert.equal(config.scope, 'openid age');
    assert.equal(config.claim, 'age_over_18');
    assert.equal(config.adultValue, true);
    assert.equal(config.minorValue, false);
    assert.equal(parseOidcConfig({ issuer: ISSUER, clientId: 'a', minorValue: '' }).minorValue, null, 'empty = never under 18');
    assert.equal(parseOidcConfig({ issuer: ISSUER, clientId: 'a', adultValue: '"yes"', minorValue: '"no"' }).adultValue, 'yes');
    assert.throws(() => parseOidcConfig({ issuer: 'http://idp.example.org', clientId: 'a' }), /https/);
    assert.throws(() => parseOidcConfig({ issuer: ISSUER }), /clientId/);
    assert.throws(() => parseOidcConfig({ issuer: ISSUER, clientId: 'a', adultValue: true, minorValue: true }), /differ/);
    assert.deepEqual(Object.keys(describeOidcConfig(config)).includes('clientSecret'), false);
    assert.equal(describeOidcConfig(config).clientSecretSet, true);
});

test('oidc claim: strict values, nested paths, under 18 only when stated explicitly', () => {
    const config = parseOidcConfig({ issuer: ISSUER, clientId: 'a' });
    assert.equal(classifyAgeClaim(true, config), 'adult');
    assert.equal(classifyAgeClaim(false, config), 'minor');
    for (const unclear of [undefined, null, 'true', 'false', 1, 0, {}]) assert.equal(classifyAgeClaim(unclear, config), null, String(unclear));
    assert.equal(claimValue({ age: { over_18: true } }, 'age.over_18'), true);
    assert.equal(claimValue({ age: null }, 'age.over_18'), undefined);
    const neverMinor = parseOidcConfig({ issuer: ISSUER, clientId: 'a', minorValue: null });
    assert.equal(classifyAgeClaim(false, neverMinor), null);
});

test('oidc flow: redirect with PKCE, adult proof stored without tokens', async () => {
    const provider = fakeProvider();
    const { app } = await startApp(provider);
    const headers = await register(app, 'alice');
    const start = (await startCheck(app, 'alice', headers)).json();
    const authorize = new URL(start.url);
    assert.equal(authorize.origin + authorize.pathname, `${ISSUER}/authorize`);
    assert.equal(authorize.searchParams.get('redirect_uri'), `${APP}/age-callback`);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('scope'), 'openid');

    const { code, state } = provider.authorize(start.url);
    const finished = await finishCheck(app, 'alice', headers, { code, state });
    assert.equal(finished.statusCode, 200, finished.body);
    assert.equal(finished.json().group, 'adult');
    assert.match(provider.tokenRequests[0].headers.authorization, /^Basic /, 'client secret via HTTP Basic');
    assert.ok(provider.tokenRequests[0].body.get('code_verifier'));
    assert.equal((await statusOf(app, 'alice', headers)).age.group, 'adult');

    const replay = await finishCheck(app, 'alice', headers, { code, state });
    assert.equal(replay.statusCode, 403, 'state is single use');
    assert.equal((await app.inject({ method: 'GET', url: '/age-callback?code=x&state=y' })).statusCode, 200, 'callback page is the app');
});

test('oidc flow: explicit "not 18" = under 18 group, missing or unclear claim = refused', async () => {
    const provider = fakeProvider();
    const { app } = await startApp(provider);

    provider.claims = { age_over_18: false };
    const minor = await runFlow(app, provider, 'bob', 'person-2');
    assert.equal(minor.response.statusCode, 200);
    assert.equal(minor.response.json().group, 'minor');

    provider.claims = {};
    const missing = await runFlow(app, provider, 'carol', 'person-3');
    assert.equal(missing.response.statusCode, 403);
    assert.match(missing.response.json().reason, /missing/);
    assert.equal((await statusOf(app, 'carol', missing.headers)).age.verified, false);

    provider.claims = { age_over_18: 'false' };
    const unclear = await runFlow(app, provider, 'dave', 'person-4');
    assert.equal(unclear.response.statusCode, 403, 'strings are not booleans');

    // Claim nur am userinfo-Endpunkt.
    provider.claims = {};
    provider.userinfo = { sub: 'person-5', age_over_18: true };
    const userinfo = await runFlow(app, provider, 'erin', 'person-5');
    assert.equal(userinfo.response.json().group, 'adult');
    provider.userinfo = { sub: 'someone-else', age_over_18: true };
    assert.equal((await runFlow(app, provider, 'frank', 'person-6')).response.statusCode, 403, 'userinfo of another person');
});

test('oidc flow: wrong nonce, audience, signature or peer is refused', async () => {
    const provider = fakeProvider();
    const { app } = await startApp(provider);

    provider.override = { nonce: 'other' };
    assert.match((await runFlow(app, provider, 'p1')).response.json().reason, /nonce/);
    provider.override = { aud: 'someone-else' };
    assert.match((await runFlow(app, provider, 'p2')).response.json().reason, /aud/);
    provider.override = { iss: 'https://evil.example.org' };
    assert.match((await runFlow(app, provider, 'p3')).response.json().reason, /iss/);
    provider.override = { exp: Math.floor(Date.now() / 1000) - 3600 };
    assert.match((await runFlow(app, provider, 'p4')).response.json().reason, /expired/);
    provider.override = {};
    provider.sign = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    assert.match((await runFlow(app, provider, 'p5')).response.json().reason, /signature/);

    // state von Peer A kann Peer B nicht einloesen.
    const fresh = fakeProvider();
    const other = await startApp(fresh);
    const alice = await register(other.app, 'alice');
    const mallory = await register(other.app, 'mallory');
    const start = (await startCheck(other.app, 'mallory', mallory)).json();
    const { code, state } = fresh.authorize(start.url);
    const stolen = await finishCheck(other.app, 'alice', alice, { code, state });
    assert.equal(stolen.statusCode, 403);
    assert.match(stolen.json().reason, /state/);
});

test('oidc: provider without an issuer answers 503', async () => {
    const provider = fakeProvider();
    const { app } = await startApp(provider, { issuer: '' });
    const headers = await register(app, 'alice');
    assert.equal((await startCheck(app, 'alice', headers)).statusCode, 503, 'no issuer set up yet');
});
