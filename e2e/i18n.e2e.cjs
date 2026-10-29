// End-to-End: Sprache. Ein englisches Geraet bekommt die App auf Englisch (statisches Markup und
// Texte aus JavaScript), Profil-Felder aus dem Schema ebenfalls. In den Einstellungen auf Deutsch
// umstellen laedt die App neu, die Wahl bleibt erhalten.
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

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext({ locale: 'en-US' })).newPage();
        page.on('pageerror', error => pageErrors.push(String(error.stack || error.message).slice(0, 400)));
        // Sprache schon, wenn der Body beginnt (der Browser erkennt die Seitensprache frueh).
        await page.addInitScript(() => {
            new MutationObserver((records, observer) => {
                if (!document.body) return;
                window.__langAtBody = document.documentElement.lang;
                observer.disconnect();
            }).observe(document, { childList: true, subtree: true });
        });
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
        assert.equal(await page.evaluate(() => window.__langAtBody), 'en', 'language set before the content');
        assert.match(await page.textContent('#profile-onboarding-modal'), /How do you want to use OpenGrid\?/);
        assert.match(await page.textContent('#profile-onboarding-modal'), /Display name/, 'schema label in English');
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Alex');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));

        await page.evaluate(() => switchTab('keys'));
        assert.equal((await page.textContent('[data-settings-tab-btn="privacy"]')).trim(), 'Privacy');
        assert.equal(await page.inputValue('#language-select'), 'auto');
        await page.evaluate(() => showToast(t('friends.youAreFriendsNow'), 'success'));
        assert.match(await page.textContent('body'), /You are friends now\./);

        // Auf Deutsch umstellen: Neuladen, danach deutsch und die Wahl bleibt.
        await Promise.all([
            page.waitForEvent('load'),
            page.selectOption('#language-select', 'de')
        ]);
        await waitFor(page, () => document.documentElement.lang === 'de');
        await waitFor(page, () => Boolean(document.querySelector('[data-settings-tab-btn="privacy"]')));
        assert.equal((await page.textContent('[data-settings-tab-btn="privacy"]')).trim(), 'Privatsphäre');
        await page.evaluate(() => switchTab('keys'));
        assert.equal(await page.inputValue('#language-select'), 'de');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (language)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
