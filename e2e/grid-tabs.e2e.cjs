// End-to-End: Grid mit drei Bereichen. Flamme kommt an -> Interaktionen (mit Badge), "Flamme zurueck"
// -> Match erscheint unter Matches als "Noch nicht angeschrieben", "Schreiben" oeffnet den Chat.
// Profilbesuche (wenn der Besucher sie teilt) landen ebenfalls unter Interaktionen. Alles lokal.
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
    async function user(name) {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(() => setAppMode('discovery'));
        return page;
    }

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        await bob.evaluate(() => switchTab('grid'));
        assert.equal(await bob.isVisible('#grid-tabs'), true, 'tabs in discovery');

        // Profilbesuch (Alice teilt, Bob hat Profilbesuche an) und Flamme von Alice.
        await bob.evaluate(() => updateNotificationSetting('profileView', true));
        await alice.evaluate(() => updateProfileViewSharing(true));
        await alice.evaluate(id => { openProfileModal(id); closeProfileModal(); }, bobId);
        await alice.evaluate(id => sendFlame(id), bobId);
        await waitFor(bob, () => state.interactions.items.some(item => item.kind === 'flame') && state.interactions.items.some(item => item.kind === 'view'));
        await waitFor(bob, () => document.getElementById('grid-interactions-badge').textContent === '1');

        await bob.click('[data-grid-view="interactions"]');
        // Eine Zeile pro Person (Flamme und Besuch von Alice zusammen).
        await waitFor(bob, () => document.querySelectorAll('#grid-interactions .grid-list-row').length === 1);
        assert.match(await bob.textContent('#grid-interactions'), /hat dir eine Flamme geschickt · hat dein Profil angesehen/);
        assert.equal(await bob.isVisible('#grid-interactions-badge'), false, 'seen');
        assert.equal(await bob.isVisible('#grid-container'), false);

        // Flamme zurueck -> Match.
        await bob.click('#grid-interactions .grid-list-action:has-text("Flamme zurück")');
        await waitFor(bob, id => isMatched(id), aliceId);
        await bob.click('[data-grid-view="matches"]');
        await waitFor(bob, () => /Noch nicht angeschrieben/.test(document.getElementById('grid-matches').textContent));
        await bob.click('#grid-matches .grid-list-action');
        await waitFor(bob, id => state.activeChatPeerId === id, aliceId);

        // Im Social-Bereich keine Tabs.
        await bob.evaluate(() => { setAppMode('chat'); switchTab('grid'); renderDiscoveryGrid(); });
        assert.equal(await bob.isVisible('#grid-tabs'), false, 'no tabs in social');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (grid tabs)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
