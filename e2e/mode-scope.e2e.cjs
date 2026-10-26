// End-to-End: Bereich beim Onboarding. "Nur Entdecken" zeigt nur Grid/Event und blendet Freunde-
// Einstellungen aus; unter Erweitert auf "Social" umstellen wechselt in den Freunde-Modus und blendet
// das Matching aus; "Alle Modi anzeigen" bringt alles zurueck.
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

const shown = (page, selector) => page.evaluate(sel => {
    const element = document.querySelector(sel);
    return Boolean(element && !element.closest('.scope-hidden'));
}, selector);

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(String(error.stack || error.message).slice(0, 400)));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });

        // Drei Bereiche zur Wahl, ohne gespeicherte Wahl ist "Entdecken & Freunde" aktiv.
        const scopeButtons = page.locator('#onboarding-scope-options button');
        assert.equal(await scopeButtons.count(), 3);
        assert.equal(await scopeButtons.nth(2).getAttribute('aria-pressed'), 'true');
        await scopeButtons.nth(0).click();
        await waitFor(page, () => state.appModeSettings.scope === 'discovery');
        assert.equal(await page.isVisible('#onboarding-mode'), false, 'only one selectable mode left (event needs a code)');

        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Alex');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));

        assert.deepEqual(await page.evaluate(() => [...state.appConfig.modes]), ['discovery', 'event']);
        assert.equal(await page.evaluate(() => state.appMode), 'discovery');
        assert.equal(await shown(page, '#profile-visibility-select'), true, 'matching settings stay');
        assert.equal(await shown(page, '#match-friends-toggle'), false, 'no adding after a match');
        assert.equal(await shown(page, '#status-direct-toggle'), false, 'no status');
        assert.equal(await shown(page, '#list-switch-toggle'), false, 'only one chat list');
        assert.equal(await page.evaluate(() => allowsMatchFriends()), false);

        // Erweitert: auf Social umstellen.
        await page.evaluate(() => switchTab('keys'));
        await page.evaluate(() => switchSettingsTab('general'));
        await page.click('#mode-scope-settings summary');
        await page.selectOption('#mode-scope-select', 'social');
        await waitFor(page, () => state.appMode === 'friends');
        assert.equal(await shown(page, '#profile-visibility-select'), false, 'no matching in social');
        assert.equal(await shown(page, '#status-direct-toggle'), true);
        assert.equal(await shown(page, '#live-grid-toggle'), false, 'live grid is for the public grid only');
        assert.equal(await shown(page, '#silent-mode-toggle'), true, 'friends grid keeps its visibility');

        // Alle Modi anzeigen.
        await page.click('label:has(#all-modes-toggle)');
        await waitFor(page, () => state.appModeSettings.scope === 'all');
        assert.deepEqual(await page.evaluate(() => [...state.appConfig.modes]), ['discovery', 'chat', 'friends', 'event']);
        assert.equal(await shown(page, '#match-friends-toggle'), true);
        assert.equal(await shown(page, '#list-switch-toggle'), true);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (mode scope)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
