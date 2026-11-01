// End-to-End: "Alter aktualisieren". Laeuft nur mit E2E_AGE_PROVIDER=1 gegen einen Router mit
// AGE_CHECK=provider und AGE_PROVIDER=dev (bestaetigt auf Knopfdruck). Erst Nachweis "unter 18", dann
// ueber die Einstellung neu nachweisen: die Gruppe wechselt.
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
    if (process.env.E2E_AGE_PROVIDER !== '1' || process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Teen');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.routerAuthToken));
        // Erster Nachweis: unter 18 (dev-Anbieter, direkt ueber die API wie die App).
        await page.evaluate(async () => { await safetyRequest('age/finish', { payload: { over18: false } }); await refreshSafetyStatus(); });
        await waitFor(page, () => state.ageGroup === 'minor');
        await page.evaluate(() => { closeSafetyGate(); switchTab('keys'); switchSettingsTab('privacy'); });
        await page.waitForSelector('#safety-age-update', { state: 'visible' });
        assert.match(await page.textContent('#safety-age-group'), /unter 18/);
        // "Alter aktualisieren": der dev-Anbieter bestaetigt ab 18, die Gruppe wechselt.
        await page.click('#safety-age-update');
        await waitFor(page, () => state.ageGroup === 'adult');
        await waitFor(page, () => /ab 18/.test(document.getElementById('safety-age-group').textContent));
        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (update age)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
