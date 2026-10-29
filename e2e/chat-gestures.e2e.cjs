// End-to-End (Smartphone, echte Touch-Ereignisse per CDP): Wischen zum Antworten klappt mehrmals
// hintereinander, auch mit Start auf dem Aktionen-Pfeil (der dabei nicht aufklappt) und im Leerraum
// neben der Nachricht. Die Kontaktleiste nach unten ziehen oeffnet das Profil des Kontakts.
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
        const page = await (await browser.newContext({ locale: 'de-DE', ...devices['Pixel 7'] })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Bob');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        await page.evaluate(async () => {
            await setAppMode('chat');
            const id = 'node_fake_gestures';
            state.chatScopes[id] = 'social';
            state.cachedProfiles[id] = { fields: { displayName: 'Alice' } };
            state.chatPeerIds.push(id);
            switchTab('chat');
            await openChatWithPeer(id);
            state.chats[id] = [1, 2, 3].map(n => ({
                id: `m${n}`, senderId: n === 2 ? state.myProfile.id : id, text: `Nachricht ${n}`,
                createdAt: Date.now() - (5 - n) * 1000, timestamp: '12:00'
            }));
            renderChatHistory();
        });
        await page.waitForTimeout(300);

        const cdp = await page.context().newCDPSession(page);
        async function drag(from, dx, dy) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
            let peak = '';
            for (let step = 1; step <= 8; step++) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + dx * step / 8, y: from.y + dy * step / 8 }] });
                await page.waitForTimeout(16);
            }
            peak = await page.evaluate(() => [...document.querySelectorAll('.chat-bubble-wrap')].map(wrap => wrap.style.transform).find(value => value && value.includes('px')) || '');
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await page.waitForTimeout(300);
            return peak;
        }
        const point = async (selector, where) => {
            const box = await page.locator(selector).boundingBox();
            if (where === 'chevron') return { x: box.x + 14, y: box.y + 14 };
            if (where === 'right') return { x: box.x + box.width - 40, y: box.y + box.height / 2 };
            if (where === 'left') return { x: box.x + 20, y: box.y + box.height / 2 };
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        };
        const replyAfter = async (from, dx) => {
            const peak = await drag(from, dx, 0);
            const reply = await page.evaluate(() => state.replyToMessageId);
            await page.evaluate(() => cancelReply());
            return { peak, reply };
        };

        for (let attempt = 1; attempt <= 3; attempt++) {
            const result = await replyAfter(await point('#chat-message-m1 .chat-bubble', 'center'), 90);
            assert.equal(result.reply, 'm1', `swipe ${attempt} replies`);
            assert.match(result.peak, /translate3d\(72px/, `swipe ${attempt} animates`);
        }
        const chevron = await replyAfter(await point('#chat-message-m3 .chat-bubble', 'chevron'), 90);
        assert.equal(chevron.reply, 'm3', 'swipe starting on the actions arrow');
        assert.equal(await page.evaluate(() => state.messageMenu), null, 'the arrow did not open the menu');
        assert.equal((await replyAfter(await point('#chat-message-m3', 'right'), 90)).reply, 'm3', 'swipe on the empty space next to an incoming message');
        assert.equal((await replyAfter(await point('#chat-message-m2', 'left'), -90)).reply, 'm2', 'swipe on the empty space next to an own message');

        // Kontaktleiste: kurz ziehen tut nichts, weit nach unten oeffnet das Profil.
        const header = await point('#chat-header', 'center');
        await drag(header, 0, 30);
        assert.equal(await page.isVisible('#profile-detail-modal'), false);
        // Waehrend des Ziehens liegt die Leiste ueber den Nachrichten (nichts schiebt sich davor).
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [header] });
        for (let step = 1; step <= 8; step++) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: header.x, y: header.y + 15 * step }] });
            await page.waitForTimeout(16);
        }
        const onTop = await page.evaluate(() => {
            const box = document.getElementById('chat-header').getBoundingClientRect();
            const hit = document.elementFromPoint(box.left + box.width / 2, box.bottom - 4);
            return { onTop: Boolean(hit?.closest('#chat-header')), background: getComputedStyle(document.getElementById('chat-header')).backgroundColor };
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await page.waitForTimeout(300);
        assert.equal(onTop.onTop, true, 'pulled bar stays above the messages');
        assert.doesNotMatch(onTop.background, /rgba\(.*, 0\.5\)/, 'opaque while pulling');
        if (await page.isVisible('#profile-detail-modal')) await page.evaluate(() => closeProfileModal?.());
        await drag(header, 0, 120);
        await waitFor(page, () => !document.getElementById('profile-detail-modal').classList.contains('hidden'));
        assert.equal(await page.evaluate(() => state.activeModalPeerId), 'node_fake_gestures');

        // Profil im Chat: nach unten wischen schliesst es (erst die Eingabeleisten-Geste, Profil danach).
        await page.evaluate(() => closeProfileModal());
        await page.waitForTimeout(400);
        // Eingabeleiste nach rechts wischen = Chat schliessen (Standard an).
        const bar = await page.locator('#chat-input-bar').boundingBox();
        await drag({ x: bar.x + 40, y: bar.y + 12 }, 220, 0);
        await waitFor(page, () => !state.activeChatPeerId, null, 3000);
        await page.evaluate(() => openChatWithPeer('node_fake_gestures'));
        await page.waitForTimeout(400);

        // Verlauf: im unsichtbaren Band in der Mitte nach rechts wischen schliesst den Chat, auch ueber einer
        // Nachricht; daneben wird die Nachricht auf der Hoehe gewischt (Antworten).
        // Nach dem Oeffnen laedt der Chat aus der Datenbank; die Testnachrichten liegen nur im Speicher.
        const restore = async () => {
            await page.evaluate(async () => {
                const id = 'node_fake_gestures';
                await openChatWithPeer(id);
                state.chats[id] = [1, 2, 3].map(n => ({
                    id: `m${n}`, senderId: n === 2 ? state.myProfile.id : id, text: `Nachricht ${n}`,
                    createdAt: Date.now() - (5 - n) * 1000, timestamp: '12:00'
                }));
                renderChatHistory();
            });
            await page.waitForTimeout(400);
        };
        await restore();
        const history = await page.locator('#chat-messages').boundingBox();
        const rowOf = async id => page.locator(`#chat-message-${id}`).boundingBox();
        const m1 = await rowOf('m1');
        await drag({ x: history.x + history.width / 2, y: m1.y + m1.height / 2 }, 160, 0);
        await waitFor(page, () => !state.activeChatPeerId, null, 3000);
        assert.equal(await page.evaluate(() => state.replyToMessageId), null, 'band: no reply');
        await restore();
        const m1Again = await rowOf('m1');
        const sideReply = await replyAfter({ x: history.x + history.width / 2 + 60, y: m1Again.y + m1Again.height / 2 }, 90);
        assert.equal(sideReply.reply, 'm1', 'right of the band, the message at that height is swiped');
        assert.equal(await page.evaluate(() => Boolean(state.activeChatPeerId)), true, 'chat stays open');
        // Eigene Nachricht nach rechts: Hintergrund-Geste schliesst.
        const m2 = await rowOf('m2');
        await drag({ x: m2.x + m2.width - 60, y: m2.y + m2.height / 2 }, 160, 0);
        await waitFor(page, () => !state.activeChatPeerId, null, 3000);
        await restore();
        // Geloeschte Nachricht: kein Antworten, das Wischen schliesst den Chat.
        await page.evaluate(() => {
            const message = state.chats.node_fake_gestures.find(item => item.id === 'm3');
            Object.assign(message, { deleted: true, text: '' });
            renderChatHistory();
        });
        await page.waitForTimeout(200);
        const m3 = await rowOf('m3');
        await drag({ x: m3.x + 30, y: m3.y + m3.height / 2 }, 160, 0);
        assert.equal(await page.evaluate(() => state.replyToMessageId), null, 'deleted messages cannot be answered');
        await waitFor(page, () => !state.activeChatPeerId, null, 3000);
        await page.evaluate(() => { startReply('m3'); });
        assert.equal(await page.evaluate(() => state.replyToMessageId), null, 'startReply refuses deleted messages');
        await restore();

        await page.evaluate(() => openProfileModal('node_fake_gestures'));
        await page.waitForTimeout(400);
        const profileTop = await page.locator('#profile-detail-modal > div').boundingBox();
        await drag({ x: profileTop.x + profileTop.width / 2, y: Math.max(profileTop.y + 80, 120) }, 0, 260);
        await waitFor(page, () => document.getElementById('profile-detail-modal').classList.contains('hidden'), null, 3000);

        // Album-Ansicht: 120 px ziehen schliesst nicht mehr (1x-Alben), erst ein langer Zug.
        await page.evaluate(() => { openMediaModal('Album'); state.albumViewer = { albumId: 'alb_x', ownerId: 'node_fake_gestures', viewId: 'v' }; renderMediaModalMessage('Bilder', 'fa-images'); });
        const sheet = await page.locator('#media-modal-content').boundingBox();
        const sheetPoint = { x: sheet.x + sheet.width / 2, y: sheet.y + 20 };
        await drag(sheetPoint, 0, 120);
        assert.equal(await page.isVisible('#media-modal'), true, 'a short pull keeps the album open');
        const viewport = page.viewportSize();
        await drag(sheetPoint, 0, Math.max(240, viewport.height * 0.45));
        await waitFor(page, () => document.getElementById('media-modal').classList.contains('hidden'), null, 3000);

        // Profil seitlich wischen = naechstes Profil der Liste (mit Animation); am Ende federt es zurueck.
        await page.evaluate(() => {
            closeMediaModal?.();
            state.cachedProfiles.node_browse_a = { id: 'node_browse_a', fields: { displayName: 'Anna' } };
            state.cachedProfiles.node_browse_b = { id: 'node_browse_b', fields: { displayName: 'Ben' } };
            setProfileBrowseList(['node_browse_a', 'node_browse_b']);
            openProfileModal('node_browse_a');
        });
        await page.waitForTimeout(400);
        const profileCard = await page.locator('#profile-detail-modal > div').boundingBox();
        const middle = { x: profileCard.x + profileCard.width * 0.75, y: Math.max(profileCard.y + 300, 320) };
        await drag(middle, -220, 0);
        await waitFor(page, () => state.activeModalPeerId === 'node_browse_b', null, 3000);
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => document.querySelector('#profile-detail-modal > div').style.transform), '', 'new card settled');
        await drag(middle, -220, 0);
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => state.activeModalPeerId), 'node_browse_b', 'last profile stays');
        assert.equal(await page.evaluate(() => document.querySelector('#profile-detail-modal > div').style.transform), '', 'springs back');
        await drag({ x: profileCard.x + profileCard.width * 0.25, y: middle.y }, 220, 0);
        await waitFor(page, () => state.activeModalPeerId === 'node_browse_a', null, 3000);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (chat gestures, mobile)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
