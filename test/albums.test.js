import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

function loadAlbums() {
    const sent = [];
    const records = new Map();
    const context = {
        state: {
            myProfile: { id: 'me', gallery: [{ id: 'img_public', version: 1 }] },
            albums: {
                alb_1: {
                    id: 'alb_1',
                    ownerId: 'me',
                    name: 'Urlaub',
                    items: [{ id: 'albimg_a', version: 1 }],
                    acl: ['peer-allowed']
                }
            },
            albumViewer: null,
            pendingAlbumRequests: {},
            pendingImageRequests: {}
        },
        sendSecurePayload: async (peerId, payload) => sent.push({ peerId, payload }),
        putDatabaseRecord: async (store, value) => records.set(`${store}:${value.id}`, value),
        deleteDatabaseRecord: async (store, id) => records.delete(`${store}:${id}`),
        getAllDatabaseRecords: async () => [],
        renderMediaModalMessage: () => {},
        renderAlbumManager: () => {},
        document: { getElementById: () => null },
        Date
    };
    vm.runInNewContext(readFileSync(new URL('../client/app/albums.js', import.meta.url), 'utf8'), context);
    return { context, sent, records };
}

test('serves album images only to peers on the access list', () => {
    const { context } = loadAlbums();
    assert.equal(context.canPeerAccessImage('peer-allowed', 'albimg_a'), true);
    assert.equal(context.canPeerAccessImage('peer-other', 'albimg_a'), false);
    assert.equal(context.canPeerAccessImage('peer-other', 'img_public'), true);
    assert.equal(context.canPeerAccessImage('peer-allowed', 'unknown'), false);
});

test('answers album requests according to the access list', async () => {
    const { context, sent } = loadAlbums();
    await context.handleAlbumRequest('peer-allowed', 'alb_1');
    await context.handleAlbumRequest('peer-other', 'alb_1');
    await context.handleAlbumRequest('peer-allowed', 'alb_missing');
    assert.equal(sent[0].payload.type, 'ALBUM_RESPONSE');
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0].payload.album)), {
        id: 'alb_1',
        name: 'Urlaub',
        items: [{ id: 'albimg_a', version: 1 }]
    });
    assert.equal(sent[1].payload.type, 'ALBUM_DENIED');
    assert.equal(sent[2].payload.type, 'ALBUM_DENIED');
});

test('revoking access blocks further image requests and notifies the peer', async () => {
    const { context, sent } = loadAlbums();
    await context.revokeAlbumAccess('alb_1', 'peer-allowed');
    assert.equal(context.canPeerAccessImage('peer-allowed', 'albimg_a'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { peerId: 'peer-allowed', payload: { type: 'ALBUM_REVOKED', albumId: 'alb_1' } });
});

test('accepts only requested album responses and drops revoked albums', async () => {
    const { context, records } = loadAlbums();
    await context.handleAlbumResponse('peer-owner', { album: { id: 'alb_x', name: 'Fremd', items: [] } });
    assert.equal(context.state.albums.alb_x, undefined);

    context.state.pendingAlbumRequests['peer-owner:alb_x'] = true;
    await context.handleAlbumResponse('peer-owner', {
        album: { id: 'alb_x', name: 'Fremd', items: [{ id: 'albimg_x', version: 2 }, { id: 5 }] }
    });
    assert.equal(context.state.albums.alb_x.ownerId, 'peer-owner');
    assert.equal(context.state.albums.alb_x.items.length, 1);
    assert.equal(context.findReceivedAlbumItem('peer-owner', 'albimg_x').version, 2);
    assert.equal(context.findReceivedAlbumItem('peer-other', 'albimg_x'), undefined);

    // Ein anderer Peer kann das Album nicht entfernen, nur der Besitzer.
    await context.forgetReceivedAlbum('peer-other', 'alb_x');
    assert.ok(context.state.albums.alb_x);
    await context.forgetReceivedAlbum('peer-owner', 'alb_x');
    assert.equal(context.state.albums.alb_x, undefined);
    assert.equal(records.has('albums:alb_x'), false);
});
