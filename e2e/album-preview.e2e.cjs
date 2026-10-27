// End-to-End: Album-Vorschau im Chat. Der Besitzer waehlt je Album "normal", "unscharf" oder "keine";
// unscharf wird schon bei ihm gerechnet (das gesendete Deckbild ist unscharf), "keine" sendet kein Bild.
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
        await input.fill('Owner');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await page.waitForTimeout(1500);

        const result = await page.evaluate(async () => {
            // Scharfe Kante: links schwarz, rechts weiss.
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 320;
            const context = canvas.getContext('2d');
            context.fillStyle = '#000000';
            context.fillRect(0, 0, 160, 320);
            context.fillStyle = '#ffffff';
            context.fillRect(160, 0, 160, 320);
            await cacheMedia('albimg_preview', canvas.toDataURL('image/jpeg', 0.95), 1);
            await saveAlbum({
                id: 'alb_preview', ownerId: state.myProfile.id, name: 'Vorschau', items: [{ id: 'albimg_preview', version: 1 }],
                acl: [], secret: createAlbumSecret(), keyVersion: 1, keyEpochMinutes: 0, keyEpochsAhead: 1
            });
            await openChatWithPeer('node_fake_album_preview');
            // Kontrast an der Kante: scharf = gross, unscharf = klein.
            const edgeContrast = async cover => {
                const image = new Image();
                image.src = cover;
                await image.decode();
                const probe = document.createElement('canvas');
                probe.width = image.width;
                probe.height = image.height;
                const probeContext = probe.getContext('2d');
                probeContext.drawImage(image, 0, 0);
                const y = Math.round(image.height / 2);
                const left = probeContext.getImageData(Math.round(image.width / 2) - 6, y, 1, 1).data[0];
                const right = probeContext.getImageData(Math.round(image.width / 2) + 6, y, 1, 1).data[0];
                return right - left;
            };
            const lastAlbum = () => state.chats.node_fake_album_preview.filter(message => message.album).at(-1).album;
            const out = {};
            for (const preview of ['normal', 'blur', 'none']) {
                await updateAlbumPreview('alb_preview', preview);
                await shareAlbumInChat('alb_preview');
                const album = lastAlbum();
                out[preview] = album.cover ? await edgeContrast(album.cover) : null;
            }
            out.control = Boolean(document.querySelector('[data-album-preview="alb_preview"]')) || 'not rendered';
            out.stored = state.albums.alb_preview.preview;
            return out;
        });
        assert.ok(result.normal > 150, `normal cover is sharp: ${result.normal}`);
        assert.ok(result.blur !== null && result.blur < 80, `blurred cover leaves the device blurred: ${result.blur}`);
        assert.equal(result.none, null, 'no cover at all');
        assert.equal(result.stored, 'none', 'choice is stored per album');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (album preview)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
