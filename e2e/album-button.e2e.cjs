// End-to-End: in "Chat & Freunde"-Chats ist der Album-Knopf versteckt; ein langer Druck auf "Snap"
// zeigt ihn (Easteregg), ohne die Kamera zu oeffnen. In "Grid & Event"-Chats ist er immer da.
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
        const page = await (await browser.newContext({ locale: 'de-DE', viewport: { width: 1200, height: 800 } })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Easter');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        await page.evaluate(async () => {
            window.loadChatHistory = async () => {};
            state.chatScopes.node_social = 'social';
            state.chatScopes.node_grid = 'discovery';
            state.chatPeerIds.push('node_social', 'node_grid');
            await setAppMode('chat');
            await openChatWithPeer('node_social');
        });
        assert.equal(await page.isVisible('#chat-album-btn'), false, 'hidden in social chats');

        // Langer Druck auf Snap: Album-Knopf erscheint, Kamera bleibt zu.
        const snap = await page.locator('#chat-snap-btn').boundingBox();
        await page.mouse.move(snap.x + snap.width / 2, snap.y + snap.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(800);
        await page.mouse.up();
        await page.waitForTimeout(300);
        assert.equal(await page.isVisible('#chat-album-btn'), true, 'revealed by long press');
        assert.equal(await page.evaluate(() => document.getElementById('snap-capture-modal').classList.contains('hidden')), true, 'camera stays closed');

        // Ein kurzer Klick oeffnet weiterhin die Kamera.
        await page.click('#chat-snap-btn');
        await waitFor(page, () => !document.getElementById('snap-capture-modal').classList.contains('hidden'), null, 5000);
        await page.evaluate(() => closeSnapModal());

        // Anderer Chat: wieder versteckt; Grid-Chat: Album im Medien-Knopf (zusammen mit Video).
        await page.evaluate(() => openChatWithPeer('node_grid'));
        assert.equal(await page.isVisible('#chat-media-btn'), true, 'media button in discovery chats');
        assert.equal(await page.isVisible('#chat-album-btn'), false, 'no separate album button there');
        assert.equal(await page.locator('#chat-media-menu [data-click="composeMediaAlbum"]').count(), 1, 'album in the media menu');
        await page.evaluate(() => openChatWithPeer('node_social'));
        assert.equal(await page.isVisible('#chat-album-btn'), false, 'easter egg only for the chat where it was triggered');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (album button)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
