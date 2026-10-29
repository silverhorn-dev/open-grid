import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign, webcrypto } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import * as x509 from '@peculiar/x509';
import { DeviceResponse, Document, MDoc } from '@animo-id/mdoc';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';
import { createMdocContext, eudiRequest, eudiSessionTranscripts, parseEudiDoctypes } from '../server/age-eudi.js';
import { createAgeTrustStore, derToPem, parseAgeTrustConfig, parseAgeTrustedList } from '../server/age-trust.js';

x509.cryptoProvider.set(webcrypto);
const LIST = readFileSync(new URL('./fixtures/eu-av-trusted-list-2026-05-19.xml', import.meta.url), 'utf8');
const LIST_DATE = new Date('2026-10-29T12:00:00Z');
const silent = { info() {}, warn() {}, error() {} };
const cleanup = [];
afterEach(async () => {
    while (cleanup.length) await cleanup.pop()();
});

// ----- EU-Liste -----
test('EU age trusted list: signature and signer pin checked, PAA issuers extracted', () => {
    const parsed = parseAgeTrustedList(LIST, { now: LIST_DATE });
    assert.equal(parsed.issuers.length, 1);
    assert.equal(parsed.issuers[0].provider, 'Digitaliseringsstyrelsen');
    assert.equal(parsed.nextUpdate, '2026-11-11T13:00:00Z');
    assert.throws(() => parseAgeTrustedList(LIST.replace('Digitaliseringsstyrelsen', 'Digitaliseringsstyrelsx'), { now: LIST_DATE }), /signature is invalid/);
    assert.throws(() => parseAgeTrustedList(LIST, { now: LIST_DATE, signers: ['00'.repeat(32)] }), /unknown certificate/);
    assert.throws(() => parseAgeTrustedList(LIST.replace(/<ds:Signature[\s\S]*<\/ds:Signature>/, ''), { now: LIST_DATE }), /not signed/);
    assert.throws(() => parseAgeTrustedList(LIST, { now: new Date('2028-01-01') }), /not valid now/);
});

test('age trust config: list on by default, off, custom https url and signer pins', () => {
    assert.match(parseAgeTrustConfig({}).listUrl, /^https:\/\/trust\.tech\.ec\.europa\.eu\//);
    assert.equal(parseAgeTrustConfig({ listUrl: 'off' }).listUrl, null);
    assert.equal(parseAgeTrustConfig({ listUrl: 'http://insecure' }).listUrl, parseAgeTrustConfig({}).listUrl);
    assert.deepEqual(parseAgeTrustConfig({ listSigners: `${'AB'.repeat(32)}, nope` }).listSigners, ['ab'.repeat(32)]);
});

test('trust store: imports the list, caches it, keeps the last valid one when an update fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'og-age-trust-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const config = parseAgeTrustConfig({});
    let answer = LIST;
    const store = createAgeTrustStore({ config, dataDirectory: directory, log: silent, now: () => LIST_DATE, fetchList: async () => answer });
    assert.equal(store.certificates().length, 0);
    assert.deepEqual(await store.refresh(), { ok: true, issuers: 1 });
    assert.equal(store.certificates().length, 1);
    assert.ok(existsSync(join(directory, 'age-trusted-list.xml')));
    answer = LIST.replace('Digitaliseringsstyrelsen', 'Evil');
    assert.equal((await store.refresh()).ok, false);
    assert.equal(store.certificates().length, 1, 'a rejected update keeps the last valid list');
    const restarted = createAgeTrustStore({ config, dataDirectory: directory, log: silent, now: () => LIST_DATE, fetchList: async () => { throw new Error('offline'); } });
    assert.equal(restarted.certificates().length, 1, 'cached list survives a restart');
    assert.equal(restarted.status().imported[0].provider, 'Digitaliseringsstyrelsen');
});

// ----- Test-Aussteller und Test-Wallet -----
async function testIssuer() {
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: '01', name: 'C=DK, CN=Test Proof of Age Issuer', keys,
        notBefore: new Date(Date.now() - 86400000), notAfter: new Date(Date.now() + 86400000 * 30),
        signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' }
    });
    return { privateJwk: await webcrypto.subtle.exportKey('jwk', keys.privateKey), der: new Uint8Array(certificate.rawData) };
}

