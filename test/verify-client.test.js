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
