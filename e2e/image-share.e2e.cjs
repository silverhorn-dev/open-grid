// End-to-End: Bild speichern oder ueber das System teilen. Ohne Web Share API gibt es nur
// "Speichern"; mit (hier nachgebildet) zusaetzlich "Teilen", das ein JPEG an navigator.share gibt.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function openViewer(page) {
    await page.goto(`${BASE_URL}/`);
    await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
    const input = page.locator('#onboarding-profile-form input').first();
    await input.fill('Share');
    await input.dispatchEvent('change');
    await page.click('#complete-onboarding-btn');
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 100;
        canvas.getContext('2d').fillRect(0, 0, 200, 100);
        openImageViewer([canvas.toDataURL('image/png')], 0, { allowSave: true });
    });
    await page.waitForTimeout(400);
}

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const plain = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        plain.on('pageerror', error => pageErrors.push(error.message));
        await plain.addInitScript(() => { delete Navigator.prototype.share; delete Navigator.prototype.canShare; });
        await openViewer(plain);
        assert.equal(await plain.isVisible('#image-viewer-save'), true);
        assert.equal(await plain.isVisible('#image-viewer-share'), false, 'no share button without the Web Share API');

        const sharing = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        sharing.on('pageerror', error => pageErrors.push(error.message));
        await sharing.addInitScript(() => {
            window.sharedFiles = [];
            Navigator.prototype.canShare = data => Array.isArray(data?.files) && data.files.every(file => file instanceof File);
            Navigator.prototype.share = async data => { window.sharedFiles.push(...data.files.map(file => ({ name: file.name, type: file.type, size: file.size }))); };
        });
        await openViewer(sharing);
        assert.equal(await sharing.isVisible('#image-viewer-save'), true, 'download stays available');
        assert.equal(await sharing.isVisible('#image-viewer-share'), true);
        await sharing.click('#image-viewer-share');
        // Kein waitForFunction: das nutzt eval und scheitert an der CSP (script-src 'self').
        for (let attempt = 0; attempt < 25 && !(await sharing.evaluate(() => window.sharedFiles.length)); attempt += 1) {
            await sharing.waitForTimeout(200);
        }
        const shared = await sharing.evaluate(() => window.sharedFiles);
        assert.equal(shared.length, 1);
        assert.equal(shared[0].type, 'image/jpeg');
        assert.match(shared[0].name, /^opengrid-\d+\.jpg$/);
        assert.ok(shared[0].size > 0);

        // Ohne Freigabe (z. B. Alben, Grid & Event) weder Speichern noch Teilen.
        await sharing.evaluate(() => { closeImageViewer(); });
        await sharing.waitForTimeout(300);
        await sharing.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 20;
            canvas.height = 20;
            openImageViewer([canvas.toDataURL('image/png')], 0);
        });
        assert.equal(await sharing.isVisible('#image-viewer-share'), false);
        assert.equal(await sharing.isVisible('#image-viewer-save'), false);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (image share)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