async function walletPresentation({ issuer, origin, nonce, docType = 'eu.europa.ec.av.1', over18 = true, transcriptIndex = 0 }) {
    const context = createMdocContext();
    const device = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const nameSpace = docType === 'org.iso.18013.5.1.mDL' ? 'org.iso.18013.5.1' : docType;
    const issued = await new Document(docType, context)
        .addIssuerNameSpace(nameSpace, { age_over_18: over18 })
        .useDigestAlgorithm('SHA-256')
        .addValidityInfo({ signed: new Date(), validFrom: new Date(Date.now() - 60000), validUntil: new Date(Date.now() + 86400000) })
        .addDeviceKeyInfo({ deviceKey: device.publicKey.export({ format: 'jwk' }) })
        .sign({ issuerPrivateKey: issuer.privateJwk, issuerCertificate: issuer.der, alg: 'ES256' }, context);
    const presentationDefinition = {
        id: 'age',
        input_descriptors: [{
            id: docType,
            format: { mso_mdoc: { alg: ['ES256'] } },
            constraints: { limit_disclosure: 'required', fields: [{ path: [`$['${nameSpace}']['age_over_18']`], intent_to_retain: false }] }
        }]
    };
    const response = await DeviceResponse.from(new MDoc([issued]))
        .usingPresentationDefinition(presentationDefinition)
        .usingSessionTranscriptBytes(eudiSessionTranscripts({ origin, nonce })[transcriptIndex])
        .authenticateWithSignature(device.privateKey.export({ format: 'jwk' }), 'ES256')
        .sign(context);
    return { protocol: 'openid4vp-v1-unsigned', data: { vp_token: { av: [Buffer.from(response.encode()).toString('base64url')] } } };
}

async function eudiApp({ trusted = [], doctypes } = {}) {
    const certs = mkdtempSync(join(tmpdir(), 'og-age-certs-'));
    trusted.forEach((der, index) => writeFileSync(join(certs, `issuer-${index}.pem`), derToPem(der)));
    const store = createStore(':memory:');
    const app = await buildApp({
        store, buildVersion: 'x', buildTimestamp: 'y', appUrl: 'https://og.example.org',
        safety: { ageCheck: 'provider', ageProvider: 'eudi' },
        ageTrust: { certs, listUrl: 'off' },
        ...(doctypes ? { ageEudiDoctypes: doctypes } : {})
    });
    cleanup.push(async () => { await app.close(); store.close(); rmSync(certs, { recursive: true, force: true }); });
    return app;
}

