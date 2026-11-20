// End-to-End: Sticker (stickers.js, Board T39). Alice hat einen eigenen Sticker (transparentes Bild), schickt ihn an
// Bob: ohne Sprechblase, auf Canvas (nicht speicherbar), Bob favorisiert ihn und hat ihn danach in der Auswahl.
// 18+: ausserhalb von Dating-Chats nicht sendbar; bei Empfaengern unter 18 ausgeblendet, sonst unscharf bis Antippen.
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
    const makeSticker = (page, adult = false) => page.evaluate(async isAdult => {
        const canvas = document.createElement('canvas');
        canvas.width = 300;
        canvas.height = 300;
        const context = canvas.getContext('2d');
        context.fillStyle = isAdult ? '#e11d48' : '#22c55e';
        context.beginPath();
        context.arc(150, 150, 120, 0, Math.PI * 2);
        context.fill();
        const sticker = await encodeSticker(canvas, { adult: isAdult });
        await addOwnSticker(sticker);
        return sticker;
    }, adult);
    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        await bob.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'hi'; await sendChatMessage(); }, aliceId);
        await waitFor(alice, id => (state.chats[id] || []).length > 0, bobId);

        const sticker = await makeSticker(alice);
        assert.ok(sticker.data.length <= 60000 && sticker.w <= 512);
        assert.match(sticker.data, /^data:image\/(webp|png);base64,/, 'keeps transparency');
        // Ueber die Auswahl senden (Medien -> Sticker -> Eigene).
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await alice.evaluate(() => openStickerPicker());
        await alice.click('[data-sticker-tab="own"]');
        await alice.waitForSelector(`[data-sticker-id="${sticker.id}"]`);
        await alice.click(`[data-sticker-id="${sticker.id}"]`);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.sticker?.sha256), aliceId);

        // Bob: ohne Sprechblase, Canvas statt Bild-Element.
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await bob.waitForSelector('.chat-bubble-sticker canvas.sticker-image');
        const look = await bob.evaluate(() => {
            const bubble = document.querySelector('.chat-bubble-sticker');
            const style = getComputedStyle(bubble);
            return { background: style.backgroundColor, padding: style.paddingLeft, img: bubble.querySelectorAll('img').length };
        });
        assert.deepEqual(look, { background: 'rgba(0, 0, 0, 0)', padding: '0px', img: 0 });
        assert.equal(await bob.evaluate(() => messagePreview(state.chats[state.activeChatPeerId].find(message => message.sticker))), 'Sticker');
        // Antippen: favorisieren, danach in Bobs Favoriten.
        await bob.click('.chat-bubble-sticker .sticker-frame');
        await bob.waitForSelector('#sticker-favorite-btn');
        await bob.click('#sticker-favorite-btn');
        await waitFor(bob, () => stickerState.favorites.length === 1);
        await bob.evaluate(() => closeMediaModal());
        await bob.evaluate(() => openStickerPicker());
        await bob.waitForSelector('[data-sticker-tab="favorites"][aria-selected="true"]');
        await bob.waitForSelector(`[data-sticker-id="${sticker.id}"]`);
        await bob.evaluate(() => closeMediaModal());

        // 18+: in diesem (Freunde-)Chat nicht sendbar.
        const adult = await makeSticker(alice, true);
        assert.equal(await alice.evaluate(s => sendSticker(s), adult), false);
        assert.equal(await alice.evaluate(id => (state.chats[id] || []).filter(message => message.sticker).length, bobId), 1);
        // Empfang eines 18+-Stickers: unscharf bis Antippen; unter 18 gar nicht.
        await bob.evaluate(s => {
            const peerId = state.activeChatPeerId;
            state.chats[peerId].push({ id: 'adult-1', senderId: peerId, sticker: { data: s.data, sha256: s.sha256, w: s.w, h: s.h, adult: true }, createdAt: Date.now(), timestamp: '10:00' });
            renderChatHistory();
        }, adult);
        await bob.waitForSelector('[data-sticker="adult-1"].is-adult-hidden');
        await bob.click('[data-sticker="adult-1"]');
        await waitFor(bob, () => !document.querySelector('[data-sticker="adult-1"]').classList.contains('is-adult-hidden'));
        await bob.evaluate(() => { state.ageGroup = 'minor'; renderChatHistory(); });
        assert.equal(await bob.evaluate(() => Boolean(document.querySelector('[data-sticker="adult-1"]'))), false);
        assert.match(await bob.textContent('.sticker-hidden'), /ab 18 ausgeblendet/);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (stickers)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
