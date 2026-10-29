// End-to-End: lange Chats in Seiten. Durchgehend nur die letzten 150 Nachrichten, oben angekommen
// kommen aeltere dazu; als Option "Chat nach Tagen" mit Tagesleiste (Pfeile) unter der Kontaktleiste.
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
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Leser');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        await page.evaluate(async () => {
            const id = 'node_long_chat';
            state.chatPeerIds.push(id);
            window.loadChatHistory = async () => {};
            await openChatWithPeer(id);
            const now = Date.now();
            // 400 Nachrichten ueber drei Tage: vorgestern, gestern, heute.
            state.chats[id] = Array.from({ length: 400 }, (_, index) => ({
                id: `long-${index}`, senderId: index % 2 ? id : state.myProfile.id, text: `Nachricht ${index}`,
                createdAt: now - (index < 100 ? 2 : index < 200 ? 1 : 0) * 86400000 - (400 - index) * 1000, timestamp: '10:00'
            }));
            state.chatPinned = true;
            renderChatHistory();
        });
        const rendered = () => page.evaluate(() => document.querySelectorAll('#chat-messages [id^="chat-message-long-"]').length);
        assert.equal(await rendered(), 150, 'only the latest page');
        assert.match(await page.textContent('.chat-load-older'), /250/);
        await page.evaluate(() => { const container = document.getElementById('chat-messages'); container.scrollTop = 0; container.dispatchEvent(new Event('scroll')); });
        await waitFor(page, () => document.querySelectorAll('#chat-messages [id^="chat-message-long-"]').length === 300);
        const top = await page.evaluate(() => document.getElementById('chat-messages').scrollTop);
        assert.ok(top > 100, 'position kept, no jump to the very top');

        // Antwort auf eine noch nicht gezeichnete Nachricht: Tippen auf das Zitat holt sie.
        await page.evaluate(() => { state.chatRenderLimit = 150; renderChatHistory(); scrollToChatMessage('long-5'); });
        await waitFor(page, () => Boolean(document.getElementById('chat-message-long-5')));

        // Chat nach Tagen.
        await page.evaluate(() => updateChatViewSetting(true));
        await waitFor(page, () => !document.getElementById('chat-day-bar').classList.contains('hidden'));
        assert.equal(await page.textContent('#chat-day-label'), 'Heute');
        assert.equal(await rendered(), 200, 'all of today');
        assert.equal(await page.isDisabled('#chat-day-next'), true);
        await page.click('#chat-day-prev');
        assert.equal(await page.textContent('#chat-day-label'), 'Gestern');
        assert.equal(await rendered(), 100);
        await page.click('#chat-day-prev');
        assert.equal(await page.isDisabled('#chat-day-prev'), true, 'oldest day');
        // Senden springt zu heute.
        await page.fill('#chat-input', 'neu heute');
        await page.click('#send-chat-btn');
        await waitFor(page, () => document.getElementById('chat-day-label').textContent === 'Heute');

        await page.evaluate(() => updateChatViewSetting(false));
        await waitFor(page, () => document.getElementById('chat-day-bar').classList.contains('hidden'));

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (chat pages)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