async function register(app, peerId) {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const registrationId = `registration-${peerId}`;
    const authToken = randomBytes(32).toString('base64url');
    const signature = sign('sha256', Buffer.from(JSON.stringify({ peerId, registrationId, authToken })), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
    await app.inject({
        method: 'POST', url: '/api/register',
        payload: { peerId, registrationId, geohash: 'u10j2k', authToken, registrationProof: { publicKey: keys.publicKey.export({ format: 'jwk' }), signature: signature.toString('base64') } }
    });
    return { authorization: `Bearer ${authToken}` };
}

async function startCheck(app, peerId, headers) {
    const response = await app.inject({ method: 'POST', url: '/api/safety/age/start', headers, payload: { peerId } });
    assert.equal(response.statusCode, 200);
    return response.json();
}

const finishCheck = (app, peerId, headers, payload) => app.inject({ method: 'POST', url: '/api/safety/age/finish', headers, payload: { peerId, payload } });

test('EUDI request asks only for age_over_18 of the configured credentials', () => {
    const request = eudiRequest({ nonce: 'n', doctypes: parseEudiDoctypes('av, mdl, unknown') });
    assert.equal(request.response_mode, 'dc_api');
    assert.deepEqual(request.dcql_query.credentials.map(credential => credential.meta.doctype_value), ['eu.europa.ec.av.1', 'org.iso.18013.5.1.mDL']);
    assert.deepEqual(request.dcql_query.credentials.map(credential => credential.claims), [[{ path: ['eu.europa.ec.av.1', 'age_over_18'] }], [{ path: ['org.iso.18013.5.1', 'age_over_18'] }]]);
    assert.deepEqual(parseEudiDoctypes(''), ['av', 'pid', 'mdl']);
});

test('EUDI age check: a trusted wallet presentation unlocks the grid', async () => {
    const issuer = await testIssuer();
    const app = await eudiApp({ trusted: [issuer.der] });
    const headers = await register(app, 'alice');
    const started = await startCheck(app, 'alice', headers);
    assert.equal(started.protocol, 'openid4vp-v1-unsigned');
    const payload = await walletPresentation({ issuer, origin: 'https://og.example.org', nonce: started.request.nonce });
    const finished = await finishCheck(app, 'alice', headers, payload);
    assert.equal(finished.statusCode, 200, finished.body);
    const grid = await app.inject({ method: 'GET', url: '/api/grid?geohash=u10j2k&peerId=alice', headers });
    assert.equal(grid.statusCode, 200);
    // Dieselbe Antwort ein zweites Mal: die Nonce ist verbraucht.
    assert.equal((await finishCheck(app, 'alice', headers, payload)).statusCode, 403);
});

test('EUDI age check: older wallets (draft transcript) and the ISO mDL are accepted', async () => {
    const issuer = await testIssuer();
    const app = await eudiApp({ trusted: [issuer.der] });
    const headers = await register(app, 'bob');
    const started = await startCheck(app, 'bob', headers);
    const payload = await walletPresentation({ issuer, origin: 'https://og.example.org', nonce: started.request.nonce, docType: 'org.iso.18013.5.1.mDL', transcriptIndex: 1 });
    assert.equal((await finishCheck(app, 'bob', headers, payload)).statusCode, 200);
});

test('EUDI age check rejects untrusted issuers, other origins, wrong nonces and unwanted credentials', async () => {
    const issuer = await testIssuer();
    const stranger = await testIssuer();
    const app = await eudiApp({ trusted: [issuer.der], doctypes: 'av' });
    const headers = await register(app, 'carol');
    const attempt = async options => {
        const started = await startCheck(app, 'carol', headers);
        const payload = await walletPresentation({ issuer, origin: 'https://og.example.org', nonce: started.request.nonce, ...options(started) });
        return finishCheck(app, 'carol', headers, payload);
    };
    assert.equal((await attempt(() => ({ issuer: stranger }))).statusCode, 403, 'untrusted issuer');
    assert.equal((await attempt(() => ({ origin: 'https://evil.example' }))).statusCode, 403, 'presentation made for another site');
    assert.equal((await attempt(() => ({ nonce: 'old-nonce' }))).statusCode, 403, 'wrong nonce');
    assert.equal((await attempt(() => ({ docType: 'org.iso.18013.5.1.mDL' }))).statusCode, 403, 'mDL not accepted when only av is configured');
    assert.equal((await finishCheck(app, 'carol', headers, { data: { vp_token: 'not-base64-mdoc' } })).statusCode, 403, 'no open request');
    const grid = await app.inject({ method: 'GET', url: '/api/grid?geohash=u10j2k&peerId=carol', headers });
    assert.equal(grid.statusCode, 403);
});

test('EUDI: a trusted proof "under 18" verifies into the minor group', async () => {
    const issuer = await testIssuer();
    const app = await eudiApp({ trusted: [issuer.der] });
    const headers = await register(app, 'teen');
    const started = await startCheck(app, 'teen', headers);
    const finished = await finishCheck(app, 'teen', headers, await walletPresentation({ issuer, origin: 'https://og.example.org', nonce: started.request.nonce, over18: false }));
    assert.equal(finished.statusCode, 200);
    assert.equal(finished.json().group, 'minor');
    const status = (await app.inject({ method: 'GET', url: '/api/safety/status?peerId=teen', headers })).json();
    assert.equal(status.age.group, 'minor');
});

test('EUDI age check without any trusted issuer refuses with a reason', async () => {
    const issuer = await testIssuer();
    const app = await eudiApp();
    const headers = await register(app, 'dave');
    const started = await startCheck(app, 'dave', headers);
    const response = await finishCheck(app, 'dave', headers, await walletPresentation({ issuer, origin: 'https://og.example.org', nonce: started.request.nonce }));
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().reason, 'No trusted issuers configured');
});

// ----- App: Wallet-Anfrage ueber die Digital Credentials API -----
async function loadClientSafety({ supported = true, get } = {}) {
    const vm = await import('node:vm');
    const toasts = [];
    const posted = [];
    const context = {
        state: {}, console,
        t: key => key,
        showToast: (message, type) => toasts.push([message, type]),
        logDebug: () => {},
        document: { getElementById: () => null, addEventListener: () => {} },
        navigator: { credentials: { get } },
        window: {}
    };
    if (supported) context.window.DigitalCredential = function DigitalCredential() {};
    vm.runInNewContext(readFileSync(new URL('../client/app/safety.js', import.meta.url), 'utf8'), context);
    context.safetyRequest = async (path, body) => { posted.push([path, body]); return {}; };
    context.afterVerificationStep = async message => toasts.push([message, 'done']);
    return { context, toasts, posted };
}

