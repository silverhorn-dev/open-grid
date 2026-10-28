// End-to-End: App im Hintergrund = "abwesend". Bob meldet abwesend, Alice sieht es im Chat-Kopf; eine
// direkt (P2P) zugestellte Nachricht stoesst dann einen Push ohne Inhalt an (/api/push/nudge), sonst
// bekaeme Bob keine Benachrichtigung.
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

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await alice.fill('#chat-input', 'hallo');
        await alice.click('#send-chat-btn');
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'hallo'), aliceId);
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await waitFor(alice, id => state.peerPresence[id] === true && state.dataChannels[id]?.readyState === 'open', bobId);

        const nudges = [];
        alice.on('request', request => { if (request.url().includes('/api/push/nudge')) nudges.push(request.postDataJSON()); });
        await bob.evaluate(() => { leaveActiveChat(); reportAway(true); });
        await waitFor(alice, id => isPeerAway(id), bobId);
        await waitFor(alice, () => document.getElementById('chat-peer-status').textContent.toLowerCase().includes('abwesend'));

        await alice.fill('#chat-input', 'bist du da?');
        await alice.click('#send-chat-btn');
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'bist du da?'), aliceId);
        const startedAt = Date.now();
        while (!nudges.length && Date.now() - startedAt < 10000) await alice.waitForTimeout(200);
        assert.deepEqual(nudges[0], { senderId: aliceId, recipientId: bobId }, 'direct delivery to an away peer nudges a push');

        // Zurueck: wieder online, kein Anstupsen mehr noetig.
        await bob.evaluate(() => reportAway(false));
        await waitFor(alice, id => !isPeerAway(id), bobId);
        await waitFor(alice, () => document.getElementById('chat-peer-status').textContent.toLowerCase().includes('online'));

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (presence away)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
