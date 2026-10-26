// End-to-End: im offenen Chat zwischen Chats derselben Liste wechseln (Leiste, Pfeile, Wischen auf
// der Kontaktleiste) und die Funktion abschalten. Ein Wechsel legt keinen History-Eintrag an.
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
        await input.fill('Switcher');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));

        // Drei Chats in "Grid & Event", einer in "Chat & Freunde" (darf nicht auftauchen).
        await page.evaluate(async () => {
            await setAppMode('discovery');
            const now = Date.now();
            ['node_a', 'node_b', 'node_c'].forEach((id, index) => {
                state.chatScopes[id] = 'discovery';
                state.chatPeerIds.push(id);
                state.chatPreviews[id] = { text: id, at: now - index * 1000, mine: false };
            });
            state.chatScopes.node_social = 'social';
            state.chatPeerIds.push('node_social');
            state.chatPreviews.node_social = { text: 'social', at: now + 5000, mine: false };
            switchTab('chat');
            await openChatWithPeer('node_a');
        });
        const historyLength = await page.evaluate(() => history.length);

        // Leiste (Standard).
        await waitFor(page, () => document.querySelectorAll('#chat-switch-bar button').length === 3);
        await page.click('#chat-switch-bar button >> nth=1');
        await waitFor(page, () => state.activeChatPeerId === 'node_b');
        assert.equal(await page.evaluate(() => history.length), historyLength, 'no new history entry');
        assert.match(await page.evaluate(() => location.pathname), /node_b/);

        // Pfeile.
        await page.evaluate(() => updateChatSwitchSetting('style', 'arrows'));
        assert.equal(await page.isVisible('#chat-switch-bar'), false);
        await page.click('[aria-label="Naechster Chat"]');
        await waitFor(page, () => state.activeChatPeerId === 'node_c');
        assert.equal(await page.isDisabled('[aria-label="Naechster Chat"]'), true, 'end of the list');
        await page.click('[aria-label="Vorheriger Chat"]');
        await waitFor(page, () => state.activeChatPeerId === 'node_b');

        // Wischen auf der Kontaktleiste.
        await page.evaluate(() => updateChatSwitchSetting('style', 'swipe'));
        const header = await page.locator('#chat-peer-name').boundingBox();
        await page.mouse.move(header.x + 200, header.y + 5);
        await page.mouse.down();
        await page.mouse.move(header.x + 40, header.y + 8, { steps: 6 });
        await page.mouse.up();
        await waitFor(page, () => state.activeChatPeerId === 'node_c');

        // Abgeschaltet: weder Leiste noch Pfeile, Wischen tut nichts.
        await page.evaluate(() => updateChatSwitchSetting('enabled', false));
        await page.evaluate(() => updateChatSwitchSetting('style', 'bar'));
        assert.equal(await page.isVisible('#chat-switch-bar'), false);
        assert.equal(await page.isVisible('[aria-label="Naechster Chat"]'), false);
        await page.evaluate(() => switchChat(-1));
        assert.equal(await page.evaluate(() => state.activeChatPeerId), 'node_c');
        assert.equal(await page.evaluate(() => visibleChatPeerIds().includes('node_social')), false, 'other list stays separate');

        // Einstellung bleibt nach dem Neuladen.
        await page.reload();
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        assert.equal(await page.evaluate(() => state.chatSwitchSettings.enabled), false);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (chat switch)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
