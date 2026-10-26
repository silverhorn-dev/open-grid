// End-to-End: Nacktbild-Filter (T3) mit einem Test-Modell (markiert rote Bilder). Ohne Modell und
// ohne Einschalten bleibt alles wie bisher; eingeschaltet erscheint ein fremdes Bild unscharf, der
// erste Tipp zeigt es (ohne den Viewer zu oeffnen), danach ist es auch im Viewer scharf.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Filter');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await page.waitForTimeout(1500);

        assert.equal(await page.evaluate(() => state.nudityFilter), false, 'off by default');
        await page.evaluate(() => { switchTab('keys'); switchSettingsTab('media'); });
        assert.equal(await page.isVisible('#nudity-filter-no-model'), true, 'says that no model is installed');

        const result = await page.evaluate(async () => {
            const image = color => {
                const canvas = document.createElement('canvas');
                canvas.width = 400;
                canvas.height = 300;
                const context = canvas.getContext('2d');
                context.fillStyle = color;
                context.fillRect(0, 0, 400, 300);
                return canvas.toDataURL('image/png');
            };
            const centre = canvas => {
                const [r, g, b] = canvas.getContext('2d').getImageData(canvas.width / 2, 20, 1, 1).data;
                return [r, g, b];
            };
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            registerNudityClassifier({
                id: 'test-red',
                classify: async bitmap => {
                    const probe = new OffscreenCanvas(1, 1).getContext('2d');
                    probe.drawImage(bitmap, 0, 0, 1, 1);
                    const [r, g] = probe.getImageData(0, 0, 1, 1).data;
                    return r > 200 && g < 50 ? 0.99 : 0.01;
                }
            });
            await updateNudityFilter(true);
            const red = image('#ff0000');
            const green = image('#00ff00');
            let opened = 0;
            const flagged = createSecureImage(red, '');
            flagged.onclick = () => { opened += 1; };
            const harmless = createSecureImage(green, '');
            const mine = createSecureImage(red, '', null, { own: true });
            document.body.append(flagged, harmless, mine);
            await wait(500);
            const before = { blurred: flagged.dataset.nudityBlurred, pixel: centre(flagged), harmless: harmless.dataset.nudityBlurred, mine: mine.dataset.nudityBlurred };
            flagged.click();
            await wait(400);
            const after = { blurred: flagged.dataset.nudityBlurred || null, pixel: centre(flagged), opened };
            flagged.click();
            const secondClickOpened = opened;
            openImageViewer([red], 0);
            await wait(500);
            const viewerCanvas = document.getElementById('image-viewer-image');
            return { before, after, secondClickOpened, viewerBlurred: viewerCanvas.dataset.nudityBlurred || null, noModelHidden: document.getElementById('nudity-filter-no-model').classList.contains('hidden') };
        });
        assert.equal(result.noModelHidden, true);
        assert.equal(result.before.blurred, 'true');
        assert.ok(result.before.pixel[0] < 200, `blurred and darkened: ${result.before.pixel}`);
        assert.equal(result.before.harmless, undefined, 'harmless images stay sharp');
        assert.equal(result.before.mine, undefined, 'own images are never checked');
        assert.equal(result.after.blurred, null);
        assert.deepEqual(result.after.pixel, [255, 0, 0], 'revealed image is sharp');
        assert.equal(result.after.opened, 0, 'the revealing tap does not open the viewer');
        assert.equal(result.secondClickOpened, 1);
        assert.equal(result.viewerBlurred, null, 'revealed images stay visible in the viewer');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (nudity filter)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
