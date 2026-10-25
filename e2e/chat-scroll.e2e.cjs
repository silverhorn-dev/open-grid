// End-to-End: Scrollposition im Chat. Beim Betreten und Senden unten (auch wenn Bilder spaeter ihre
// Groesse bekommen); wer weit oben liest, behaelt die Position und bekommt "nach unten".
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

async function main() {
    if (process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext(process.env.MOBILE ? { ...devices['iPhone 13'] } : { viewport: { width: 1200, height: 800 } })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Scroller');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));

        // 60 Nachrichten, jede zehnte mit Bild (wird erst nach dem Zeichnen hoch).
        await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 600;
            canvas.height = 800;
            canvas.getContext('2d').fillRect(0, 0, 600, 800);
            const image = canvas.toDataURL('image/jpeg', 0.6);
            const peerId = 'node_scroll';
            state.chatPeerIds.push(peerId);
            state.chats[peerId] = Array.from({ length: 60 }, (_, index) => ({
                id: `m${index}`, senderId: index % 2 ? peerId : state.myProfile.id, text: `Nachricht ${index}`,
                snapData: index % 10 === 5 ? image : undefined, imageSize: index % 10 === 5 ? { w: 600, h: 800 } : undefined,
                snapSaved: true, timestamp: '10:00', createdAt: index
            }));
            window.loadChatHistory = async () => {};
        });
        const atBottom = () => {
            const container = document.getElementById('chat-messages');
            return container.scrollHeight - container.scrollTop - container.clientHeight <= 4;
        };

        // Mit bekannter Bildgroesse ist der Platz schon vor dem Zeichnen reserviert: nichts springt.
        const heights = await page.evaluate(async () => {
            await openChatWithPeer('node_scroll');
            const container = document.getElementById('chat-messages');
            const before = container.scrollHeight;
            await new Promise(resolve => setTimeout(resolve, 800));
            return { before, after: container.scrollHeight };
        });
        assert.equal(heights.after, heights.before, `no layout jump when images are drawn (${heights.before} -> ${heights.after})`);

        // Betreten: unten, auch nachdem die Bilder gezeichnet sind.
        await page.evaluate(() => openChatWithPeer('node_scroll'));
        await page.waitForTimeout(1200);
        assert.equal(await page.evaluate(atBottom), true, 'at the bottom after opening');
        assert.equal(await page.isVisible('#chat-jump-bottom'), false);

        // Senden unten: bleibt unten.
        await page.fill('#chat-input', 'neu unten');
        await page.focus('#chat-input');
        if (process.env.MOBILE) await page.tap('#send-chat-btn');
        else await page.click('#send-chat-btn');
        await page.waitForTimeout(600);
        assert.equal(await page.evaluate(atBottom), true, 'stays at the bottom after sending');
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'chat-input', 'input keeps the focus after sending');

        // Weit nach oben scrollen, dann kommt eine Nachricht rein und man sendet: Position bleibt.
        await page.evaluate(() => { document.getElementById('chat-messages').scrollTop = 200; });
        await page.waitForTimeout(300);
        assert.equal(await page.isVisible('#chat-jump-bottom'), true, 'jump button appears when far up');
        await page.evaluate(() => {
            state.chats.node_scroll.push({ id: 'in1', senderId: 'node_scroll', text: 'neu eingegangen', timestamp: '10:01', createdAt: 999 });
            renderChatHistory();
        });
        await page.fill('#chat-input', 'gesendet von oben');
        await page.click('#send-chat-btn');
        await page.waitForTimeout(600);
        const kept = await page.evaluate(() => document.getElementById('chat-messages').scrollTop);
        assert.ok(Math.abs(kept - 200) < 40, `position kept (${kept})`);

        // Knopf fuehrt nach unten.
        await page.click('#chat-jump-bottom');
        await waitFor(page, atBottom, null, 5000);
        await waitFor(page, () => document.getElementById('chat-jump-bottom').classList.contains('hidden'), null, 5000);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log(`E2E OK (chat scroll${process.env.MOBILE ? ', mobile' : ''})`);
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
