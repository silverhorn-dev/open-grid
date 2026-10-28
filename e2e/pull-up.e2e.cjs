// End-to-End (Smartphone): im Chat am Ende hochziehen fuehrt die eingestellte Aktion aus.
// "Naechster Chat" wechselt, "Seite neu laden" laedt den Tab ohne Toast neu.
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function waitFor(page, predicate, arg, timeout = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await page.evaluate(predicate, arg).catch(() => false)) return;
        await page.waitForTimeout(200);
    }
    throw new Error(`Timed out waiting for ${predicate}`);
}

async function pullUp(page, session) {
    const box = await page.locator('#chat-messages').boundingBox();
    const x = box.x + box.width / 2;
    const start = box.y + box.height - 40;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
    for (let step = 1; step <= 10; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start - step * 25 }] });
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function main() {
    if (!process.env.MOBILE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const context = await browser.newContext({ locale: 'de-DE', ...devices['iPhone 13'] });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        const session = await context.newCDPSession(page);
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Puller');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        await page.evaluate(async () => {
            const now = Date.now();
            ['node_one', 'node_two'].forEach((id, index) => {
                state.chatPeerIds.push(id);
                state.chatPreviews[id] = { text: id, at: now - index, mine: false };
                state.chats[id] = [{ id: `${id}-m`, senderId: id, text: 'hi', timestamp: '10:00', createdAt: 1 }];
            });
            window.loadChatHistory = async () => {};
            await openChatWithPeer('node_one');
        });

        // Langer Verlauf: die Anzeige darf beim Ziehen nur wachsen, nie zwischendurch auf 0 fallen
        // (vorher: Anzeige waechst -> Verlauf nicht mehr ganz unten -> Anzeige 0 -> waechst ... = Flackern).
        await page.evaluate(() => {
            const id = state.activeChatPeerId;
            const now = Date.now();
            state.chats[id] = Array.from({ length: 60 }, (_, index) => ({ id: `${id}-long-${index}`, senderId: id, text: `Zeile ${index}`, timestamp: '10:00', createdAt: now - 1000 + index }));
            renderChatHistory();
            const container = document.getElementById('chat-messages');
            container.scrollTop = container.scrollHeight;
        });
        await page.waitForTimeout(200);
        {
            const box = await page.locator('#chat-messages').boundingBox();
            const x = box.x + box.width / 2;
            const start = box.y + box.height - 40;
            const heights = [];
            await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
            for (let step = 1; step <= 10; step++) {
                await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start - step * 12 }] });
                await page.waitForTimeout(16);
                heights.push(await page.evaluate(() => document.getElementById('chat-pull-refresh').getBoundingClientRect().height));
            }
            await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
            assert.ok(heights.every((height, index) => index === 0 || height >= heights[index - 1]), `indicator only grows: ${heights.join(',')}`);
            assert.ok(heights.at(-1) > 20, 'indicator visible');
        }
        await page.waitForTimeout(200);
        await page.evaluate(() => { state.chats[state.activeChatPeerId] = state.chats[state.activeChatPeerId].slice(-1); renderChatHistory(); });

        // Naechster Chat.
        await page.evaluate(() => updatePullUpSetting('next'));
        await pullUp(page, session);
        await waitFor(page, () => state.activeChatPeerId === 'node_two', null, 5000);

        // Quick-Switcher: Auswahl aller Chats, Tipp wechselt.
        await page.evaluate(() => updatePullUpSetting('switcher'));
        await pullUp(page, session);
        await waitFor(page, () => !document.getElementById('media-modal').classList.contains('hidden'), null, 5000);
        assert.equal(await page.locator('#media-modal-content button').count(), 2, 'all chats of the list');
        await page.click('#media-modal-content button >> nth=0');
        await waitFor(page, () => state.activeChatPeerId === 'node_one' && document.getElementById('media-modal').classList.contains('hidden'), null, 5000);

        // Seite neu laden, ohne Toast.
        await page.evaluate(() => updatePullUpSetting('reload'));
        await page.evaluate(() => { window.__beforeReload = true; });
        await Promise.all([page.waitForNavigation({ timeout: 10000, waitUntil: 'commit' }), pullUp(page, session)]);
        await page.waitForLoadState('load');
        assert.equal(await page.evaluate(() => window.__beforeReload), undefined, 'tab was reloaded');
        // Nach dem Neuladen im Chat: nie die Chatliste zeigen, der Chat ist schnell wieder offen.
        assert.equal(await page.evaluate(() => document.getElementById('view-chat').classList.contains('chat-open')), true, 'chat layout right away');
        const openedAfter = Date.now();
        await waitFor(page, () => state.activeChatPeerId === 'node_one', null, 4000);
        console.log(`chat open ${Date.now() - openedAfter} ms after load`);
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        assert.equal(await page.evaluate(() => state.pullUpAction), 'reload', 'setting survives the reload');
        assert.equal(await page.locator('text=Chat wird aktualisiert').count(), 0, 'no toast');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (pull up, mobile)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
