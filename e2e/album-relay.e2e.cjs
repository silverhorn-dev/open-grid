// End-to-End: A teilt ein Album mit B und C. C oeffnet es, A geht offline, B bekommt Manifest und
// Bild ueber C (Schwarm) und kann es mit den Schluesseln von A ansehen.
// Laeuft gegen einen gestarteten Server (BASE_URL, Standard http://127.0.0.1:3000).
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function waitFor(page, predicate, arg, timeout = 30000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await page.evaluate(predicate, arg).catch(() => false)) return;
        await page.waitForTimeout(250);
    }
    throw new Error(`Timed out waiting for ${predicate}`);
}

async function main() {
    // Nur einmal pro Lauf noetig (der Runner startet jede Variante).
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    async function user(name) {
        const page = await (await browser.newContext()).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        return page;
    }
    const idOf = page => page.evaluate(() => state.myProfile.id);
    // Chat oeffnen und eine Nachricht schicken: baut den P2P-Kanal auf.
    async function connect(from, to) {
        const toId = await idOf(to);
        await from.evaluate(id => openChatWithPeer(id), toId);
        await from.fill('#chat-input', 'hi');
        await from.click('#send-chat-btn');
        await waitFor(from, id => state.dataChannels[id]?.readyState === 'open' && isSecureChannelOpen(id), toId);
    }

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const carol = await user('Carol');
        const [aliceId, bobId, carolId] = await Promise.all([alice, bob, carol].map(idOf));

        // Album mit einem echten JPEG anlegen.
        await alice.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 320;
            const context = canvas.getContext('2d');
            context.fillStyle = '#c0392b';
            context.fillRect(0, 0, 320, 320);
            context.fillStyle = '#f1c40f';
            context.fillRect(80, 80, 160, 160);
            const data = canvas.toDataURL('image/jpeg', 0.9);
            await cacheMedia('albimg_e2e', data, 1);
            await saveAlbum({
                id: 'alb_e2e', ownerId: state.myProfile.id, name: 'Relay', items: [{ id: 'albimg_e2e', version: 1 }],
                acl: [], secret: createAlbumSecret(), keyVersion: 1, keyEpochMinutes: 0, keyEpochsAhead: 1
            });
        });
        await connect(alice, carol);
        await alice.evaluate(() => shareAlbumInChat('alb_e2e'));
        await connect(alice, bob);
        await alice.evaluate(() => shareAlbumInChat('alb_e2e'));

        // C oeffnet das Album, solange A online ist.
        await carol.evaluate(owner => openAlbumViewer('alb_e2e', { ownerId: owner, name: 'Relay' }), aliceId);
        await waitFor(carol, () => Boolean(state.albums.alb_e2e?.manifest));
        await waitFor(carol, async () => Boolean((await loadMedia('albimg_e2e'))?.encrypted) && Boolean(state.albumKeys.alb_e2e));
        await carol.evaluate(() => closeMediaModal());

        // B hat die Schluessel schon (ALBUM_KEYS), aber noch kein Album/Bild. Dann geht A offline.
        await waitFor(bob, async () => (await getAllDatabaseRecords('keys')).some(record => String(record.id).startsWith('album-keys:alb_e2e')));
        await connect(bob, carol);
        await alice.context().close();
        await waitFor(bob, owner => !isSecureChannelOpen(owner), aliceId, 20000);

        await bob.evaluate(owner => openAlbumViewer('alb_e2e', { ownerId: owner, name: 'Relay' }), aliceId);
        await waitFor(bob, () => Boolean(state.albums.alb_e2e?.manifest), null, 20000);
        await waitFor(bob, async () => (await loadMedia('albimg_e2e'))?.relayedBy !== undefined, null, 20000);
        const stored = await bob.evaluate(() => loadMedia('albimg_e2e'));
        assert.equal(stored.relayedBy, carolId);
        await waitFor(bob, () => Boolean(document.querySelector('#album-tile-albimg_e2e canvas')?.width), null, 15000);
        assert.equal(await bob.evaluate(() => document.querySelectorAll('#media-modal-content img').length), 0, 'album images render as canvas');

        // Das Wasserzeichen der weitergegebenen Kopie zeigt auf B, nicht auf C.
        const marked = await bob.evaluate(async ([me, relay]) => {
            const src = secureImageSource(document.querySelector('#album-tile-albimg_e2e canvas'));
            return (await identifyWatermark(src, [me, relay]))?.peerId || null;
        }, [bobId, carolId]);
        assert.equal(marked, bobId, 'watermark names the requester');

        assert.deepEqual(pageErrors, [], 'no uncaught page errors');
        console.log('E2E OK (album relay)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
