// End-to-End: GIFs im Chat (gifs.js, Board T34). Router-Quellen und GIF-Server sind gemockt (Playwright-Routen,
// CSP umgangen), weil der E2E-Router GIFs aus hat und kein Internet braucht. Geprueft:
// - GIF steht im Medien-Menue, die Auswahl fragt erst nach der Zustimmung (Systemdialog),
// - Bibliothek und Link senden nur die URL; der Empfaenger laedt nichts, bis er zustimmt (verschwommene Flaeche),
// - externe Links brauchen eine eigene Zustimmung, Favoriten und Einstellungen.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const GIF_HOST = 'https://gifs.e2e-media.org';
const OTHER_HOST = 'https://elsewhere.e2e-media.org';
const KLIPY_MEDIA = 'https://static.klipy.com/ii/e2e-hello';
// Wie ein Discord-Anhang (signierte Query muss unveraendert bleiben).
const PASTED = 'https://media.discordapp.net/attachments/1/2/work.gif?ex=6af29554&is=6af143d4&hm=abc123&=';
// 2x2 GIF, rot.
const GIF_BYTES = Buffer.from('R0lGODlhAgACAPAAAP8AAAAAACH5BAAAAAAALAAAAAACAAIAAAIChF8AOw==', 'base64');

async function waitFor(page, predicate, arg, timeout = 30000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await page.evaluate(predicate, arg).catch(() => false)) return;
        await page.waitForTimeout(250);
    }
    throw new Error(`Timed out waiting for ${predicate}`);
}

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    const gifRequests = { alice: [], bob: [] };
    const newPage = async name => {
        // Service Worker aus: sonst sieht Playwright die GIF-Anfragen nicht (der SW-Cache ist per Unit-Test abgedeckt).
        const context = await browser.newContext({ locale: 'de-DE', bypassCSP: true, serviceWorkers: 'block' });
        await context.route('**/api/config', async route => {
            const response = await route.fetch();
            const config = await response.json();
            await route.fulfill({ response, json: { ...config, gifs: {
                sources: ['library', 'url', 'provider'], review: true, proxy: name === 'bob',
                provider: { name: 'klipy', key: 'e2e-test-key', contentFilter: 'high' }
            } } });
        });
        // Klipy-API (Suche/Trending, direkt vom Client) und deren Medien.
        await context.route('https://api.klipy.com/**', route => {
            gifRequests[name].push(route.request().url());
            return route.fulfill({ json: { result: true, data: { data: [
                { type: 'gif', title: 'Hello', file: { sm: { webp: { url: KLIPY_MEDIA, width: 2, height: 2 } } } },
                { type: 'ad', file: {} }
            ], has_next: false } } });
        });
        await context.route('https://static.klipy.com/**', route => {
            gifRequests[name].push(route.request().url());
            return route.fulfill({ status: 200, contentType: 'image/gif', body: GIF_BYTES });
        });
        // Bob: Proxy des Routers an (gemockt), Alice laedt direkt.
        await context.route('**/api/gif-proxy/token', route => route.fulfill({ json: { token: 'e2e-token' } }));
        await context.route(url => url.pathname === '/api/gif-proxy', route => {
            gifRequests[name].push(route.request().url());
            return route.fulfill({ status: 200, contentType: 'image/gif', body: GIF_BYTES });
        });
        await context.route('**/api/gifs/report', route => route.fulfill({ json: { ok: true } }));
        await context.route('**/api/gifs**', route => (route.request().method() === 'GET'
            ? route.fulfill({ json: { gifs: [{ id: 1, url: `${GIF_HOST}/party.gif`, title: 'Party', width: 2, height: 2 }], next: null } })
            : route.fulfill({ status: 201, json: { status: 'pending', gif: { id: 2 } } })));
        for (const host of [GIF_HOST, OTHER_HOST, 'https://media.discordapp.net']) {
            await context.route(`${host}/**`, route => {
                gifRequests[name].push(route.request().url());
                return route.fulfill({ status: 200, contentType: 'image/gif', body: GIF_BYTES });
            });
        }
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(`${name}: ${error.message}`));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name === 'alice' ? 'Alice' : 'Bob');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id && state.myProfile.updatedAt));
        return page;
    };
    try {
        const alice = await newPage('alice');
        const bob = await newPage('bob');
        const aliceId = await alice.evaluate(() => state.myProfile.id);
        const bobId = await bob.evaluate(() => state.myProfile.id);
        await bob.evaluate(async id => {
            await openChatWithPeer(id);
            document.getElementById('chat-input').value = 'hi';
            await sendChatMessage();
        }, aliceId);
        await waitFor(alice, id => (state.chats[id] || []).some(message => message.text === 'hi'), bobId);
        await alice.evaluate(id => openChatWithPeer(id), bobId);

        // Medien-Menue: GIF-Eintrag; die Auswahl fragt erst (Dialog wird bestaetigt), dann Bibliothek.
        await alice.click('#chat-media-btn');
        assert.ok(await alice.locator('#chat-media-gif').isVisible(), 'GIF sits in the media menu');
        await alice.click('#chat-media-gif');
        // Erster Reiter: Klipy (Pflicht-Platzhalter, Werbung nicht gezeigt), dann die Bibliothek.
        await alice.waitForSelector(`[data-gif-pick="${KLIPY_MEDIA}"]`, { timeout: 10000 });
        assert.equal(await alice.getAttribute('#gif-provider-search', 'placeholder'), 'Search KLIPY');
        assert.equal(await alice.locator('#gif-picker-body .gif-tile').count(), 1, 'ads are skipped');
        assert.ok(gifRequests.alice.some(url => url.startsWith('https://api.klipy.com/api/v1/e2e-test-key/gifs/trending')), 'provider api is called from the client');
        await alice.click('[data-gif-tab="library"]');
        await alice.waitForSelector(`[data-gif-pick="${GIF_HOST}/party.gif"]`, { timeout: 10000 });
        assert.equal(await alice.evaluate(() => gifSetting('enabled')), true, 'opening the picker asked and enabled gifs');
        await alice.click(`[data-gif-pick="${GIF_HOST}/party.gif"]`);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.gif?.url?.endsWith('/party.gif')), aliceId, 30000);
        const sent = await alice.evaluate(id => state.chats[id].find(message => message.gif).gif, bobId);
        assert.deepEqual(sent, { url: `${GIF_HOST}/party.gif`, source: 'library', w: 2, h: 2 }, 'only the url travels');

        // Bob: verschwommene Flaeche, nichts geladen, bis er zustimmt.
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await bob.waitForSelector('[data-gif-enable="enable"]', { timeout: 10000 });
        assert.deepEqual(gifRequests.bob, [], 'nothing is loaded before consent');
        await bob.click('[data-gif-enable="enable"]');
        await bob.waitForSelector('.gif-box img.gif-media', { timeout: 10000 });
        await waitFor(bob, () => [...document.querySelectorAll('.gif-box img.gif-media')].some(image => image.complete && image.naturalWidth === 2));
        // Bob hat den Proxy an: das GIF kommt ueber den Router, der fremde Server sieht Bob nicht.
        assert.ok(gifRequests.bob.some(url => url.includes('/api/gif-proxy?url=') && url.includes(encodeURIComponent('/party.gif'))), 'loaded through the proxy');
        assert.ok(!gifRequests.bob.some(url => url.startsWith(GIF_HOST)), 'never directly');
        // Bibliotheks-GIF melden.
        await bob.click(`.gif-box [data-gif-report="${GIF_HOST}/party.gif"]`);
        await waitFor(bob, url => document.querySelector(`.gif-box [data-gif-report="${url}"]`)?.disabled === true, `${GIF_HOST}/party.gif`);

        // Klipy-GIF: direkt vom Anbieter, auch bei Bob mit Proxy (Regeln des Anbieters).
        await alice.evaluate(() => openGifPicker());
        await alice.waitForSelector(`[data-gif-pick="${KLIPY_MEDIA}"]`, { timeout: 10000 });
        await alice.click(`[data-gif-pick="${KLIPY_MEDIA}"]`);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.gif?.source === 'provider'), aliceId, 30000);
        await waitFor(bob, url => [...document.querySelectorAll('.gif-box img.gif-media')].some(image => image.src === url && image.complete), KLIPY_MEDIA);
        assert.ok(gifRequests.bob.includes(KLIPY_MEDIA), 'provider media loads directly');

        // Externer Link: eigene Zustimmung beim Empfaenger; Vorschlag fuer die Bibliothek.
        await alice.evaluate(() => openGifPicker());
        await alice.click('[data-gif-tab="link"]');
        await alice.fill('#gif-link-input', 'https://127.0.0.1/x.gif');
        assert.ok(await alice.locator('#gif-link-error').isVisible(), 'ip addresses are refused');
        await alice.fill('#gif-link-input', `${OTHER_HOST}/dance.gif`);
        await alice.waitForFunction(() => !document.getElementById('gif-link-send').disabled, null, { timeout: 10000 });
        await alice.check('#gif-link-suggest');
        await alice.click('#gif-link-send');
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.gif?.source === 'url'), aliceId, 30000);
        await bob.waitForSelector('[data-gif-enable="external"]', { timeout: 10000 });
        assert.ok(!gifRequests.bob.some(url => url.includes('elsewhere')), 'external gif is not loaded without its own consent');
        await bob.click('[data-gif-enable="external"]');
        await waitFor(bob, () => document.querySelectorAll('.gif-box img.gif-media').length === 3);
        assert.equal(await bob.evaluate(() => document.getElementById('gif-external-toggle').checked), true, 'setting follows the consent');

        // Nur einen GIF-Link ins Eingabefeld eingefuegt: wird als GIF gesendet, nicht als Text.
        await alice.fill('#chat-input', PASTED);
        await alice.click('#send-chat-btn');
        await waitFor(alice, ([id, url]) => (state.chats[id] || []).some(message => message.gif?.url === url && !message.text), [bobId, PASTED], 15000);
        assert.equal(await alice.inputValue('#chat-input'), '', 'input cleared');
        await waitFor(bob, ([id, url]) => (state.chats[id] || []).some(message => message.gif?.url === url), [aliceId, PASTED], 30000);

        // Eigener Stern unten links, fremder unten rechts (oben liegt die Aktionsleiste).
        assert.equal(await alice.evaluate(url => document.querySelector(`.gif-box [data-gif-favorite="${url}"]`).classList.contains('is-left'), PASTED), true);
        assert.equal(await bob.evaluate(url => document.querySelector(`.gif-box [data-gif-favorite="${url}"]`).classList.contains('is-left'), PASTED), false);

        // Grosse Ansicht und Link kopieren (Kontextmenue).
        await bob.click(`.gif-box [data-gif-url="${PASTED}"]`);
        await bob.waitForSelector('#gif-viewer:not(.hidden) #gif-viewer-copy', { timeout: 5000 });
        const viewerBox = await bob.locator('#gif-viewer-stage img').boundingBox();
        const viewport = bob.viewportSize();
        assert.ok(viewerBox.width >= viewport.width - 2 || viewerBox.height >= viewport.height - 2, 'gif fills the screen like images');
        await bob.keyboard.press('Escape');
        await bob.waitForSelector('#gif-viewer', { state: 'hidden', timeout: 5000 });
        await bob.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        const messageId = await bob.evaluate(([id, url]) => state.chats[id].find(message => message.gif?.url === url).id, [aliceId, PASTED]);
        await bob.evaluate(id => openMessageMenu(id), messageId);
        await bob.waitForSelector('#message-menu .message-menu-items', { timeout: 5000 });
        await bob.locator('#message-menu button', { hasText: 'Link kopieren' }).click();
        assert.equal(await bob.evaluate(() => navigator.clipboard.readText()), PASTED, 'url copied');

        // Medien-Uebersicht: GIFs einblendbar.
        await bob.evaluate(() => openChatMediaOverview('all'));
        await bob.waitForSelector('#media-overview-gifs-toggle', { timeout: 5000 });
        assert.equal(await bob.locator('[data-gif-overview]').count(), 0, 'hidden until switched on');
        await bob.click('#media-overview-gifs-toggle');
        await bob.waitForSelector('[data-gif-overview]', { timeout: 5000 });
        assert.equal(await bob.locator('[data-gif-overview]').count(), 4);
        await bob.evaluate(() => closeMediaModal());

        // Favorit (auch extern) und Einstellungen.
        await bob.click(`[data-gif-favorite="${OTHER_HOST}/dance.gif"]`);
        assert.deepEqual(await bob.evaluate(() => gifState.favorites.map(item => item.url)), [`${OTHER_HOST}/dance.gif`]);
        assert.deepEqual(await alice.evaluate(() => gifState.recent.map(item => item.source)), ['url', 'url', 'provider', 'library']);
        assert.equal(await alice.evaluate(url => Boolean(gifState.index[url]), KLIPY_MEDIA), false, 'provider media is not cached');
        assert.equal(await bob.locator('#gif-settings-card').count(), 1);
        await bob.evaluate(() => updateGifSetting('enabled', false));
        await bob.waitForSelector('[data-gif-enable="enable"]', { timeout: 10000 });
        assert.equal(await bob.evaluate(() => gifSetting('external')), false, 'turning gifs off also turns external links off');

        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (gifs)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
