// End-to-End: Umzug per Code/QR ueber das Router-Relay (transfer.js, server/transfer-relay.js). Die alte Kopie
// erstellt einen Code; ein neues Geraet oeffnet den Link aus dem QR (/transfer#code), die Uebernahme ist
// vorausgefuellt. Der Code klappt genau einmal. Vorerst nur im Debug-Modus.
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
    const newPage = async (path = '/') => {
        const context = await browser.newContext({ locale: 'de-DE', permissions: ['clipboard-read', 'clipboard-write'] });
        await context.addInitScript(() => localStorage.setItem('opengrid-debug-mode', 'on'));
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}${path}`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        return page;
    };
    try {
        const alice = await newPage();
        const input = alice.locator('#onboarding-profile-form input').first();
        await input.fill('Code Alice');
        await input.dispatchEvent('change');
        await alice.click('#complete-onboarding-btn');
        await waitFor(alice, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.updatedAt && state.routerAuthToken));

        await alice.evaluate(() => openTransferExport());
        await alice.click('#transfer-code-btn');
        await alice.waitForSelector('#transfer-code-output', { timeout: 30000 });
        const code = await alice.inputValue('#transfer-code-output');
        assert.match(code, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
        assert.ok(await alice.locator('#transfer-code-qr').isVisible(), 'QR for another device');

        // Neues Geraet ueber den Link aus dem QR: Uebernahme mit vorausgefuelltem Code.
        const fresh = await newPage(`/transfer#${code}`);
        await fresh.waitForSelector('#transfer-import-code', { timeout: 10000 });
        assert.equal(await fresh.inputValue('#transfer-import-code'), code);
        assert.equal(new URL(fresh.url()).hash, '', 'code removed from the address bar');
        await Promise.all([fresh.waitForEvent('load', { timeout: 60000 }), fresh.click('#transfer-import-btn')]);
        await waitFor(fresh, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.updatedAt));
        assert.equal(await fresh.evaluate(() => state.myProfile.fields.displayName), 'Code Alice');
        assert.equal(await fresh.locator('#profile-onboarding-modal').isVisible(), false);

        // Ein zweites Mal geht nicht.
        const late = await newPage();
        await late.evaluate(() => openTransferImport());
        await late.fill('#transfer-import-code', code);
        await late.click('#transfer-import-btn');
        await waitFor(late, () => /abgelaufen|benutzt/.test(document.getElementById('transfer-import-error').textContent), null, 20000);
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (transfer code)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
