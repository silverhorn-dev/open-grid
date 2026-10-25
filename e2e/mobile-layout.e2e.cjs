// End-to-End (nur Smartphone-Variante): Chatliste bleibt im Bildschirm und scrollt in sich,
// Kurzstatus steht in eigener Zeile, die Alben-Karte erscheint im Chat-Modus erst mit eigenem Album.
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function waitFor(page, predicate, arg, timeout = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await page.evaluate(predicate, arg).catch(() => false)) return;
        await page.waitForTimeout(200);
    }
    throw new Error(`Timed out waiting for ${predicate}`);
}

async function main() {
    if (!process.env.MOBILE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Mobile');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));

        await page.evaluate(async () => {
            await setAppMode('chat');
            for (let index = 0; index < 25; index++) {
                const id = `node_fake_${index}`;
                state.friendState[id] = { sentAt: 2, receivedAt: 3, resetAt: 0 };
                state.cachedProfiles[id] = { fields: { displayName: `Freund ${index} mit einem sehr langen Namen` }, presenceText: 'Im Club bis spaet' };
                state.chatPeerIds.push(id);
                state.chatPreviews[id] = { text: `Nachricht ${index}`, at: Date.now() - index * 60000, mine: false };
            }
            switchTab('chat');
            renderActivePeerList();
        });
        await page.waitForTimeout(400);
        const layout = await page.evaluate(() => {
            const list = document.getElementById('active-peers-list');
            return { page: document.documentElement.scrollHeight, viewport: window.innerHeight, scrollable: list.scrollHeight > list.clientHeight };
        });
        assert.ok(layout.page <= layout.viewport + 2, `page does not scroll (${layout.page} > ${layout.viewport})`);
        assert.equal(layout.scrollable, true, 'the chat list scrolls itself');
        assert.equal(await page.isVisible('#active-peers-list >> text=Im Club bis spaet >> nth=0'), true, 'presence visible on mobile');

        // Auch wenn die Seite scrollt (z. B. ein- und ausfahrende Adressleiste), bleibt der Kopf der Liste stehen.
        await page.evaluate(() => { document.body.style.paddingBottom = '600px'; window.scrollTo(0, 400); });
        await page.waitForTimeout(200);
        const head = await page.evaluate(() => ({
            top: Math.round(document.getElementById('chat-list-head').getBoundingClientRect().top),
            header: Math.round(document.querySelector('header.app-header').getBoundingClientRect().bottom)
        }));
        assert.ok(Math.abs(head.top - head.header) <= 2, `list head stays pinned below the app header (${head.top} vs ${head.header})`);
        await page.evaluate(() => { document.body.style.paddingBottom = ''; window.scrollTo(0, 0); });

        // Alben-Karte: im Chat-Modus ohne eigene Alben versteckt, mit Album sichtbar.
        await page.evaluate(() => switchTab('editprofile'));
        assert.equal(await page.isVisible('#album-manager-card'), false);
        await page.evaluate(async () => {
            await saveAlbum({ id: 'alb_m', ownerId: state.myProfile.id, name: 'Urlaub', items: [], acl: ['node_fake_1'], secret: createAlbumSecret(), keyVersion: 1 });
        });
        assert.equal(await page.isVisible('#album-manager-card'), true);
        await page.evaluate(() => setAppMode('discovery'));
        assert.equal(await page.isVisible('#album-manager-card'), true);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (mobile layout)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
