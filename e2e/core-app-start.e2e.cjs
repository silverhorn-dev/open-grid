// End-to-End: Start in der Android-App (K4) im Browser nachgestellt. Der User-Agent enthaelt "OpenGridCore" wie in der
// App: die Oberflaeche wartet auf den Kern, statt allein zu arbeiten (sonst waeren zwei Kopien online).
// 1) Einrichten: Kern ohne Profil (idle) -> Oberflaeche arbeitet allein und richtet ein.
// 2) Danach (Kern neu geladen, wie CoreHost nach dem Schliessen): Oberflaeche wird "ui".
// 3) Kern startet erst nach der Oberflaeche: sie wartet und wird trotzdem "ui".
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
    try {
        const context = await browser.newContext({
            locale: 'de-DE',
            userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 OpenGridApp/0.3.0 OpenGridCore/1'
        });
        const open = async (path, name) => {
            const page = await context.newPage();
            page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
            await page.goto(`${BASE_URL}${path}`);
            return page;
        };
        // 1) Einrichten.
        let core = await open('/core.html', 'core');
        await core.waitForTimeout(1500);
        const setup = await open('/', 'setup');
        await setup.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        assert.equal(await setup.evaluate(() => APP_ROLE), 'full', 'core without profile: the UI sets up alone');
        const input = setup.locator('#onboarding-profile-form input').first();
        await input.fill('Appy');
        await input.dispatchEvent('change');
        await setup.click('#complete-onboarding-btn');
        await waitFor(setup, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.updatedAt));
        await setup.close();

        // 2) Kern neu (wie CoreHost nach dem Schliessen), dann Oberflaeche.
        assert.match(await core.evaluate(() => location.pathname), /^\/core\.html$/, 'the core keeps its address');
        await core.reload();
        await waitFor(core, () => state.ws?.readyState === 1, null, 30000);
        let ui = await open('/', 'ui');
        try {
            await waitFor(ui, () => APP_ROLE === 'ui' && Boolean(state.myProfile.updatedAt), null, 20000);
        } catch (error) {
            console.log('DEBUG ui', JSON.stringify(await ui.evaluate(() => ({ role: APP_ROLE, updatedAt: state.myProfile.updatedAt, ws: Boolean(state.ws) }))));
            console.log('DEBUG core', JSON.stringify(await core.evaluate(() => ({ role: APP_ROLE, ready: coreReady(), updatedAt: state.myProfile.updatedAt, ws: state.ws?.readyState, channel: Boolean(coreLink.channel) }))));
            throw error;
        }
        assert.equal(await ui.evaluate(() => state.ws), null);
        await ui.close();

        // 3) Kern erst nach der Oberflaeche.
        await core.close();
        await new Promise(resolve => setTimeout(resolve, 7000));
        ui = await open('/', 'ui-early');
        await ui.waitForTimeout(3000);
        core = await open('/core.html', 'core-late');
        await waitFor(ui, () => APP_ROLE === 'ui', null, 20000);
        await ui.waitForTimeout(1000);
        assert.equal(await ui.evaluate(() => state.ws), null, 'waited for the core instead of connecting itself');
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (app start with core)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
