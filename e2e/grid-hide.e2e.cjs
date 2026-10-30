// End-to-End: "Im Entdecken-Grid verstecken vor Freunden". Einseitig: Alice versteckt sich, ihr Freund Bob
// sieht sie im Entdecken-Grid nicht mehr; Alice sieht Bob weiter. Gefiltert im Client (der Router weiss nichts).
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
        return page;
    }
    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));

        // Freunde ueber "Chat & Freunde".
        for (const page of [alice, bob]) await page.evaluate(() => setAppMode('chat'));
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await alice.fill('#chat-input', 'hi');
        await alice.click('#send-chat-btn');
        await waitFor(bob, id => (state.chats[id] || []).length > 0, aliceId);
        await alice.evaluate(id => addFriend(id), bobId);
        await waitFor(bob, id => hasFriendRequest(id), aliceId);
        await bob.evaluate(id => addFriend(id), aliceId);
        await waitFor(alice, id => isFriend(id), bobId);

        // Beide im Entdecken-Grid: sehen sich.
        for (const page of [alice, bob]) await page.evaluate(async () => { await setAppMode('discovery'); switchTab('grid'); await refreshGrid(); });
        await waitFor(bob, id => state.peers.some(peer => peer.id === id), aliceId);
        await waitFor(alice, id => state.peers.some(peer => peer.id === id), bobId);
        await bob.evaluate(() => renderDiscoveryGrid());
        assert.equal(await bob.evaluate(id => state.profileBrowseList.includes(id), aliceId), true, 'friends see each other at first');

        // Alice versteckt sich vor Freunden (Einstellung), Bob holt ihr neues Profil.
        await alice.evaluate(() => { switchTab('keys'); switchSettingsTab('privacy'); });
        await alice.selectOption('#grid-hide-from-select', 'friends');
        await waitFor(alice, () => state.myProfile.gridHideFrom === 'friends');
        await bob.evaluate(id => sendSecurePayload(id, { type: 'PROFILE_REQUEST' }), aliceId);
        await waitFor(bob, id => state.cachedProfiles[id]?.gridHideFrom === 'friends', aliceId);
        await bob.evaluate(() => renderDiscoveryGrid());
        assert.equal(await bob.evaluate(id => hiddenFromMyGrid(id), aliceId), true);
        assert.equal(await bob.evaluate(id => (state.profileBrowseList || []).includes(id), aliceId), false, 'Bob no longer sees Alice in the grid');
        // Einseitig: Alice sieht Bob weiter.
        await alice.evaluate(async () => { switchTab('grid'); renderDiscoveryGrid(); });
        assert.equal(await alice.evaluate(id => (state.profileBrowseList || []).includes(id), bobId), true, 'Alice still sees Bob');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (hide from friends in the grid)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
