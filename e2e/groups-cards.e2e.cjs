// End-to-End: Visitenkarten in Gruppen (conversations.js). Alice und Carol kennen sich nicht; Bob (Freund von
// beiden) laedt beide in eine Gruppe ein. Carol geht offline. Alice sieht Carol trotzdem mit Namen (signierte
// Karte, vom Admin weitergereicht), nicht als Node-ID; Unbekannte heissen "Unbekannt".
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
        await page.evaluate(() => setAppMode('chat'));
        return page;
    }
    async function befriend(a, b) {
        const [aId, bId] = await Promise.all([a, b].map(page => page.evaluate(() => state.myProfile.id)));
        await a.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'hi'; await sendChatMessage(); }, bId);
        await waitFor(b, id => (state.chats[id] || []).length > 0, aId);
        await a.evaluate(id => addFriend(id), bId);
        await waitFor(b, id => hasFriendRequest(id), aId);
        await b.evaluate(id => addFriend(id), aId);
        await waitFor(a, id => isFriend(id), bId);
    }
    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const carol = await user('Carol');
        const [aliceId, carolId] = await Promise.all([alice, carol].map(page => page.evaluate(() => state.myProfile.id)));
        await befriend(bob, alice);
        await befriend(bob, carol);
        // Unbekannte Node: "Unbekannt" statt "Peer <id>".
        assert.equal(await alice.evaluate(id => getPeerPresentation(id).name, 'node_never_seen_0000'), 'Unbekannt');

        const groupId = await bob.evaluate(async ids => (await createGroup('Mesh', ids)).id, [aliceId, carolId]);
        await waitFor(carol, id => Boolean(getGroup(id)), groupId, 45000);
        await waitFor(alice, id => Boolean(getGroup(id)), groupId, 45000);
        // Carol ist nur ueber Bob bekannt: ihre Karte kommt ueber den Admin.
        await waitFor(alice, id => groupCardOf(id)?.name === 'Carol', carolId, 45000);
        await carol.close();
        const shown = await alice.evaluate(id => {
            state.peers = state.peers.filter(peer => peer.id !== id);
            return { name: displayNameFor(id), hasProfile: Boolean(state.cachedProfiles[id]) };
        }, carolId);
        // Name aus der Karte (oder, falls Alice Carol doch direkt erreicht hat, aus dem Profil), nie die Node-ID.
        assert.equal(shown.name, 'Carol', `shown as ${JSON.stringify(shown)}`);
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (group member cards)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
