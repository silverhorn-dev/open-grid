// End-to-End (mobil, echte Mehrfinger-Touch-Events ueber CDP): Snap-Kamera und -Editor.
//   - Kamera: nach oben wischen mitten im Bild oeffnet die Galerie, seitlich wischen wechselt Snap/Bild
//   - Editor: ein Finger auf dem Emoji verschiebt, ein zweiter Finger irgendwo skaliert und dreht
//     (rastet bei 90 Grad ein); zwei Finger auf dem Hintergrund zoomen das Foto; ein Finger seitlich
//     auf dem Bild wechselt Snap/Bild
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
    const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const pageErrors = [];
    try {
        const context = await browser.newContext({ locale: 'de-DE', ...devices['Pixel 7'], permissions: ['camera'] });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Editor');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        await page.evaluate(async () => {
            await openChatWithPeer('node_fake_editor');
            // Galerie-Dialog zaehlen statt oeffnen.
            window.galleryOpened = 0;
            HTMLInputElement.prototype.click = function click() {
                if (this.id === 'snap-file-input') window.galleryOpened += 1;
            };
        });

        const cdp = await context.newCDPSession(page);
        const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
        async function swipe(from, dx, dy) {
            await touch('touchStart', [{ ...from, id: 1 }]);
            for (let step = 1; step <= 8; step++) {
                await touch('touchMove', [{ x: from.x + dx * step / 8, y: from.y + dy * step / 8, id: 1 }]);
                await page.waitForTimeout(16);
            }
            await touch('touchEnd', []);
            await page.waitForTimeout(250);
        }

        // Kamera: hoch wischen in der Bildmitte = Galerie, seitlich = Snap/Bild.
        await page.evaluate(() => openSnapUploadModal());
        await waitFor(page, () => document.getElementById('snap-video-preview').videoWidth > 0);
        const viewport = page.viewportSize();
        const centre = { x: viewport.width / 2, y: viewport.height / 2 };
        await swipe(centre, 0, -160);
        assert.equal(await page.evaluate(() => window.galleryOpened), 1, 'swipe up in the middle of the camera opens the gallery');
        await swipe({ x: viewport.width * 0.6, y: centre.y - 120 }, -160, 0);
        assert.equal(await page.evaluate(() => state.snapSendMode), 'image', 'sideways swipe switches to image');
        await swipe({ x: viewport.width * 0.25, y: viewport.height - 60 }, 160, 0);
        assert.equal(await page.evaluate(() => state.snapSendMode), 'snap', 'also works in the bottom area next to the buttons');
        // Wischen, das auf dem Umschalt-Knopf am rechten Rand beginnt, schaltet genau einmal um.
        const modeSwitch = await page.locator('#snap-mode-switch').boundingBox();
        await swipe({ x: modeSwitch.x + modeSwitch.width / 2, y: modeSwitch.y + modeSwitch.height / 2 }, -160, 0);
        assert.equal(await page.evaluate(() => state.snapSendMode), 'image', 'swipe starting on the switch button');
        await page.tap('#snap-mode-switch');
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => state.snapSendMode), 'snap', 'tapping the button still toggles');

        // Editor mit Testbild und einem Emoji in der Mitte.
        await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 600;
            canvas.height = 900;
            const context2d = canvas.getContext('2d');
            context2d.fillStyle = '#3b82f6';
            context2d.fillRect(0, 0, 600, 900);
            showSnapReview(captureSnapBase(canvas, 600, 900, false));
            addSnapItem({ kind: 'emoji', text: '🔥', size: 0.14, color: '#ffffff' });
        });
        await page.waitForTimeout(300);
        const item = await page.evaluate(() => {
            const box = document.querySelector('#snap-edit-layers [data-item-id]').getBoundingClientRect();
            return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        });

        // Ein Finger aufs Emoji, zweiter Finger rechts daneben; zweiten Finger auf doppelten Abstand
        // bringen und um ~85 Grad drehen.
        const radius = 60;
        await touch('touchStart', [{ x: item.x, y: item.y, id: 1 }]);
        await touch('touchStart', [{ x: item.x, y: item.y, id: 1 }, { x: item.x + radius, y: item.y, id: 2 }]);
        for (let step = 1; step <= 10; step++) {
            const angle = (85 * Math.PI / 180) * step / 10;
            const distance = radius * (1 + step / 10);
            await touch('touchMove', [{ x: item.x, y: item.y, id: 1 }, { x: item.x + Math.cos(angle) * distance, y: item.y + Math.sin(angle) * distance, id: 2 }]);
            await page.waitForTimeout(16);
        }
        await touch('touchEnd', [{ x: item.x, y: item.y, id: 1 }]);
        await touch('touchEnd', []);
        await page.waitForTimeout(200);
        const transformed = await page.evaluate(() => ({ scale: snapEditor.items[0].scale, rotation: snapEditor.items[0].rotation }));
        assert.ok(Math.abs(transformed.scale - 2) < 0.2, `scaled with the second finger: ${transformed.scale}`);
        assert.ok(Math.abs(transformed.rotation - Math.PI / 2) < 1e-6, `rotation snaps to 90 degrees: ${transformed.rotation}`);
        assert.equal(await page.evaluate(() => snapEditor.background.scale), 1, 'background untouched');

        // Zwei Finger auf dem Hintergrund (unten, weg vom Emoji) auseinander: Foto zoomt.
        const low = { x: viewport.width / 2, y: item.y + 180 };
        await touch('touchStart', [{ x: low.x - 40, y: low.y, id: 1 }]);
        await touch('touchStart', [{ x: low.x - 40, y: low.y, id: 1 }, { x: low.x + 40, y: low.y, id: 2 }]);
        for (let step = 1; step <= 8; step++) {
            await touch('touchMove', [{ x: low.x - 40 - step * 5, y: low.y, id: 1 }, { x: low.x + 40 + step * 5, y: low.y, id: 2 }]);
            await page.waitForTimeout(16);
        }
        await touch('touchEnd', []);
        await page.waitForTimeout(200);
        const background = await page.evaluate(() => snapEditor.background.scale);
        assert.ok(background > 1.5, `background zoomed: ${background}`);
        assert.ok(Math.abs(await page.evaluate(() => snapEditor.items[0].scale) - 2) < 0.2, 'emoji untouched by the background gesture');

        // Ein Finger seitlich auf dem Bild: Snap <-> Bild.
        await swipe({ x: viewport.width * 0.8, y: low.y }, -170, 0);
        assert.equal(await page.evaluate(() => state.snapSendMode), 'image', 'sideways swipe in the editor switches the mode');

        // Senden-Bild enthaelt die Transformationen (Hintergrund gezoomt, Rand nicht mehr schwarz am Rand der Mitte).
        const flat = await page.evaluate(() => {
            const canvas = flattenSnapDraft();
            const [r, g, b] = canvas.getContext('2d').getImageData(canvas.width / 2, 5, 1, 1).data;
            return { width: canvas.width, height: canvas.height, top: [r, g, b] };
        });
        assert.equal(flat.width, 600);
        assert.ok(flat.top[2] > 150, `zoomed photo still covers the top: ${flat.top}`);

        // Filter: S/W macht das blaue Foto grau (Vorschau und gesendetes Bild).
        await page.tap('#snap-filter-row [data-filter="bw"]');
        await page.waitForTimeout(200);
        assert.equal(await page.getAttribute('#snap-filter-row [data-filter="bw"]', 'aria-checked'), 'true');
        const filtered = await page.evaluate(() => {
            const canvas = flattenSnapDraft();
            const [r, g, b] = canvas.getContext('2d').getImageData(canvas.width / 2, 5, 1, 1).data;
            return [r, g, b];
        });
        assert.ok(Math.abs(filtered[0] - filtered[2]) < 4, `black and white: ${filtered}`);

        // Uhrzeit als Sticker und Text mit anderer Art und vollem Hintergrund.
        await page.tap('#snap-tool-emoji');
        await page.tap('#snap-emoji-row [data-time-sticker]');
        const time = await page.evaluate(() => snapEditor.items.at(-1));
        assert.match(time.text, /^\d\d:\d\d$/);
        assert.equal(time.font, 'mono');
        await page.tap('[data-click="startSnapText"]');
        await page.fill('#snap-text-input', 'Hallo');
        await page.tap('#snap-text-style-btn');
        await page.tap('#snap-text-background-btn');
        await page.tap('#snap-text-background-btn');
        await page.tap('[data-click="commitSnapText"]');
        const text = await page.evaluate(() => snapEditor.items.at(-1));
        assert.deepEqual([text.text, text.font, text.background], ['Hallo', 'serif', 'solid']);
        const element = await page.evaluate(() => {
            const node = document.querySelector('#snap-edit-layers [data-item-id]:last-child');
            const style = getComputedStyle(node);
            return { font: style.fontFamily, style: style.fontStyle, background: style.backgroundColor };
        });
        assert.match(element.font, /Georgia|serif/);
        assert.equal(element.style, 'italic');
        assert.notEqual(element.background, 'rgba(0, 0, 0, 0)', 'full background behind the text');
        assert.ok(await page.evaluate(() => Boolean(flattenSnapDraft())), 'flattens with styled text');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (snap editor gestures, mobile)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
