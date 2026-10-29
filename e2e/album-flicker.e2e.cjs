// End-to-End: Album am PC flackert nicht. Beim Neuzeichnen (jedes ankommende Bild, jeder Schluessel)
// wurde das Raster frueher geleert und Bild fuer Bild neu aufgebaut; das zentrierte Fenster sprang in der
// Hoehe. Jetzt: in keinem Bild ist das Raster leer oder kuerzer, Canvas werden wiederverwendet, die
// Fensterhoehe bleibt gleich.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext({ locale: 'de-DE', viewport: { width: 1280, height: 900 } })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Flacker');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await page.waitForTimeout(1500);

        const result = await page.evaluate(async () => {
            const items = [];
            for (let index = 0; index < 8; index += 1) {
                const canvas = document.createElement('canvas');
                canvas.width = 200;
                canvas.height = 200;
                const context = canvas.getContext('2d');
                context.fillStyle = `hsl(${index * 40}, 70%, 50%)`;
                context.fillRect(0, 0, 200, 200);
                await cacheMedia(`albimg_flicker_${index}`, canvas.toDataURL('image/jpeg', 0.9), 1);
                items.push({ id: `albimg_flicker_${index}`, version: 1 });
            }
            await saveAlbum({
                id: 'alb_flicker', ownerId: state.myProfile.id, name: 'Flackern', items,
                acl: [], secret: createAlbumSecret(), keyVersion: 1, keyEpochMinutes: 0, keyEpochsAhead: 1
            });
            await openAlbumViewer('alb_flicker');
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            await wait(500);
            const content = document.getElementById('media-modal-content');
            const panel = document.querySelector('#media-modal > div');
            const before = [...content.querySelectorAll('canvas')];
            const heightBefore = panel.getBoundingClientRect().height;
            // Jedes Bild (Frame) waehrend der Neuzeichnungen pruefen.
            let minTiles = Infinity;
            let maxHeightChange = 0;
            let sampling = true;
            const sample = () => {
                minTiles = Math.min(minTiles, content.querySelectorAll('canvas').length);
                maxHeightChange = Math.max(maxHeightChange, Math.abs(panel.getBoundingClientRect().height - heightBefore));
                if (sampling) requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
            const album = state.albums.alb_flicker;
            await Promise.all([renderAlbumViewer(album), renderAlbumViewer(album), renderAlbumViewer(album)]);
            await wait(300);
            sampling = false;
            const after = [...content.querySelectorAll('canvas')];
            return {
                tilesBefore: before.length,
                minTiles,
                maxHeightChange,
                reused: after.length === before.length && after.every((canvas, index) => canvas === before[index]),
                drawn: after.every(canvas => canvas.width > 0)
            };
        });
        assert.equal(result.tilesBefore, 8);
        assert.equal(result.minTiles, 8, `the grid is never empty or shorter while redrawing (min ${result.minTiles})`);
        assert.ok(result.maxHeightChange < 1, `the window keeps its height (${result.maxHeightChange}px)`);
        assert.equal(result.reused, true, 'canvases are reused, nothing flashes blank');
        assert.equal(result.drawn, true);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (album flicker)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
