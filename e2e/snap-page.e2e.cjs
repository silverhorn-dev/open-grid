// End-to-End: Snap-Seite im Social-Modus (snap-studio.js, UC-73). Tab zwischen Chat und Profil mit der
// Snap-Kamera als Seite (Navigation bleibt sichtbar), seitlich wischen wechselt den Tab, Ziel nach der
// Aufnahme waehlen (hier: Galerie des eigenen Profils), in den Einstellungen abschaltbar.
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
    const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const pageErrors = [];
    try {
        const context = await browser.newContext({
            locale: 'de-DE', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ['camera']
        });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Snapper');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.myProfile.id && state.appConfig));

        // Entdecken: kein Snap-Tab.
        await page.evaluate(() => setAppMode('discovery'));
        assert.equal(await page.locator('nav.bottom-nav [data-tab-btn="snap"]').isVisible(), false, 'no snap tab while discovering');

        // Social-Modus: Tab zwischen Chat und Profil.
        await page.evaluate(() => setAppMode('chat'));
        const order = await page.evaluate(() => [...document.querySelectorAll('nav.bottom-nav [data-tab-btn]')]
            .filter(button => !button.classList.contains('hidden')).map(button => button.dataset.tabBtn));
        assert.deepEqual(order.slice(-3), ['chat', 'snap', 'editprofile']);

        await page.click('nav.bottom-nav [data-tab-btn="snap"]');
        await waitFor(page, () => document.getElementById('snap-video-preview').videoWidth > 0);
        assert.equal(new URL(page.url()).pathname, '/snap');
        assert.ok(await page.evaluate(() => document.getElementById('view-snap').contains(document.getElementById('snap-capture-modal'))),
            'camera lives inside the snap page');
        // Kein Vollbild: die Navigation bleibt sichtbar, die Kamera endet darueber.
        const nav = await page.locator('nav.bottom-nav').boundingBox();
        const camera = await page.locator('#snap-capture-modal').boundingBox();
        assert.ok(await page.locator('nav.bottom-nav').isVisible(), 'bottom nav visible');
        assert.ok(camera.y + camera.height <= nav.y + 1, `camera ends above the nav (${camera.y + camera.height} > ${nav.y})`);
        const sizes = await page.evaluate(() => ({ scroll: document.scrollingElement.scrollHeight, inner: window.innerHeight,
            main: document.querySelector('main').getBoundingClientRect().bottom, mainPad: getComputedStyle(document.querySelector('main')).paddingBottom,
            host: document.getElementById('snap-page-host').getBoundingClientRect().bottom, header: getComputedStyle(document.documentElement).getPropertyValue('--app-header-height'),
            navH: getComputedStyle(document.documentElement).getPropertyValue('--bottom-nav-height'),
            below: [...document.body.children].map(el => [el.tagName + '#' + el.id + '.' + String(el.className).slice(0, 30), Math.round(el.getBoundingClientRect().bottom)]).filter(([, b]) => b > window.innerHeight) }));
        assert.ok(sizes.scroll <= sizes.inner + 1, `page does not scroll ${JSON.stringify(sizes)}`);

        // Nach rechts wischen = Chat (Kamera aus), nach links zurueck, weiter nach links = Profil.
        await swipe(page, '#snap-camera-stage', 160);
        await waitFor(page, () => !document.getElementById('view-chat').classList.contains('hidden'), null, 5000);
        assert.equal(await page.evaluate(() => state.mediaStream), null, 'camera stops when leaving the page');
        assert.equal(await page.evaluate(() => state.snapSendMode), 'snap', 'sideways swipe did not toggle snap/image');
        await swipe(page, '#view-chat', -160);
        await waitFor(page, () => !document.getElementById('view-snap').classList.contains('hidden'), null, 5000);
        await waitFor(page, () => document.getElementById('snap-video-preview').videoWidth > 0);
        await swipe(page, '#snap-camera-stage', -160);
        await waitFor(page, () => !document.getElementById('view-editprofile').classList.contains('hidden'), null, 5000);
        assert.ok(await page.evaluate(() => !document.body.contains(document.querySelector('#view-snap #snap-capture-modal'))
            && document.getElementById('snap-capture-modal').classList.contains('hidden')), 'camera back as hidden modal');

        // Aufnahme -> Ziel waehlen -> Galerie des eigenen Profils.
        await page.click('nav.bottom-nav [data-tab-btn="snap"]');
        await waitFor(page, () => document.getElementById('snap-video-preview').videoWidth > 0);
        const galleryBefore = await page.evaluate(() => (editingProfilePart().gallery || []).length);
        await page.evaluate(() => captureSnap());
        await page.locator('#snap-send-btn').click();
        await page.waitForSelector('#media-modal:not(.hidden)', { timeout: 5000 });
        await page.locator('#media-modal-content button', { hasText: 'Zur Galerie' }).click();
        await waitFor(page, before => (editingProfilePart().gallery || []).length === before + 1, galleryBefore, 10000);
        // Danach wieder Live-Kamera auf der Seite.
        await waitFor(page, () => document.getElementById('media-modal').classList.contains('hidden')
            && document.getElementById('snap-video-preview').videoWidth > 0 && state.snapPage, null, 10000);

        // Abschalten: Tab weg, /snap fuehrt in den Chat.
        await page.evaluate(() => updateSnapPageSetting(false));
        assert.equal(await page.locator('nav.bottom-nav [data-tab-btn="snap"]').isVisible(), false, 'snap tab hidden when disabled');
        assert.ok(await page.evaluate(() => !document.getElementById('view-chat').classList.contains('hidden') && !state.snapPage));
        assert.deepEqual(pageErrors, []);
        console.log('snap-page e2e passed');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
