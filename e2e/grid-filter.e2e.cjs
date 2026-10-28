// End-to-End: Grid-Filter nur auf dem Geraet. Profile kommen im Hintergrund (P2P), danach wird
// gefiltert und sortiert; ohne Profil "unbekannt". Im offenen Profil blaettern die Pfeiltasten.
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
    async function user(name, age) {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(async value => {
            await setAppMode('discovery');
            state.myProfile.fields.age = value;
            state.myProfile.version = (state.myProfile.version || 1) + 1;
            state.myProfile.updatedAt = Date.now();
            await cacheOwnProfile();
        }, age);
        return page;
    }

    try {
        const alice = await user('Alice', 30);
        const bob = await user('Bob', 41);
        const carol = await user('Carol', 24);
        const [bobId, carolId] = await Promise.all([bob, carol].map(page => page.evaluate(() => state.myProfile.id)));
        // Alice sieht Bob und Carol im Grid (fest vorgegeben, damit der Router-Abruf nicht dazwischenfunkt).
        await alice.evaluate(ids => {
            fetchPeersFromWorkerGrid = async () => false;
            state.peers = ids.map((id, index) => ({ id, name: index ? 'Carol' : 'Bob', distanceBucket: 'lt1' }));
            switchTab('grid');
            renderDiscoveryGrid();
        }, [bobId, carolId]);
        // Filter-Panel per Pfeil-Knopf, Alter 20-35.
        await alice.click('#grid-filter-btn');
        assert.equal(await alice.isVisible('#grid-filter-panel'), true);
        await alice.evaluate(() => updateGridFilter({ ranges: { age: { min: 20, max: 35 } } }));
        assert.equal(await alice.evaluate(() => document.getElementById('grid-filter-btn').classList.contains('is-active')), true);
        // Profile kommen im Hintergrund: Bob (41) faellt raus, Carol (24) bleibt.
        await waitFor(alice, ids => Boolean(state.cachedProfiles[ids[0]]?.fields && state.cachedProfiles[ids[1]]?.fields), [bobId, carolId], 40000);
        await waitFor(alice, () => { const text = document.getElementById('grid-container').textContent; return text.includes('Carol') && !text.includes('Bob'); });
        // Unbekannte ausblenden aendert hier nichts mehr (beide Profile da); zuruecksetzen zeigt wieder beide.
        await alice.evaluate(() => resetGridFilter());
        await waitFor(alice, () => { const text = document.getElementById('grid-container').textContent; return text.includes('Carol') && text.includes('Bob'); });

        // Blaettern im Profil.
        await alice.evaluate(id => openProfileModal(id), bobId);
        await alice.keyboard.press('ArrowRight');
        await waitFor(alice, id => state.activeModalPeerId === id, carolId, 5000);
        await alice.keyboard.press('ArrowLeft');
        await waitFor(alice, id => state.activeModalPeerId === id, bobId, 5000);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (grid filter)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
