// End-to-End: Testseite fuer den Wallet-Altersnachweis (Debug-Modus). Die Karte erscheint unter
// Privatsphaere, nennt die Browser-Unterstuetzung, fragt die (hier nachgebildete) Wallet und zeigt die
// Antwort des Routers; eine ungueltige Antwort wird abgelehnt, freigeschaltet wird nichts.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Wallet');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await page.waitForTimeout(1500);

        await page.evaluate(() => { document.documentElement.classList.add('debug-on'); switchTab('keys'); switchSettingsTab('privacy'); });
        assert.equal(await page.isVisible('#age-test-card'), true, 'test card in debug mode');
        assert.ok((await page.textContent('#age-test-support')).length > 10, 'browser support is explained');

        // Wallet nachbilden: liefert eine Antwort, die keine gueltige Praesentation ist.
        const requests = await page.evaluate(() => {
            window.__walletRequests = [];
            window.DigitalCredential = function DigitalCredential() {};
            navigator.credentials.get = async options => {
                window.__walletRequests.push(JSON.parse(JSON.stringify(options.digital.requests)));
                return { protocol: 'openid4vp-v1-unsigned', data: { vp_token: { av: ['AAAA'] } } };
            };
            return window.__walletRequests.length;
        });
        assert.equal(requests, 0);
        await page.click('[data-click="testEudiWallet"]');
        let report = '';
        for (let attempt = 0; attempt < 60 && !/Nicht anerkannt|Gültig/.test(report); attempt += 1) {
            await page.waitForTimeout(500);
            report = await page.textContent('#age-test-result');
        }
        assert.match(report, /Nicht anerkannt: Invalid presentation/, report);
        const sent = await page.evaluate(() => window.__walletRequests[0][0]);
        assert.equal(sent.protocol, 'openid4vp-v1-unsigned');
        assert.equal(sent.data.response_mode, 'dc_api');
        assert.deepEqual(sent.data.dcql_query.credentials.map(credential => credential.claims[0].path[1]), ['age_over_18', 'age_over_18', 'age_over_18']);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (age test page)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
