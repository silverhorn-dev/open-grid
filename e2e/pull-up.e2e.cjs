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
        const context = await browser.newContext({ ...devices['iPhone 13'] });
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

        // Naechster Chat.
        await page.evaluate(() => updatePullUpSetting('next'));
        await pullUp(page, session);
        await waitFor(page, () => state.activeChatPeerId === 'node_two', null, 5000);

        // Seite neu laden, ohne Toast.
        await page.evaluate(() => updatePullUpSetting('reload'));
        await page.evaluate(() => { window.__beforeReload = true; });
        await Promise.all([page.waitForNavigation({ timeout: 10000 }), pullUp(page, session)]);
        assert.equal(await page.evaluate(() => window.__beforeReload), undefined, 'tab was reloaded');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        assert.equal(await page.evaluate(() => state.pullUpAction), 'reload', 'setting survives the reload');
        assert.equal(await page.locator('text=Chat wird aktualisiert').count(), 0, 'no toast');

        assert.deepEqual(pageErrors, [], 'no uncaught page errors');
        console.log('E2E OK (pull up, mobile)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
