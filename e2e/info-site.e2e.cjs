// End-to-End: Info-Seite unter /info (ohne INFO_HOST). Standard "Einfach erklaert", Umschalten auf
// Fachbegriffe ohne Neuladen, Seitenwechsel, Englisch, Neuigkeiten (Changelog) und der Link aus der App.
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
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/info`);
        await page.waitForSelector('#info-content h1');
        assert.equal(await page.textContent('#info-content h1'), 'Willkommen bei OpenGrid');
        const content = () => page.textContent('#info-content');
        assert.match(await content(), /auf Privatsphäre ausgelegte Dating- und Chat-App/, 'plain wording by default');
        assert.doesNotMatch(await content(), /\[\[|\$\{/);

        await page.click('#info-controls >> text=Mit Fachbegriffen');
        await waitFor(page, () => document.getElementById('info-content').textContent.includes('Privacy-First'));
        assert.match(await content(), /per Peer-to-Peer \(P2P\)/);

        await page.click('#info-nav >> text=Häufige Fragen');
        await waitFor(page, () => document.querySelector('#info-content h1')?.textContent === 'Häufige Fragen');
        assert.equal(new URL(page.url()).pathname, '/info/faq');
        assert.match(await content(), /Einstellungen → Chat → Push-Benachrichtigungen/, 'app labels via ui: keys');
        await page.goBack();
        await waitFor(page, () => document.querySelector('#info-content h1')?.textContent === 'Willkommen bei OpenGrid');

        await page.click('#info-nav >> text=Neuigkeiten');
        await waitFor(page, () => /Build \d+/.test(document.getElementById('info-content').textContent));

        await Promise.all([page.waitForEvent('load'), page.click('#info-controls >> text=EN')]);
        await page.waitForSelector('#info-content h1');
        await page.goto(`${BASE_URL}/info`);
        await waitFor(page, () => document.querySelector('#info-content h1')?.textContent === 'Welcome to OpenGrid');
        assert.match(await content(), /privacy-first dating and chat app/, 'technical mode is remembered');

        // Link aus der App (Menue) zeigt auf die Info-Seite.
        const app = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        await app.goto(`${BASE_URL}/`);
        await app.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        assert.equal(await app.getAttribute('#profile-onboarding-modal [data-info-link]', 'href'), '/info');
        assert.equal(await app.getAttribute('#app-menu [data-info-link]', 'href'), '/info');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (info site)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