test('app asks the wallet via the Digital Credentials API and sends only its answer', async () => {
    let request = null;
    const { context, toasts, posted } = await loadClientSafety({
        get: async options => { request = options; return { protocol: 'openid4vp-v1-unsigned', data: { vp_token: { av: ['abc'] } } }; }
    });
    await context.presentEudiCredential({ protocol: 'openid4vp-v1-unsigned', request: { nonce: 'n1' } });
    assert.equal(request.mediation, 'required');
    assert.deepEqual(JSON.parse(JSON.stringify(request.digital.requests)), [{ protocol: 'openid4vp-v1-unsigned', data: { nonce: 'n1' } }]);
    assert.deepEqual(JSON.parse(JSON.stringify(posted)), [['age/finish', { payload: { protocol: 'openid4vp-v1-unsigned', data: { vp_token: { av: ['abc'] } } } }]]);
    assert.deepEqual(toasts, [['safety.ageConfirmed', 'done']]);
});

test('app explains unsupported browsers and cancelled wallet dialogs', async () => {
    const unsupported = await loadClientSafety({ supported: false, get: async () => assert.fail('must not ask') });
    await unsupported.context.presentEudiCredential({ protocol: 'p', request: {} });
    assert.deepEqual(unsupported.toasts, [['safety.walletUnsupported', 'warning']]);
    const cancelled = await loadClientSafety({ get: async () => { const error = new Error('no'); error.name = 'NotAllowedError'; throw error; } });
    await cancelled.context.presentEudiCredential({ protocol: 'p', request: {} });
    assert.deepEqual(cancelled.toasts, [['safety.walletCancelled', 'warning']]);
    assert.equal(cancelled.posted.length, 0);
});

test('wallet test page verifies like the real check but stores and unlocks nothing', async () => {
    const issuer = await testIssuer();
    const store = createStore(':memory:');
    const app = await buildApp({
        store, buildVersion: 'x', buildTimestamp: 'y', appUrl: 'https://og.example.org',
        safety: { ageCheck: 'confirm' },
        ageTestTrust: () => [{ certificates: () => [issuer.der], refresh: async () => ({ ok: true }), status: () => ({ imported: [{ provider: 'Test' }] }) }]
    });
    cleanup.push(async () => { await app.close(); store.close(); });
    const headers = await register(app, 'erin');
    const start = await app.inject({ method: 'POST', url: '/api/safety/age-test/start', headers, payload: { peerId: 'erin' } });
    assert.equal(start.statusCode, 200);
    assert.equal(start.json().issuers, 1);
    const payload = await walletPresentation({ issuer, origin: 'https://og.example.org', nonce: start.json().request.nonce });
    const finish = await app.inject({ method: 'POST', url: '/api/safety/age-test/finish', headers, payload: { peerId: 'erin', payload } });
    assert.equal(finish.statusCode, 200);
    const result = finish.json();
    assert.equal(result.over18, true);
    assert.equal(result.details.transcript, 'openid4vp-1.0');
    assert.deepEqual(result.details.documents, [{ docType: 'eu.europa.ec.av.1', issuer: { name: 'Test Proof of Age Issuer', country: 'DK' }, ageOver18: true }]);
    // Nichts freigeschaltet: der Nachweis fehlt weiter.
    const grid = await app.inject({ method: 'GET', url: '/api/grid?geohash=u10j2k&peerId=erin', headers });
    assert.equal(grid.statusCode, 403);
    // Ohne Anmeldung keine Tests.
    assert.equal((await app.inject({ method: 'POST', url: '/api/safety/age-test/start', payload: { peerId: 'erin' } })).statusCode, 401);
});

test('wallet test page can be switched off', async () => {
    const store = createStore(':memory:');
    const app = await buildApp({ store, buildVersion: 'x', buildTimestamp: 'y', ageEudiTest: 'false' });
    cleanup.push(async () => { await app.close(); store.close(); });
    assert.equal((await app.inject({ method: 'POST', url: '/api/safety/age-test/start', payload: { peerId: 'x' } })).statusCode, 404);
});
