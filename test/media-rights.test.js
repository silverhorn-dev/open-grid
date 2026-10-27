import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { I18N_STUBS } from './i18n-stubs.js';

function loadRights({ stored = null, defaults = {}, friends = [] } = {}) {
    const records = new Map(stored ? [['media-download-settings', stored]] : []);
    const context = {
        state: { myProfile: { id: 'me' } },
        document: { getElementById: () => null },
        databaseRequest: async (_store, _mode, run) => run({ get: id => records.get(id) }),
        putDatabaseRecord: async (_store, value) => records.set(value.id, value),
        clientDefault: (key, fallback) => (key in defaults ? defaults[key] : fallback),
        isFriend: peerId => friends.includes(peerId),
        showToast: () => {},
        logDebug: () => {}
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/media-rights.js', import.meta.url), 'utf8'), Object.assign(context, I18N_STUBS));
    return { context, records };
}

test('media download setting: friends by default, operator default, own choice', async () => {
    const plain = loadRights();
    await plain.context.loadMediaDownloadSetting();
    assert.equal(plain.context.state.mediaDownload, 'friends');

    const operator = loadRights({ defaults: { mediaDownload: 'all' } });
    await operator.context.loadMediaDownloadSetting();
    assert.equal(operator.context.state.mediaDownload, 'all');

    const own = loadRights({ stored: { id: 'media-download-settings', value: 'friends' }, defaults: { mediaDownload: 'all' } });
    await own.context.loadMediaDownloadSetting();
    assert.equal(own.context.state.mediaDownload, 'friends', 'own choice wins');
    await own.context.updateMediaDownloadSetting('everyone');
    assert.equal(own.context.state.mediaDownload, 'friends', 'unknown values are ignored');
    await own.context.updateMediaDownloadSetting('all');
    assert.equal(own.records.get('media-download-settings').value, 'all');
});

test('who may save: own always, others as the sender allows, never albums or snaps', () => {
    const { context } = loadRights({ friends: ['friend'] });
    const image = (senderId, extra = {}) => ({ id: 'm', senderId, snapData: 'data:image/jpeg;base64,AA', ...extra });
    assert.equal(context.canDownloadMedia(image('me')), true);
    assert.equal(context.canDownloadMedia(image('stranger')), false, 'no flag = friends only');
    assert.equal(context.canDownloadMedia(image('stranger', { downloadable: 'friends' })), false);
    assert.equal(context.canDownloadMedia(image('friend', { downloadable: 'friends' })), true);
    assert.equal(context.canDownloadMedia(image('stranger', { downloadable: 'all' })), true);
    assert.equal(context.canDownloadMedia(image('friend', { snapMode: 'replay', downloadable: 'all' })), false, 'one-time snaps never');
    assert.equal(context.canDownloadMedia(image('friend', { album: { id: 'a' } })), false);
    assert.equal(context.canDownloadMedia(image('friend', { secureSnap: { snapId: 's' } })), false);
    assert.equal(context.canDownloadMedia(null), false);
});
