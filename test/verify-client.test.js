import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// client/app/verify.js: welcher eigene Haken gilt (passt zu Bild und ID, nicht abgelaufen).
function load(profile) {
    const context = { state: { myProfile: profile, appConfig: { verify: { enabled: true } } }, document: { getElementById: () => null } };
    vm.runInNewContext(readFileSync(new URL('../client/app/verify.js', import.meta.url), 'utf8'), context);
    return context;
}

test('own check mark counts only for the checked picture, the own ID and before expiry', () => {
    const badge = { subject: 'me', avatarSha256: 'hash-1', issuedAt: 1, expiresAt: 1000 };
    const profile = { id: 'me', avatar: 'data:x', avatarFull: { id: 'a', sha256: 'hash-1' }, verification: { badge, sig: 'sig' } };
    const context = load(profile);
    assert.deepEqual(JSON.parse(JSON.stringify(context.ownVerification(500))), { badge, sig: 'sig' });
    assert.equal(context.ownVerification(1000), null, 'expired');
    profile.avatarFull = { id: 'b', sha256: 'hash-2' };
    assert.equal(context.ownVerification(500), null, 'new picture');
    profile.avatarFull = { id: 'a', sha256: 'hash-1' };
    profile.id = 'other-device';
    assert.equal(context.ownVerification(500), null, 'other ID');
    profile.id = 'me';
    profile.avatar = null;
    assert.equal(context.ownVerification(500), null, 'no picture');
});

// Empfaenger: Haken mit dem Router-Schluessel pruefen (Signatur wie server/verify.js signBadge).
test('receiver accepts a router-signed check mark only for this contact, this picture and before expiry', async () => {
    const { generateKeyPairSync, webcrypto } = await import('node:crypto');
    const { signBadge } = await import('../server/verify.js');
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { x, y } = publicKey.export({ format: 'jwk' });
    const context = vm.createContext({
        TextEncoder, Uint8Array, Map, Date, Promise,
        window: { atob, btoa, crypto: webcrypto },
        state: { myProfile: {}, cachedProfiles: {}, appConfig: { verify: { enabled: true, key: { x, y } } } },
        document: { getElementById: () => null }
    });
    vm.runInContext(readFileSync(new URL('../client/crypto.client.js', import.meta.url), 'utf8'), context);
    vm.runInContext(readFileSync(new URL('../client/app/verify.js', import.meta.url), 'utf8'), context);
    const badge = { subject: 'alice', avatarSha256: 'pic-1', issuedAt: 1, expiresAt: Date.now() + 60000 };
    const profile = (overrides = {}) => ({ avatar: 'data:x', avatarFull: { id: 'a', sha256: 'pic-1' }, verified: { badge, sig: signBadge(badge, privateKey) }, ...overrides });
    assert.equal(await context.checkPeerVerification('alice', profile()), true);
    assert.equal(await context.checkPeerVerification('mallory', profile()), false, 'copied into another profile');
    assert.equal(await context.checkPeerVerification('alice', profile({ avatarFull: { id: 'b', sha256: 'pic-2' } })), false, 'new picture');
    assert.equal(await context.checkPeerVerification('alice', profile(), Date.now() + 120000), false, 'expired');
    // Gleiche Signatur, veraenderter Haken (Bild passend umgeschrieben): kein Treffer aus dem Cache.
    const tampered = { ...badge, avatarSha256: 'pic-x' };
    assert.equal(await context.checkPeerVerification('alice', profile({ avatarFull: { id: 'x', sha256: 'pic-x' }, verified: { badge: tampered, sig: signBadge(badge, privateKey) } })), false, 'tampered badge with old signature');
    const forged = profile({ verified: { badge: { ...badge, expiresAt: badge.expiresAt + 1 }, sig: signBadge(badge, privateKey) } });
    assert.equal(await context.checkPeerVerification('bob', { ...forged, verified: { ...forged.verified, badge: { ...forged.verified.badge, subject: 'bob' } } }), false, 'changed badge breaks the signature');
    // Anderer Router-Schluessel: nicht anerkannt.
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const foreign = { ...badge, subject: 'carol' };
    assert.equal(await context.checkPeerVerification('carol', profile({ verified: { badge: foreign, sig: signBadge(foreign, other.privateKey) } })), false);
});

// Browser-Worker (verify-worker.js) und Router (server/face-verify.js) dekodieren YuNet gleich.
test('YuNet decoding in the browser worker matches the router', async () => {
    const { decodeYuNet } = await import('../server/face-verify.js');
    const context = vm.createContext({ Math, Object, Float32Array });
    vm.runInContext(readFileSync(new URL('../client/app/verify-worker.js', import.meta.url), 'utf8'), context);
    const outputs = {};
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const stride of [8, 16, 32]) {
        const cells = (640 / stride) ** 2;
        outputs[`cls_${stride}`] = Float32Array.from({ length: cells }, () => random() * 0.9);
        outputs[`obj_${stride}`] = Float32Array.from({ length: cells }, () => random());
        outputs[`bbox_${stride}`] = Float32Array.from({ length: cells * 4 }, () => random() * 2 - 0.5);
        outputs[`kps_${stride}`] = Float32Array.from({ length: cells * 10 }, () => random() * 2 - 0.5);
    }
    const server = decodeYuNet(outputs, { scale: 0.75 });
    const browser = context.decodeYuNet(outputs, { scale: 0.75 });
    assert.ok(server.length > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(browser)), JSON.parse(JSON.stringify(server)));
});

// Live-Anleitung: Hinweise je Lage, strenger als der Router.
test('live guidance: one face, close enough, pose reached (stricter than the router)', () => {
    const context = load({ id: 'me' });
    context.t = key => key;
    const face = (nose, size = 200) => ({ box: [100, 100, size, size], landmarks: [[150, 150], [250, 150], [200 + nose, 200], [160, 250], [240, 250]] });
    assert.equal(context.verifyGuidance('straight', [], 640, 480), 'verify.hintNoFace');
    assert.equal(context.verifyGuidance('straight', [face(0), face(0)], 640, 480), 'verify.hintManyFaces');
    assert.equal(context.verifyGuidance('straight', [face(0, 40)], 640, 480), 'verify.hintCloser');
    assert.equal(context.verifyGuidance('straight', [face(0)], 640, 480), null);
    assert.equal(context.verifyGuidance('straight', [face(10)], 640, 480), 'verify.hintStraight', '0.1 is fine for the router, not for the client');
    assert.equal(context.verifyGuidance('left', [face(25)], 640, 480), 'verify.hintMoreLeft', 'router would take 0.25, client wants 0.3');
    assert.equal(context.verifyGuidance('left', [face(35)], 640, 480), null);
    assert.equal(context.verifyGuidance('right', [face(-35)], 640, 480), null);
});
