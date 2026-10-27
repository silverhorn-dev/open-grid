// End-to-End: wer Bilder speichern darf, bestimmt der Absender. Alice und Bob sind keine Freunde:
// mit "Nur Freunde" (Standard) bekommt Bob keinen Speichern-Knopf, mit "Alle Chat-Partner" schon.
// Alice selbst darf ihre eigenen Bilder immer speichern.
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
    const sendImage = (page, color) => page.evaluate(async fill => {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 120;
        const context = canvas.getContext('2d');
        context.fillStyle = fill;
        context.fillRect(0, 0, 160, 120);
        await sendChatMessage(canvas.toDataURL('image/jpeg', 0.9), '', null, null, { asImage: true });
    }, color);
    const saveVisibleFor = (page, peerId, index) => page.evaluate(async ({ id, position }) => {
        await openChatWithPeer(id);
        const images = (state.chats[id] || []).filter(message => message.snapData && !message.snapMode);
        await openChatImageViewer(images[position].id);
        await new Promise(resolve => setTimeout(resolve, 300));
        const visible = !document.getElementById('image-viewer-save').classList.contains('hidden');
        closeImageViewer();
        return visible;
    }, { id: peerId, position: index });

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        assert.equal(await alice.evaluate(() => state.mediaDownload), 'friends', 'friends only by default');

        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await sendImage(alice, '#ff0000');
        await waitFor(bob, id => (state.chats[id] || []).filter(message => message.snapData).length === 1, aliceId);
        assert.equal(await bob.evaluate(id => state.chats[id].find(message => message.snapData).downloadable, aliceId), 'friends');

        await alice.evaluate(() => updateMediaDownloadSetting('all'));
        await sendImage(alice, '#00ff00');
        await waitFor(bob, id => (state.chats[id] || []).filter(message => message.snapData).length === 2, aliceId);

        assert.equal(await saveVisibleFor(bob, aliceId, 0), false, 'not friends: no save button');
        assert.equal(await saveVisibleFor(bob, aliceId, 1), true, 'sender allows everyone');
        assert.equal(await saveVisibleFor(alice, bobId, 0), true, 'own images can always be saved');

        // Neuzeichnen des Chats nimmt die schon gezeichneten Bilder mit (kein Flackern).
        const reused = await bob.evaluate(async id => {
            await openChatWithPeer(id);
            await new Promise(resolve => setTimeout(resolve, 400));
            const before = [...document.querySelectorAll('#chat-messages canvas[data-reuse-key]')];
            renderChatHistory();
            const after = [...document.querySelectorAll('#chat-messages canvas[data-reuse-key]')];
            return { count: before.length, same: before.every((canvas, index) => canvas === after[index]), drawn: after.every(canvas => canvas.width > 0) };
        }, aliceId);
        assert.equal(reused.count, 2);
        assert.equal(reused.same, true, 'same canvas elements after a re-render');
        assert.equal(reused.drawn, true, 'still drawn, never blank');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (media rights)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
