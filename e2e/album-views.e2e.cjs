// End-to-End: Album "1x ansehen". Bob oeffnet es einmal (die Ansicht wird gezaehlt), beim Schliessen
// sind Schluessel und gespeicherte Ansichts-Buendel sofort weg und Alice entzieht den Zugriff gleich
// (vorher konnte Bob 15 Minuten lang beliebig oft neu oeffnen).
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
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    async function user(name) {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(() => setAppMode('chat'));
        return page;
    }
    const bundles = page => page.evaluate(async () => (await getAllDatabaseRecords('keys')).filter(record => String(record.id).startsWith('album-keys:alb_once')).length);

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await alice.evaluate(async id => {
            const canvas = document.createElement('canvas');
            canvas.width = 120;
            canvas.height = 120;
            canvas.getContext('2d').fillRect(0, 0, 120, 120);
            await cacheMedia('albimg_once', canvas.toDataURL('image/jpeg', 0.8), 1);
            await saveAlbum({
                id: 'alb_once', ownerId: state.myProfile.id, name: 'Einmal', items: [{ id: 'albimg_once', version: 1 }],
                acl: [], secret: createAlbumSecret(), keyVersion: 1, keyEpochMinutes: 0, keyEpochsAhead: 1
            });
            await openChatWithPeer(id);
            await shareAlbumInChat('alb_once', 'views1');
        }, bobId);
        await waitFor(bob, () => Object.values(state.chats).flat().some(message => message.album?.albumId === 'alb_once'));

        // Erste (und einzige) Ansicht.
        await bob.evaluate(id => openAlbumViewer('alb_once', { ownerId: id, name: 'Einmal' }), aliceId);
        await waitFor(bob, () => Boolean(state.albumKeys.alb_once), null, 20000);
        assert.equal(await alice.evaluate(id => state.albums.alb_once.limits[id].used, bobId), 1, 'one view counted');

        // Schliessen beendet die Ansicht: bei Bob nichts mehr, Alice entzieht sofort.
        await bob.evaluate(() => closeMediaModal());
        await waitFor(bob, () => !state.albumKeys.alb_once, null, 5000);
        assert.equal(await bundles(bob), 0, 'stored view bundles are deleted on close');
        await waitFor(alice, id => !state.albums.alb_once.acl.includes(id), bobId, 10000);

        // Erneut oeffnen bringt nichts mehr.
        await bob.evaluate(id => openAlbumViewer('alb_once', { ownerId: id, name: 'Einmal' }), aliceId);
        await bob.waitForTimeout(3000);
        assert.equal(await bob.evaluate(() => Boolean(state.albumKeys.alb_once)), false, 'no second view');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (album views)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
