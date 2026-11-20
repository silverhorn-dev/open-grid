import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const context = {};
vm.runInNewContext(readFileSync(new URL('../client/app/payload-validation.js', import.meta.url), 'utf8'), context);
const valid = payload => context.isValidSecurePayload(payload);

const message = { id: 'm1', senderId: 'peer', text: 'hi', timestamp: '10:00', createdAt: 1 };
const put = { operationId: 'put:m1', type: 'MESSAGE_PUT', messageId: 'm1', actorId: 'peer', createdAt: 1, message };

test('accepts the regular protocol messages', () => {
    assert.equal(valid({ type: 'CHAT_OPERATION', operation: put }), true);
    assert.equal(valid({ type: 'CHAT_FOCUS', open: true }), true);
    assert.equal(valid({ type: 'CHAT_SYNC_HELLO', recentOperationIds: ['put:m1'], hasMore: false }), true);
    assert.equal(valid({ type: 'CHAT_SYNC_OPERATIONS', operations: [put] }), true);
    assert.equal(valid({ type: 'PROFILE_REQUEST' }), true);
    assert.equal(valid({ type: 'PROFILE_RESPONSE', signedEnvelope: { payload: { fields: { displayName: 'A', age: 30 }, gallery: [{ id: 'img' }] }, signature: 'x' } }), true);
    assert.equal(valid({ type: 'IMAGE_RESPONSE', imageId: 'img', version: 1, data: 'data:image/jpeg;base64,AA' }), true);
    assert.equal(valid({ type: 'SNAP_VIEW_DENIED', snapId: null }), true);
});

test('rejects unknown types and malformed or oversized payloads', () => {
    assert.equal(valid(null), false);
    assert.equal(valid({ type: 'EVAL_THIS' }), false);
    assert.equal(valid({ type: 'CHAT_FOCUS', open: 'yes' }), false);
    assert.equal(valid({ type: 'CHAT_OPERATION', operation: { ...put, type: 'DROP_TABLE' } }), false);
    assert.equal(valid({ type: 'CHAT_OPERATION', operation: { ...put, message: { ...message, text: 'x'.repeat(10001) } } }), false);
    assert.equal(valid({ type: 'CHAT_SYNC_HELLO', recentOperationIds: Array(21).fill('a') }), false);
    assert.equal(valid({ type: 'CHAT_SYNC_OPERATIONS', operations: [{ ...put, operationId: 42 }] }), false);
    const manyFields = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`f${index}`, 'x']));
    assert.equal(valid({ type: 'PROFILE_RESPONSE', signedEnvelope: { payload: { fields: manyFields } } }), false);
    assert.equal(valid({ type: 'PROFILE_RESPONSE', signedEnvelope: { payload: { fields: { bio: { nested: true } } } } }), false);
    assert.equal(valid({ type: 'ALBUM_RESPONSE', album: { id: 'a', items: Array(501).fill({ id: 'x' }) } }), false);
    assert.equal(valid({ type: 'IMAGE_RESPONSE', imageId: 'img', version: -1, data: '' }), false);
});

test('download permission travels with the message and only known values pass', () => {
    const withFlag = downloadable => ({ type: 'CHAT_OPERATION', operation: { ...put, message: { ...message, downloadable } } });
    assert.equal(valid(withFlag('friends')), true);
    assert.equal(valid(withFlag('all')), true);
    assert.equal(valid(withFlag('none')), true);
    assert.equal(valid(withFlag('everyone')), false);
});

test('album revoke operations need an album id', () => {
    const revoke = albumId => ({ type: 'CHAT_OPERATION', operation: { operationId: 'albumrevoke:1', type: 'ALBUM_REVOKE', actorId: 'peer', createdAt: 1, albumId } });
    assert.equal(valid(revoke('alb_1')), true);
    assert.equal(valid(revoke('')), false);
    assert.equal(valid({ type: 'ALBUM_VIEW_CLOSED', albumId: 'alb_1' }), true);
    assert.equal(valid({ type: 'ALBUM_VIEW_CLOSED' }), false);
});

test('operations from a peer may only carry that peer as actor', () => {
    assert.equal(context.isOperationFromPeer('peer', put), true);
    assert.equal(context.isOperationFromPeer('peer', { ...put, actorId: undefined }), true, 'types without actor rely on their own checks');
    assert.equal(context.isOperationFromPeer('peer', { ...put, actorId: 'me', message: { ...message, senderId: 'me' } }), false, 'no messages "from me" injected by a contact');
    assert.equal(context.isOperationFromPeer('peer', { ...put, actorId: 'someone-else' }), false);
    assert.equal(context.isOperationFromPeer('peer', null), false);
});

test('profile check mark (verify.js): shape only, the receiver checks signature and picture', () => {
    const badge = { subject: 'peer', avatarSha256: 'abc', issuedAt: 1, expiresAt: 2 };
    const profile = verified => ({ type: 'PROFILE_RESPONSE', signedEnvelope: { payload: { fields: {}, verified }, signature: 'x' } });
    assert.equal(valid(profile({ badge, sig: 'c2ln' })), true);
    assert.equal(valid(profile(undefined)), true);
    assert.equal(valid(profile({ badge })), false, 'needs a signature');
    assert.equal(valid(profile({ badge: { ...badge, extra: 1 }, sig: 'c2ln' })), false, 'no extra keys in the signed badge');
    assert.equal(valid(profile({ badge: { ...badge, expiresAt: 'soon' }, sig: 'c2ln' })), false);
    assert.equal(valid(profile({ badge, sig: 'x'.repeat(201) })), false);
});

test('sticker (stickers.js): small PNG/WebP with checksum and size, optional 18+ flag, nothing else', () => {
    const sticker = { data: 'data:image/webp;base64,UklGRg==', sha256: 'abc', w: 128, h: 96 };
    const put = value => ({ type: 'CHAT_OPERATION', operation: { ...put0, message: { ...message, sticker: value } } });
    const put0 = { operationId: 'put:m1', type: 'MESSAGE_PUT', messageId: 'm1', actorId: 'peer', createdAt: 1 };
    assert.equal(valid(put(sticker)), true);
    assert.equal(valid(put({ ...sticker, adult: true })), true);
    assert.equal(valid(put({ ...sticker, data: 'data:image/jpeg;base64,AA' })), false, 'no JPEG (no transparency)');
    assert.equal(valid(put({ ...sticker, data: `data:image/png;base64,${'A'.repeat(60001)}` })), false, 'too large');
    assert.equal(valid(put({ ...sticker, w: 5000 })), false);
    assert.equal(valid(put({ ...sticker, adult: 'yes' })), false);
    assert.equal(valid(put({ ...sticker, url: 'https://x' })), false, 'no extra keys');
});
