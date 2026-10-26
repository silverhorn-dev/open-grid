// End-to-End: Bildbetrachter wischt ohne Flackern. Nach dem Wechsel zeigt die Mitte sofort das neue
// Bild (vorher kurz das alte, bis das neue asynchron gezeichnet war).
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext({ locale: 'de-DE', viewport: { width: 900, height: 700 } })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Viewer');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await page.waitForTimeout(1500);

        const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
        await page.evaluate(async palette => {
            const images = palette.map(color => {
                const canvas = document.createElement('canvas');
                canvas.width = 400;
                canvas.height = 300;
                const context = canvas.getContext('2d');
                context.fillStyle = color;
                context.fillRect(0, 0, 400, 300);
                return canvas.toDataURL('image/png');
            });
            openImageViewer(images, 0);
        }, colors);
        await page.waitForTimeout(600);

        // Mitte pro Frame abtasten, waehrend zweimal vorwaerts und einmal zurueck gewischt wird.
        const samples = await page.evaluate(async () => {
            const sample = () => {
                const canvas = document.getElementById('image-viewer-image');
                if (!canvas.width) return 'empty';
                const [r, g, b] = canvas.getContext('2d').getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
                return `${r > 128 ? 1 : 0}${g > 128 ? 1 : 0}${b > 128 ? 1 : 0}`;
            };
            const results = [];
            for (const direction of [1, 1, -1]) {
                stepImageViewer(direction);
                const expectedIndex = viewer.index + direction;
                await new Promise(resolve => setTimeout(resolve, VIEWER_SLIDE_MS + 5));
                const frames = [];
                for (let frame = 0; frame < 20; frame++) {
                    frames.push(sample());
                    await new Promise(resolve => requestAnimationFrame(resolve));
                }
                results.push({ expectedIndex, index: viewer.index, frames });
            }
            return results;
        });
        const code = ['100', '010', '001', '110'];
        for (const { expectedIndex, index, frames } of samples) {
            assert.equal(index, expectedIndex);
            assert.ok(frames.every(frame => frame === code[expectedIndex]), `no flicker after switching to ${expectedIndex}: ${frames.join(',')}`);
        }
        assert.equal(await page.textContent('#image-viewer-counter'), '2 / 4');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (image viewer)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
