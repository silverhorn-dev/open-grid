// End-to-End: Installations-Anleitung fuer Safari/iOS (install-guide.js, UC-74). Im Safari-Tab kommt sie
// vor dem Einrichten, "Im Browser weiter" braucht zwei Tipps, danach erscheint der Hinweis-Balken (wegklickbar).
// Als installierte Web-App (navigator.standalone) und in anderen Browsern gibt es weder Anleitung noch Balken.
// Eine Einladung aus dem Safari-Tab wird beim Installieren kopiert und in der App beim Einrichten eingefuegt.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

async function waitFor(page, predicate, arg, timeout = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await page.evaluate(predicate, arg).catch(() => false)) return;
        await page.waitForTimeout(250);
    }
    throw new Error(`Timed out waiting for ${predicate}`);
}

async function onboard(page, name) {
    await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
    const input = page.locator('#onboarding-profile-form input').first();
    await input.fill(name);
    await input.dispatchEvent('change');
    await page.click('#complete-onboarding-btn');
    await waitFor(page, () => Boolean(state.myProfile.id && state.myProfile.updatedAt));
}

async function main() {
    if (process.env.OFFLINE || process.env.DESKTOP) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        // 1. iPhone-Safari im Tab: Anleitung vor dem Einrichten.
        const context = await browser.newContext({ locale: 'de-DE', userAgent: IPHONE_SAFARI, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#install-guide-modal:not(.hidden)', { timeout: 20000 });
        assert.equal(await page.locator('#profile-onboarding-modal').isVisible(), false, 'onboarding waits for the guide');
        assert.equal(await page.locator('#install-guide-steps li').count(), 4, 'four iOS steps');
        assert.match(await page.locator('#install-guide-steps').textContent(), /Home-Bildschirm/);

        // "Ist installiert": nur noch der Hinweis, wo es weitergeht; der Tab bleibt bei der Anleitung.
        await page.click('#install-guide-done-btn');
        assert.ok(await page.locator('#install-guide-done').isVisible());
        assert.equal(await page.locator('#profile-onboarding-modal').isVisible(), false);

        // Im Browser weiter: erst Warnung, dann weiter zum Einrichten.
        await page.click('#install-guide-skip-btn');
        assert.ok(await page.locator('#install-guide-skip-warning').isVisible(), 'first tap warns');
        assert.ok(await page.locator('#install-guide-modal').isVisible());
        await page.click('#install-guide-skip-btn');
        await onboard(page, 'Safari');
        assert.ok(await page.locator('#install-hint-bar').isVisible(), 'hint bar for browser users');

        // Balken: Anleitung mit Hinweis auf den leeren Speicher der App, wegklickbar fuer 7 Tage.
        await page.click('#install-hint-bar [data-click="openInstallGuide"]');
        assert.ok(await page.locator('#install-guide-existing').isVisible());
        // "Daten mitnehmen" oeffnet den Umzug (transfer.js), die Anleitung geht zu.
        await page.click('#install-guide-transfer');
        await page.waitForSelector('#transfer-code-btn', { state: 'visible', timeout: 10000 });
        assert.equal(await page.locator('#install-guide-modal').isVisible(), false);
        await page.evaluate(() => closeMediaModal());
        await page.click('#install-hint-bar [data-click="openInstallGuide"]');
        await page.click('#install-guide-skip-btn');
        await page.click('#install-guide-skip-btn');
        assert.equal(await page.locator('#install-guide-modal').isVisible(), false);
        await page.click('#install-hint-bar [data-click="dismissInstallHint"]');
        await page.reload();
        await waitFor(page, () => Boolean(state.myProfile.id && state.ws));
        assert.equal(await page.locator('#install-hint-bar').isVisible(), false, 'dismissed bar stays hidden');
        await context.close();

        // 2. Installierte Web-App (iOS meldet navigator.standalone): direkt einrichten, kein Balken.
        const installed = await browser.newContext({ locale: 'de-DE', userAgent: IPHONE_SAFARI, viewport: { width: 390, height: 844 } });
        await installed.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
        const app = await installed.newPage();
        app.on('pageerror', error => pageErrors.push(error.message));
        await app.goto(`${BASE_URL}/`);
        await onboard(app, 'Installiert');
        assert.equal(await app.locator('#install-guide-modal').isVisible(), false);
        assert.equal(await app.locator('#install-hint-bar').isVisible(), false);
        await installed.close();

        // 4. Einladung im Safari-Tab: Kasten in der Anleitung, "Ist installiert" kopiert den Link, in der
        //    installierten App beim Einrichten einfuegen -> Kontakt ist da.
        const inviter = await browser.newContext({ locale: 'de-DE' });
        const bob = await inviter.newPage();
        await bob.goto(`${BASE_URL}/`);
        await onboard(bob, 'Bob');
        await waitFor(bob, () => Boolean(state.myKeys && state.ws && state.ws.readyState === 1));
        const bobId = await bob.evaluate(() => state.myProfile.id);
        const inviteLink = await bob.evaluate(() => getMyInviteLink());
        const tab = await browser.newContext({ locale: 'de-DE', userAgent: IPHONE_SAFARI, viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] });
        const safari = await tab.newPage();
        safari.on('pageerror', error => pageErrors.push(error.message));
        await safari.goto(inviteLink);
        await safari.waitForSelector('#install-guide-modal:not(.hidden)', { timeout: 20000 });
        assert.ok(await safari.locator('#install-guide-invite').isVisible(), 'invite box in the guide');
        await safari.click('#install-guide-done-btn');
        await waitFor(safari, async () => (await navigator.clipboard.readText()).includes('/invite#'));
        const copied = await safari.evaluate(() => navigator.clipboard.readText());
        assert.equal(copied, inviteLink, 'the whole invite link is copied');
        await tab.close();

        const appContext = await browser.newContext({ locale: 'de-DE', userAgent: IPHONE_SAFARI, viewport: { width: 390, height: 844 } });
        await appContext.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
        const appPage = await appContext.newPage();
        appPage.on('pageerror', error => pageErrors.push(error.message));
        await appPage.goto(`${BASE_URL}/`);
        await appPage.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        await appPage.click('#onboarding-invite-toggle');
        await appPage.fill('#onboarding-invite-input', 'kaputt');
        const nameInput = appPage.locator('#onboarding-profile-form input').first();
        await nameInput.fill('Eingeladen');
        await nameInput.dispatchEvent('change');
        await appPage.click('#complete-onboarding-btn');
        assert.match(await appPage.locator('#onboarding-profile-error').textContent(), /ungültig/, 'broken invite is rejected');
        await appPage.fill('#onboarding-invite-input', copied);
        await appPage.click('#complete-onboarding-btn');
        await waitFor(appPage, id => (state.chatPeerIds || []).includes(id), bobId);
        // Wie ein geoeffneter Link: der Schluessel des Einladenden wird gegen den Fingerprint geprueft.
        await waitFor(appPage, async id => !(await databaseRequest('keys', 'readonly', store => store.get(`invite-expect:${id}`)))
            && Boolean((await getPeerIdentity(id))?.profileSigningKey), bobId);
        await appContext.close();
        await inviter.close();

        // 3. Chrome/Android: nichts davon.
        const android = await browser.newContext({ locale: 'de-DE' });
        const other = await android.newPage();
        await other.goto(`${BASE_URL}/`);
        await onboard(other, 'Android');
        assert.equal(await other.locator('#install-hint-bar').isVisible(), false);
        await android.close();

        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (install guide)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
