// End-to-End: eigenes Profil fuer "Chat & Freunde". Alice schaltet es ein und nennt sich dort anders;
// Bob (Chat in "Chat & Freunde") sieht das Social-Profil, Carol (Chat in "Grid & Event") das Entdecken-Profil.
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
    async function user(name, mode) {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(value => setAppMode(value), mode);
        return page;
    }
    try {
        const alice = await user('Hot Alex', 'discovery');
        const bob = await user('Bob', 'chat');
        const carol = await user('Carol', 'discovery');
        const aliceId = await alice.evaluate(() => state.myProfile.id);

        // Alice: im Profil das eigene Social-Profil einschalten, dort einen anderen Namen speichern.
        await alice.evaluate(() => switchTab('editprofile'));
        await alice.waitForSelector('#social-profile-controls', { state: 'visible' });
        await alice.check('#social-profile-toggle');
        await alice.waitForSelector('#profile-area-chooser', { state: 'visible' });
        await alice.click('#profile-area-chooser [data-profile-area="social"]');
        const nameInput = alice.locator('#dynamic-profile-form input').first();
        assert.equal(await nameInput.inputValue(), 'Hot Alex', 'starts as a copy');
        await nameInput.fill('Alex');
        await nameInput.dispatchEvent('change');
        await alice.click('#profile-save-btn');
        await waitFor(alice, () => state.myProfile.social?.fields?.displayName === 'Alex' && !state.profileDirty);
        // Entdecken-Seite unveraendert.
        await alice.click('#profile-area-chooser [data-profile-area="discovery"]');
        assert.equal(await alice.locator('#dynamic-profile-form input').first().inputValue(), 'Hot Alex');

        // Bob schreibt aus "Chat & Freunde", Carol aus "Grid & Event"; beide holen Alices Profil.
        for (const page of [bob, carol]) {
            await page.evaluate(id => openChatWithPeer(id), aliceId);
            await page.fill('#chat-input', 'hallo');
            await page.click('#send-chat-btn');
        }
        await waitFor(alice, () => Object.keys(state.chatScopes).length >= 2);
        for (const page of [bob, carol]) await page.evaluate(id => sendSecurePayload(id, { type: 'PROFILE_REQUEST' }), aliceId);
        await waitFor(bob, id => state.cachedProfiles[id]?.fields?.displayName === 'Alex', aliceId);
        await waitFor(carol, id => state.cachedProfiles[id]?.fields?.displayName === 'Hot Alex', aliceId);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (separate social profile)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
