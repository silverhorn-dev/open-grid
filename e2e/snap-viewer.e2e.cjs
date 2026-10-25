// End-to-End (Smartphone): im Snap nach unten wischen schliesst den Snap, statt die Seite neu zu laden
// (der Viewer faengt Touch-Gesten selbst ab).
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
        await input.fill('Snapper');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 300;
            canvas.height = 400;
            canvas.getContext('2d').fillRect(0, 0, 300, 400);
            const snap = { id: 'snap1', peerId: 'node_snap', senderId: 'node_snap', text: '', snapData: canvas.toDataURL('image/jpeg'), snapMode: 'replay', timestamp: '10:00', createdAt: 1 };
            await persistChatMessage('node_snap', snap);
            state.chatPeerIds.push('node_snap');
            await openChatWithPeer('node_snap');
            window.__noReload = true;
            openReplaySnap('snap1');
        });
        await waitFor(page, () => !document.getElementById('secure-snap-viewer').classList.contains('hidden'));
        assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('secure-snap-viewer')).touchAction), 'none', 'browser gestures are blocked in the viewer');

        // Nach unten wischen.
        const x = 190;
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: 200 }] });
        for (let step = 1; step <= 8; step++) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 200 + step * 30 }] });
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await waitFor(page, () => document.getElementById('secure-snap-viewer').classList.contains('hidden'), null, 5000);
        assert.equal(await page.evaluate(() => window.__noReload), true, 'page was not reloaded');
        assert.equal(await page.evaluate(() => state.chats.node_snap[0].snapViews), 1, 'the view was counted');

        // Zweite Ansicht zaehlt schon beim Oeffnen: neu laden waehrend des Ansehens gibt keine dritte.
        await page.evaluate(() => openReplaySnap('snap1'));
        await waitFor(page, () => !document.getElementById('secure-snap-viewer').classList.contains('hidden'));
        assert.equal(await page.evaluate(() => state.chats.node_snap[0].snapViews), 2, 'counted when opened');
        await page.waitForTimeout(500);
        assert.equal(await page.evaluate(async () => (await getAllDatabaseRecords('messages')).find(message => message.id === 'snap1')?.snapViews), 2, 'stored right away');
        await page.reload();
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        await page.evaluate(() => openChatWithPeer('node_snap'));
        await waitFor(page, () => state.chats.node_snap?.[0] && !state.chats.node_snap[0].snapData, null, 10000);

        assert.deepEqual(pageErrors, [], 'no uncaught page errors');
        console.log('E2E OK (snap viewer, mobile)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
