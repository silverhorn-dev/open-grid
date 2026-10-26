// End-to-End (Smartphone): Profil bearbeiten. Eine Aenderung zeigt unten die Leiste "Ungespeicherte
// Aenderungen"; Verwerfen stellt den alten Stand her, Speichern uebernimmt (auch nach dem Neuladen).
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
        const page = await (await browser.newContext({ locale: 'de-DE', ...devices['Pixel 7'] })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const onboardingName = page.locator('#onboarding-profile-form input').first();
        await onboardingName.fill('Robin');
        await onboardingName.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));

        await page.click('[data-tab-btn="editprofile"][data-nav="bottom"]');
        const name = page.locator('#dynamic-profile-form input').first();
        assert.equal(await name.inputValue(), 'Robin');
        assert.equal(await page.isVisible('#profile-save-bar'), false, 'no bar without changes');

        await name.fill('Robin B.');
        assert.equal(await page.isVisible('#profile-save-bar'), true, 'bar after a change');
        const bar = await page.locator('#profile-save-bar').boundingBox();
        const nav = await page.locator('nav.bottom-nav').boundingBox();
        assert.ok(bar.y + bar.height <= nav.y + 1, 'bar sits above the bottom navigation');

        await page.click('#profile-save-bar >> text=Verwerfen');
        assert.equal(await page.locator('#dynamic-profile-form input').first().inputValue(), 'Robin', 'discard restores');
        assert.equal(await page.isVisible('#profile-save-bar'), false);

        await page.locator('#dynamic-profile-form input').first().fill('Robin B.');
        await page.click('#profile-save-btn');
        await waitFor(page, () => document.getElementById('profile-save-bar').classList.contains('hidden'));
        assert.equal(await page.evaluate(() => state.myProfile.fields.displayName), 'Robin B.');

        await page.reload();
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        assert.equal(await page.evaluate(() => state.myProfile.fields.displayName), 'Robin B.', 'saved across reload');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (profile save bar, mobile)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
