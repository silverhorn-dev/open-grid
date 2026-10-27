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
