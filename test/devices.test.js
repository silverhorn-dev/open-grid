import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

function load() {
    const context = { state: { myProfile: { id: 'phone' } }, Date, window: { crypto: globalThis.crypto } };
    vm.runInNewContext(readFileSync(new URL('../client/app/devices.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    return context;
}

const key = { x: 'xx', y: 'yy' };
const base = { identityId: 'phone', version: 1, devices: [{ nodeId: 'phone', key, canAdd: true, addedAt: 1 }], updatedBy: 'phone', updatedAt: 1 };

test('device lists: valid shape, root included, signer may add devices', () => {
    const context = load();
    assert.equal(context.isValidDeviceList(base), true);
    assert.equal(context.isValidDeviceList({ ...base, devices: [{ nodeId: 'pc', key, canAdd: true, addedAt: 1 }], updatedBy: 'pc' }), false, 'root must stay in the list');
    assert.equal(context.isValidDeviceList({ ...base, updatedBy: 'pc' }), false, 'signer must be a device that can add');
    assert.equal(context.isValidDeviceList({ ...base, devices: [...base.devices, base.devices[0]] }), false, 'no duplicates');
});

test('device lists are only taken from allowed devices and newer versions; a fresh device only from its inviter', () => {
    const context = load();
    const withPc = { ...base, version: 2, devices: [...base.devices, { nodeId: 'pc', key, canAdd: false, addedAt: 2 }] };
    assert.equal(context.judgeDeviceList(withPc, base, { senderId: 'phone', myNodeId: 'phone' }), 'accept');
    assert.equal(context.judgeDeviceList(withPc, withPc, { senderId: 'phone', myNodeId: 'phone' }), null, 'same version');
    assert.equal(context.judgeDeviceList({ ...withPc, version: 3, updatedBy: 'pc', devices: withPc.devices.map(device => ({ ...device, canAdd: true })) }, withPc, { senderId: 'pc', myNodeId: 'phone' }), null, 'pc cannot give itself rights');
    assert.equal(context.judgeDeviceList(withPc, null, { senderId: 'phone', myNodeId: 'pc', pairing: { identityId: 'phone', inviter: 'phone' } }), 'accept', 'freshly paired');
    assert.equal(context.judgeDeviceList(withPc, null, { senderId: 'phone', myNodeId: 'pc', pairing: null }), null, 'no pairing, no list');
    assert.equal(context.judgeDeviceList(base, null, { senderId: 'phone', myNodeId: 'pc', pairing: { identityId: 'phone', inviter: 'phone' } }), null, 'must contain me');
});

test('own nodes: this device and every device in my list', () => {
    const context = load();
    assert.equal(context.isOwnNode('phone'), true);
    assert.equal(context.isOwnNode('pc'), false);
    context.state.myDevices = { list: { ...base, devices: [...base.devices, { nodeId: 'pc', key, canAdd: false, addedAt: 2 }] } };
    assert.equal(context.isOwnNode('pc'), true);
    assert.equal(context.isOwnNode('bob'), false);
    assert.deepEqual([...context.myNodeIds()], ['phone', 'pc']);
    assert.equal(context.myIdentityId(), 'phone');
    context.state.myProfile = { id: 'pc' };
    assert.equal(context.canAddDevices(), false, 'only devices with the right add devices');
});
