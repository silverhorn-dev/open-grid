// End-to-End: gebuendelter Pfad C fuer Gruppen (conversations.js, Board T36 P2c). Bob und Carol sind offline;
// Alice schreibt in die Gruppe: EIN Upload mit beiden Empfaengern, verschluesselt mit Alices Absender-Schluessel.
// Kommen beide zurueck, lesen sie die Nachricht (Schluessel kam paarweise ueber den Zwischenspeicher).
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
    const contexts = {};
    async function user(name, onboard = true) {
        contexts[name] = contexts[name] || await browser.newContext({ locale: 'de-DE' });
        const page = await contexts[name].newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        if (onboard) {
            await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
            const input = page.locator('#onboarding-profile-form input').first();
            await input.fill(name);
            await input.dispatchEvent('change');
            await page.click('#complete-onboarding-btn');
        }
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
        let bob = await user('Bob');
        let carol = await user('Carol');
        const [bobId, carolId] = await Promise.all([bob, carol].map(page => page.evaluate(() => state.myProfile.id)));
        await befriend(alice, bob);
        await befriend(alice, carol);
        const groupId = await alice.evaluate(async ids => (await createGroup('Buendel', ids)).id, [bobId, carolId]);
        await waitFor(bob, id => Boolean(getGroup(id)), groupId, 45000);
        await waitFor(carol, id => Boolean(getGroup(id)), groupId, 45000);

        // Beide offline; Alices Uploads mitzaehlen.
        await bob.close();
        await carol.close();
        await alice.waitForTimeout(3000);
        const uploads = [];
        alice.on('request', request => {
            if (request.url().endsWith('/api/cache') && request.method() === 'POST') uploads.push(JSON.parse(request.postData() || '{}'));
        });
        await alice.evaluate(async id => {
            state.activeChatPeerId = id;
            document.getElementById('chat-input').value = 'alle offline';
            await sendChatMessage();
        }, groupId);
        await waitFor(alice, () => true, null, 1000);
        await alice.waitForTimeout(15000);
        const bundles = uploads.filter(upload => Array.isArray(upload.recipientIds));
        assert.equal(bundles.length, 1, 'one upload for the group message');
        assert.deepEqual([...bundles[0].recipientIds].sort(), [bobId, carolId].sort());
        assert.equal(JSON.parse(bundles[0].ciphertextPayload).kind, 'group');
        assert.ok(!bundles[0].ciphertextPayload.includes('alle offline'), 'encrypted');

        bob = await user('Bob', false);
        carol = await user('Carol', false);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'alle offline'), groupId, 60000);
        await waitFor(carol, id => (state.chats[id] || []).some(message => message.text === 'alle offline'), groupId, 60000);
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (group bundle)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
