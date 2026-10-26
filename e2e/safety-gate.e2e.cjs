// End-to-End: Nachweis-Pflicht (T2). Laeuft nur mit E2E_SAFETY=1 gegen einen Server mit
// AGE_CHECK=confirm (der normale Lauf hat alle Pruefungen aus). Bob bleibt unsichtbar, bis er sein
// Alter bestaetigt; danach sieht Alice ihn im Grid.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function waitFor(page, predicate, arg, timeout = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await page.evaluate(predicate, arg).catch(() => false)) return;
        await page.waitForTimeout(200);
    }
    throw new Error(`Timed out waiting for ${predicate}`);
}

async function onboard(browser, name) {
    const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
    await page.goto(`${BASE_URL}/`);
    await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
    const input = page.locator('#onboarding-profile-form input').first();
    await input.fill(name);
    await input.dispatchEvent('change');
    await page.click('#complete-onboarding-btn');
    await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
    return page;
}

async function main() {
    if (!process.env.E2E_SAFETY || process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    try {
        const alice = await onboard(browser, 'Alice');
        await alice.waitForSelector('#safety-modal:not(.hidden)', { timeout: 15000 });
        await alice.click('label:has(#safety-age-checkbox)');
        await alice.click('#safety-age-confirm button');
        await waitFor(alice, () => document.getElementById('safety-modal').classList.contains('hidden'));

        const bob = await onboard(browser, 'Bob');
        await bob.waitForSelector('#safety-modal:not(.hidden)', { timeout: 15000 });
        assert.equal(await bob.isVisible('#safety-email'), false, 'only the age check is required');
        const bobId = await bob.evaluate(() => state.myProfile.id);

        // Unbestaetigt: Alice sieht Bob nicht.
        await alice.evaluate(() => refreshPresenceAndGrid());
        await alice.waitForTimeout(1000);
        assert.equal(await alice.evaluate(id => state.peers.some(peer => peer.id === id), bobId), false, 'invisible before the check');

        // Weggeklickt: in den Einstellungen bleibt der Hinweis.
        await bob.click('#safety-modal [data-click="closeSafetyGate"]');
        await bob.evaluate(() => { switchTab('keys'); switchSettingsTab('privacy'); });
        assert.equal(await bob.isVisible('#safety-card-btn'), true);
        await bob.click('#safety-card-btn');
        await bob.click('#safety-age-confirm button');
        assert.equal(await bob.isVisible('#safety-modal'), true, 'box not ticked yet');
        await bob.click('label:has(#safety-age-checkbox)');
        await bob.click('#safety-age-confirm button');
        await waitFor(bob, () => document.getElementById('safety-modal').classList.contains('hidden'));

        await waitFor(alice, async id => {
            await refreshPresenceAndGrid();
            return state.peers.some(peer => peer.id === id);
        }, bobId, 20000);
        console.log('E2E OK (safety gate)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
