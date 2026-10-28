// End-to-End: begrenzt geteiltes Album laeuft ab, waehrend der Betrachter offline ist.
//   - Bei Alice verschwindet Bob nach der Frist von selbst aus der Zugriffsliste.
//   - Der Entzug erreicht Bob ueber Pfad C: kommt er wieder online, sind Album-Schluessel und
//     Zugangsticket geloescht (vorher behielt er sie bis zum Epochenende).
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
    const onboard = async (page, name) => {
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(() => setAppMode('chat'));
    };
    const bundleCount = page => page.evaluate(async () => (await getAllDatabaseRecords('keys'))
        .filter(record => typeof record.id === 'string' && (record.id.startsWith('album-keys:alb_revoke') || record.id === 'album-ticket:alb_revoke')).length);

    try {
        const alice = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        await onboard(alice, 'Alice');
        const bobContext = await browser.newContext({ locale: 'de-DE' });
        let bob = await bobContext.newPage();
        await onboard(bob, 'Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));

        // Alice teilt ein Album fuer 1 h; Bob bekommt Schluessel und Ticket.
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await alice.evaluate(async id => {
            const canvas = document.createElement('canvas');
            canvas.width = 120;
            canvas.height = 120;
            canvas.getContext('2d').fillRect(0, 0, 120, 120);
            await cacheMedia('albimg_revoke', canvas.toDataURL('image/jpeg', 0.8), 1);
            await saveAlbum({
                id: 'alb_revoke', ownerId: state.myProfile.id, name: 'Kurz', items: [{ id: 'albimg_revoke', version: 1 }],
                acl: [], secret: createAlbumSecret(), keyVersion: 1, keyEpochMinutes: 0, keyEpochsAhead: 1
            });
            await openChatWithPeer(id);
            await shareAlbumInChat('alb_revoke', 'h1');
        }, bobId);
        await waitFor(bob, () => getAllDatabaseRecords('keys').then(records => records.some(record => String(record.id).startsWith('album-keys:alb_revoke'))), null, 40000);
        assert.ok(await bundleCount(bob) > 0);

        // Bob geht offline (Seite zu, Daten bleiben im Browser).
        await bob.close();

        // Frist auf gleich verkuerzen: Alice entzieht von selbst, Bob verschwindet aus der Liste.
        await alice.evaluate(async () => {
            switchTab('editprofile');
            const album = state.albums.alb_revoke;
            album.limits[album.acl[0]].until = (await fetchServerTime()).now + 1500;
            await saveAlbum(album);
            scheduleAlbumLimitCheck((await fetchServerTime()).now);
        });
        assert.equal(await alice.evaluate(id => Boolean(document.querySelector(`[data-album-id="alb_revoke"] [data-viewer="${id}"]`)), bobId), true, 'listed before the deadline');
        await waitFor(alice, id => !state.albums.alb_revoke.acl.includes(id), bobId, 10000);
        assert.equal(await alice.evaluate(id => Boolean(document.querySelector(`[data-album-id="alb_revoke"] [data-viewer="${id}"]`)), bobId), false, 'entry disappears after the deadline');
        assert.match(await alice.textContent('[data-album-id="alb_revoke"]'), /nicht geteilt/);

        // Der Entzug liegt im Router-Cache (Pfad C), weil Bob offline ist.
        await alice.waitForTimeout(12000);

        // Bob kommt wieder: Schluessel und Ticket sind weg.
        bob = await bobContext.newPage();
        bob.on('pageerror', error => pageErrors.push(`[Bob] ${error.message}`));
        await bob.goto(`${BASE_URL}/chat`);
        await waitFor(bob, () => Boolean(state.ws && state.ws.readyState === 1));
        await waitFor(bob, () => getAllDatabaseRecords('keys').then(records => !records.some(record => String(record.id).startsWith('album-keys:alb_revoke') || record.id === 'album-ticket:alb_revoke')), null, 40000);

        // Selbstzerstoerung ohne Besitzer: Alice teilt erneut fuer 1 h und geht offline. Zur Frist raeumt
        // Bobs App selbst auf (Album, Bilder, Schluessel, Ticket).
        await alice.evaluate(async id => {
            await openChatWithPeer(id);
            await shareAlbumInChat('alb_revoke', 'h1');
        }, bobId);
        await waitFor(bob, () => getAllDatabaseRecords('keys').then(records => records.some(record => record.id === 'album-expires:alb_revoke')), null, 40000);
        await bob.evaluate(owner => openAlbumViewer('alb_revoke', { ownerId: owner, name: 'Kurz' }), aliceId);
        await waitFor(bob, () => loadMedia('albimg_revoke').then(media => Boolean(media?.encrypted)), null, 20000);
        await bob.evaluate(() => closeMediaModal());
        await alice.close();
        await bob.evaluate(async () => {
            const record = (await getAllDatabaseRecords('keys')).find(entry => entry.id === 'album-expires:alb_revoke');
            await putDatabaseRecord('keys', { ...record, until: (await fetchServerTime()).now + 1500 });
            scheduleAlbumSelfDestruct();
        });
        await waitFor(bob, async () => {
            const records = await getAllDatabaseRecords('keys');
            const left = records.some(record => String(record.id).startsWith('album-keys:alb_revoke') || record.id === 'album-ticket:alb_revoke' || record.id === 'album-expires:alb_revoke');
            return !left && !state.albums.alb_revoke && !(await loadMedia('albimg_revoke'));
        }, null, 15000);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (album revoke over path c)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
