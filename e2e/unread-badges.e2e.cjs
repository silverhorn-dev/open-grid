// End-to-End: Ungelesen-Badges. Bob hat die Chatliste offen, Alice schreibt zweimal: Zahl am Chat in
// der Liste, Summe am Chat-Tab und im Tab-Titel. Oeffnet Bob den Chat, verschwindet alles, auch nach
// dem Neuladen. Neue Nachrichten in den offenen Chat zaehlen nicht.
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
        const page = await (await browser.newContext()).newPage();
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
    const send = async (page, text) => {
        await page.fill('#chat-input', text);
        await page.click('#send-chat-btn');
    };
    const tabBadge = page => page.evaluate(() => {
        const badge = document.querySelector('[data-tab-btn="chat"] [data-unread-total]');
        return badge.classList.contains('hidden') ? '' : badge.textContent;
    });

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));

        await bob.evaluate(() => switchTab('chat'));
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await send(alice, 'eins');
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'eins')
            || unreadCountOf(id) === 1, aliceId);
        await send(alice, 'zwei');
        await waitFor(bob, id => unreadCountOf(id) === 2, aliceId);

        assert.equal(await bob.textContent('#active-peers-list .unread-badge'), '2', 'badge on the chat in the list');
        assert.equal(await tabBadge(bob), '2', 'total on the chat tab');
        assert.match(await bob.title(), /^\(2\) /, 'total in the tab title');

        // Chat oeffnen: gelesen.
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await waitFor(bob, id => unreadCountOf(id) === 0, aliceId);
        assert.equal(await tabBadge(bob), '');
        assert.doesNotMatch(await bob.title(), /^\(/);

        // Nachricht in den offenen Chat zaehlt nicht.
        await send(alice, 'drei');
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'drei'), aliceId);
        await bob.waitForTimeout(500);
        assert.equal(await bob.evaluate(id => unreadCountOf(id), aliceId), 0);

        // Nach dem Neuladen bleibt es gelesen.
        await bob.goto(`${BASE_URL}/chat`);
        await waitFor(bob, () => Boolean(state.ws && state.ws.readyState === 1));
        await waitFor(bob, id => state.chatPeerIds.includes(id), aliceId);
        assert.equal(await bob.evaluate(id => unreadCountOf(id), aliceId), 0, 'still read after reload');
        assert.equal(await bob.locator('#active-peers-list .unread-badge').count(), 0);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (unread badges)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
