// End-to-End: Reiter-Leisten seitlich wischen wie die Einstellungen (gestures.js attachTabStripSwipe): Grid
// (Grid / Interaktionen / Matches, an den Enden weiter zum Haupt-Reiter), Sticker im Snap-Editor, GIF-Auswahl und
// Profil-Popup (Dating / Freunde).
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

// Seitliches Wischen mit echten Touch-Ereignissen auf dem Element (Tab-Wischer haengt an <main>).
async function swipe(page, selector, deltaX) {
    await page.evaluate(({ selector, deltaX }) => {
        const target = document.querySelector(selector);
        const box = target.getBoundingClientRect();
        const startX = box.left + box.width / 2 - deltaX / 2;
        const y = box.top + box.height / 2;
        const touchAt = x => new Touch({ identifier: 1, target, clientX: x, clientY: y });
        const fire = (type, x) => target.dispatchEvent(new TouchEvent(type, {
            bubbles: true, cancelable: true,
            touches: type === 'touchend' ? [] : [touchAt(x)],
            changedTouches: [touchAt(x)]
        }));
        fire('touchstart', startX);
        for (let step = 1; step <= 6; step += 1) fire('touchmove', startX + (deltaX * step) / 6);
        fire('touchend', startX + deltaX);
    }, { selector, deltaX });
    await page.waitForTimeout(400);
}

async function main() {
    if (!process.env.MOBILE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const context = await browser.newContext({ locale: 'de-DE', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Wischer');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));

        // 1) Grid: Grid -> Interaktionen -> Matches, dann zum naechsten Haupt-Reiter; zurueck ebenso.
        await page.evaluate(async () => {
            const mode = state.appConfig.modes.find(entry => !['chat', 'friends', 'event'].includes(entry));
            if (mode) await setAppMode(mode);
            switchTab('grid');
            await setGridView('grid');
        });
        await waitFor(page, () => gridTabsAvailable() && currentTab() === 'grid');
        await swipe(page, '#view-grid', -220);
        await waitFor(page, () => state.gridView === 'interactions', null, 5000);
        await swipe(page, '#view-grid', -220);
        await waitFor(page, () => state.gridView === 'matches', null, 5000);
        await swipe(page, '#view-grid', 220);
        await waitFor(page, () => state.gridView === 'interactions', null, 5000);
        assert.equal(await page.evaluate(() => currentTab()), 'grid', 'still on the grid tab');
        await swipe(page, '#view-grid', -220);
        await swipe(page, '#view-grid', -220);
        await waitFor(page, () => currentTab() !== 'grid', null, 5000);

        // 2) Sticker-Reiter im Snap-Editor.
        await page.evaluate(() => {
            const row = document.getElementById('snap-emoji-row');
            row.classList.remove('hidden');
            renderSnapEmojiRow('faces');
        });
        await swipe(page, '#snap-emoji-row .snap-sticker-grid', -200);
        await waitFor(page, () => snapEditor.stickerTab === 'hearts', null, 5000);
        await swipe(page, '#snap-emoji-row .snap-sticker-grid', 200);
        await waitFor(page, () => snapEditor.stickerTab === 'faces', null, 5000);
        await page.evaluate(() => document.getElementById('snap-emoji-row').classList.add('hidden'));

        // 3) GIF-Auswahl: Reiter seitlich.
        await page.evaluate(async () => {
            state.activeChatPeerId = 'node_tabswipe-dummy';
            await openGifPicker();
        });
        await page.waitForSelector('#gif-picker-body', { timeout: 10000 });
        const gifTabs = await page.evaluate(() => [...document.querySelectorAll('[data-gif-tab]')].map(button => button.dataset.gifTab));
        assert.ok(gifTabs.length >= 2, `several gif tabs (${gifTabs})`);
        const selected = () => page.evaluate(() => document.querySelector('[data-gif-tab][aria-selected="true"]')?.dataset.gifTab);
        assert.equal(await selected(), gifTabs[0]);
        await swipe(page, '#gif-picker-body', -200);
        await waitFor(page, tab => document.querySelector('[data-gif-tab][aria-selected="true"]')?.dataset.gifTab === tab, gifTabs[1], 5000);
        await swipe(page, '#gif-picker-body', 200);
        assert.equal(await selected(), gifTabs[0]);
        await page.evaluate(() => closeMediaModal());

        // 4) Profil-Popup: Dating <-> Freunde (beide Reiter sichtbar, wenn Match und Freund).
        await page.evaluate(() => {
            const peerId = 'node_tabswipe-peer';
            state.cachedProfiles[peerId] = { id: peerId, fields: { displayName: 'Freundin' }, discoveryProfile: { fields: { displayName: 'Dating-Name' } } };
            window.isMatched = () => true;
            window.isFriend = () => true;
            openProfileModal(peerId);
        });
        await waitFor(page, () => !document.getElementById('modal-profile-tabs').classList.contains('hidden'), null, 5000);
        const first = await page.evaluate(() => state.profileModalTab.tab);
        await swipe(page, '#modal-rendered-fields', first === 'dating' ? -200 : 200);
        await waitFor(page, tab => state.profileModalTab.tab !== tab, first, 5000);
        assert.equal(await page.evaluate(() => document.getElementById('modal-profile-name').textContent), first === 'dating' ? 'Freundin' : 'Dating-Name');

        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (tab strip swipes)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
