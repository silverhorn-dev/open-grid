// End-to-End: Profilbild im Profil-Popup antippen -> Bildbetrachter zeigt die grosse Fassung. Das Profil
// traegt nur 200 px; die grosse Fassung holt der Betrachter per P2P beim Besitzer (wie Galeriebilder).
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
        return page;
    }
    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));

        // Alice laedt ein grosses Profilbild hoch (2000 x 1500).
        const png = await alice.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 2000;
            canvas.height = 1500;
            const context = canvas.getContext('2d');
            // Verrauscht wie ein Foto: die grosse Fassung wird dann einige 100 KB gross (groesser als eine
            // DataChannel-Nachricht, geht in Stuecken).
            const pixels = context.createImageData(2000, 1500);
            for (let index = 0; index < pixels.data.length; index += 4) {
                pixels.data[index] = (index * 7919) % 251;
                pixels.data[index + 1] = (index * 104729) % 241;
                pixels.data[index + 2] = (index * 1299709) % 239;
                pixels.data[index + 3] = 255;
            }
            context.putImageData(pixels, 0, 0);
            return canvas.toDataURL('image/png').split(',')[1];
        });
        await alice.setInputFiles('input[data-change="handleAvatarUpload"]', { name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
        await waitFor(alice, () => Boolean(state.myProfile.avatarFull?.id));
        const fullSize = await alice.evaluate(async () => (await loadMedia(state.myProfile.avatarFull.id)).data.length);
        assert.ok(fullSize > 260 * 1024, `full picture larger than one channel message (${fullSize})`);

        // Bob oeffnet Alices Profil (oeffentlich), tippt auf das Bild.
        await bob.evaluate(id => openProfileModal(id), aliceId);
        await waitFor(bob, id => Boolean(state.cachedProfiles[id]?.avatarFull?.id), aliceId);
        await waitFor(bob, () => document.getElementById('modal-profile-img').naturalWidth > 0);
        assert.ok(await bob.evaluate(() => document.getElementById('modal-profile-img').naturalWidth <= 200), 'the profile carries the small picture');
        await bob.click('#modal-profile-img');
        await waitFor(bob, () => isImageViewerOpen());
        await waitFor(bob, () => document.getElementById('image-viewer-image').width >= 1280, undefined, 20000);
        assert.equal(await bob.evaluate(id => state.pendingImageRequests[`${id}:${state.cachedProfiles[id].avatarFull.id}`], aliceId), undefined, 'request answered');

        // Zweites Oeffnen: grosse Fassung kommt sofort aus dem lokalen Speicher.
        await bob.evaluate(() => closeImageViewer());
        await bob.click('#modal-profile-img');
        await waitFor(bob, () => isImageViewerOpen() && document.getElementById('image-viewer-image').width >= 1280, undefined, 5000);

        // Danach scharf: Profil-Popup und Grid-Karte nehmen die schon geladene grosse Fassung (verkleinert).
        await bob.evaluate(() => closeImageViewer());
        await bob.evaluate(() => closeProfileModal());
        await bob.evaluate(id => openProfileModal(id), aliceId);
        await waitFor(bob, () => document.getElementById('modal-profile-img').naturalWidth > 200, undefined, 10000);
        await bob.evaluate(() => closeProfileModal());
        await bob.evaluate(async () => { switchTab('grid'); await refreshGrid(); renderDiscoveryGrid(); });
        await waitFor(bob, name => [...document.querySelectorAll('#view-grid img, img')].some(image => image.alt.includes(name) && image.naturalWidth > 200), 'Alice', 15000);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (profile picture full size, sharp in grid and profile)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
