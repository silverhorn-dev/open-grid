// End-to-End: Antwort aus der Benachrichtigung der Android-App (native.js handleNotificationReply). Die App ist hier
// nachgebaut: das Ereignis kommt wie von der Bruecke, `nativeCall` faengt das Ergebnis ab. Bob antwortet Alice, ohne
// den Chat offen zu haben; die Nachricht kommt bei Alice an und steht bei Bob im Verlauf.
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
        // Alice schreibt Bob, Bob hat den Chat danach nicht offen.
        await alice.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'kommst du?'; await sendChatMessage(); }, bobId);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'kommst du?'), aliceId);
        await bob.evaluate(() => { state.activeChatPeerId = null; switchTab('grid'); });

        const result = await bob.evaluate(async id => {
            const calls = [];
            window.nativeCall = async (type, data) => { calls.push({ type, ...data }); return null; };
            const ok = await handleNotificationReply({ replyId: 'reply-1', peerId: id, text: 'bin in 5 min da' });
            return { ok, calls, input: document.getElementById('chat-input').value };
        }, aliceId);
        assert.equal(result.ok, true);
        assert.deepEqual(result.calls, [{ type: 'replyResult', replyId: 'reply-1', ok: true }]);
        assert.equal(result.input, '', 'the chat input is not touched');
        await waitFor(alice, id => (state.chats[id] || []).some(message => message.text === 'bin in 5 min da'), bobId);
        assert.ok(await bob.evaluate(id => (state.chats[id] || []).some(message => message.text === 'bin in 5 min da' && message.senderId === state.myProfile.id), aliceId));

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (notification reply)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
