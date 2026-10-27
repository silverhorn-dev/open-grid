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

        // Gueltigkeit pro Person: Auswahl neben jeder Person im Album, inkl. 1 Woche.
        const perPerson = await page.evaluate(async () => {
            const album = state.albums.alb_preview;
            album.acl = ['node_fake_album_preview'];
            await saveAlbum(album);
            switchTab('keys');
            renderAlbumManager();
            const select = document.querySelector('[data-viewer-key-epoch="node_fake_album_preview"]');
            if (!select) return null;
            select.value = '10080';
            select.dispatchEvent(new Event('change'));
            await new Promise(resolve => setTimeout(resolve, 300));
            return { options: [...select.options].map(option => option.textContent), stored: state.albums.alb_preview.viewerKeyEpochs?.node_fake_album_preview };
        });
        // Kein Flackern: nach dem Neuzeichnen stehen dieselben, schon gezeichneten Canvas da.
        const reuse = await page.evaluate(async () => {
            const same = async (selector, rerender) => {
                await new Promise(resolve => setTimeout(resolve, 400));
                const before = document.querySelector(selector);
                rerender();
                const after = document.querySelector(selector);
                return Boolean(before) && before === after && after.width > 0;
            };
            await updateAlbumPreview('alb_preview', 'normal');
            switchTab('chat');
            await openChatWithPeer('node_fake_album_preview');
            await shareAlbumInChat('alb_preview');
            const card = await same('#chat-messages canvas[data-reuse-key^="album-card:"]', () => renderChatHistory());
            switchTab('editprofile');
            renderAlbumManager();
            const cover = await same('#album-manager-list canvas[data-reuse-key="album-cover:alb_preview"]', () => renderAlbumManager());
            return { card, cover };
        });
        assert.equal(reuse.card, true, 'album card in the chat keeps its canvas');
        assert.equal(reuse.cover, true, 'album cover in the manager keeps its canvas');
        assert.ok(perPerson, 'per-person select rendered');
        assert.ok(perPerson.options.includes('1 Woche') && perPerson.options.includes('wie Album'), perPerson.options.join(','));
        assert.equal(perPerson.stored, 10080);

        // Begrenzt teilen: zweiter Schritt im Sendemenue, Karte zeigt die Grenze, Verwaltung den Stand.
        await page.evaluate(async () => {
            switchTab('chat');
            await openChatWithPeer('node_fake_album_preview');
            openAlbumPicker();
        });
        await page.click('#media-modal-content button:has-text("Vorschau")');
        assert.match(await page.textContent('#media-modal-title'), /„Vorschau“ teilen/);
        assert.equal(await page.isVisible('[data-share-limit="none"]'), true, 'normal sharing can be skipped to');
        await page.click('[data-share-limit="views2"]');
        const shared = await page.evaluate(async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
            const message = state.chats.node_fake_album_preview.filter(entry => entry.album).at(-1);
            return { limit: message.album.limit, stored: state.albums.alb_preview.limits?.node_fake_album_preview };
        });
        assert.deepEqual(shared.limit, { kind: 'views', views: 2 });
        assert.deepEqual(shared.stored, { kind: 'views', views: 2, used: 0 });
        assert.match(await page.textContent('#chat-messages'), /2x ansehen/);

        const manager = await page.evaluate(async () => {
            const album = state.albums.alb_preview;
            album.acl = ['node_fake_album_preview', 'node_b', 'node_c'];
            await saveAlbum(album);
            switchTab('editprofile');
            renderAlbumManager();
            const card = document.querySelector('[data-album-id="alb_preview"]');
            const folded = card.querySelector('details.album-access');
            return {
                folded: Boolean(folded) && !folded.open,
                summary: folded?.querySelector('summary')?.textContent,
                chip: card.querySelector('[data-viewer="node_fake_album_preview"] .album-limit-chip')?.textContent
            };
        });
        assert.equal(manager.folded, true, 'access list folded from 3 people on');
        assert.equal(manager.summary, 'Zugriff (3 Personen)');
        assert.equal(manager.chip, 'noch 2 von 2 Ansichten');

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
