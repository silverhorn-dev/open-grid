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
                    acl: ['peer-allowed'],
                    secret: Buffer.alloc(32, 7).toString('base64'),
                    keyVersion: 1
                }
            },
            albumViewer: null,
            albumKeys: {},
            pendingAlbumRequests: {},
            pendingAlbumKeyRequests: {},
            pendingImageRequests: {}
        },
        window: { crypto: globalThis.crypto },
        bytesToBase64: bytes => Buffer.from(bytes).toString('base64'),
        base64ToBytes: value => new Uint8Array(Buffer.from(value, 'base64')),
        TextEncoder,
        TextDecoder,
        setTimeout,
        clearTimeout,
        isSafeInlineImage: value => typeof value === 'string' && value.startsWith('data:image/'),
        loadMedia: async id => (id === 'albimg_a' ? { data: 'data:image/jpeg;base64,AAAA', version: 1 } : null),
        cacheMediaPayload: async (id, payload) => records.set(`media:${id}`, payload),
        fetchServerTime: async () => ({ now: 1000, epoch: 3, epochEndsAt: 61000 }),
        isGalleryVisibleTo: () => true,
        logDebug: () => {},
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
        keyVersion: 1,
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

test('album images travel encrypted and decrypt only with the viewer key of the current epoch', async () => {
    const owner = loadAlbums();
    await owner.context.serveAlbumImage('peer-allowed', 'albimg_a');
    await owner.context.serveAlbumImage('peer-other', 'albimg_a');
    assert.equal(owner.sent.length, 1, 'peers outside the access list get nothing');
    const imageResponse = owner.sent[0].payload;
    assert.equal(imageResponse.data, undefined);
    assert.equal(typeof imageResponse.encrypted.ciphertext, 'string');

    await owner.context.handleAlbumKeyRequest('peer-allowed', { albumId: 'alb_1', epoch: 3 });
    const keyResponse = owner.sent[1].payload;
    assert.equal(keyResponse.type, 'ALBUM_KEY_RESPONSE');
    assert.equal(keyResponse.epochEndsAt, 61000);

    // Betrachter-Seite
    const viewer = loadAlbums();
    viewer.context.state.albums = {
        alb_1: { id: 'alb_1', ownerId: 'peer-owner', name: 'Urlaub', keyVersion: 1, items: [{ id: 'albimg_a', version: 1 }] }
    };
    viewer.context.state.pendingAlbumKeyRequests['peer-owner:alb_1'] = true;
    await viewer.context.handleAlbumKeyResponse('peer-owner', keyResponse);
    assert.equal(
        await viewer.context.decryptAlbumImage('alb_1', 'albimg_a', imageResponse.encrypted),
        'data:image/jpeg;base64,AAAA'
    );

    // Abgelaufene Epoche: Schluessel weg, Ciphertext nicht mehr lesbar.
    viewer.context.expireAlbumKeys('alb_1', false);
    assert.equal(await viewer.context.decryptAlbumImage('alb_1', 'albimg_a', imageResponse.encrypted), null);

    // Schluessel eines anderen Betrachters passt nicht.
    await owner.context.handleAlbumKeyRequest('peer-allowed', { albumId: 'alb_1' });
    owner.context.state.albums.alb_1.acl.push('peer-second');
    await owner.context.handleAlbumKeyRequest('peer-second', { albumId: 'alb_1' });
    viewer.context.state.pendingAlbumKeyRequests['peer-owner:alb_1'] = true;
    await viewer.context.handleAlbumKeyResponse('peer-owner', owner.sent.at(-1).payload);
    assert.equal(await viewer.context.decryptAlbumImage('alb_1', 'albimg_a', imageResponse.encrypted), null);
    viewer.context.expireAlbumKeys('alb_1', false);
});

test('revoking access bumps the album key version', async () => {
    const { context } = loadAlbums();
    await context.revokeAlbumAccess('alb_1', 'peer-allowed');
    assert.equal(context.state.albums.alb_1.keyVersion, 2);
    const keyBefore = await context.deriveAlbumImageKey({ ...context.state.albums.alb_1, keyVersion: 1 }, 'albimg_a', 'peer-x');
    const keyAfter = await context.deriveAlbumImageKey(context.state.albums.alb_1, 'albimg_a', 'peer-x');
    const raw = async key => Buffer.from(await globalThis.crypto.subtle.exportKey('raw', key)).toString('hex');
    assert.notEqual(await raw(keyBefore), await raw(keyAfter));
});
