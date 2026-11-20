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
