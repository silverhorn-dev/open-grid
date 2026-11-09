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
            await route.fulfill({ response, json: { ...config, gifs: { sources: ['library', 'url'], review: true } } });
        });
        await context.route('**/api/gifs**', route => (route.request().method() === 'GET'
            ? route.fulfill({ json: { gifs: [{ id: 1, url: `${GIF_HOST}/party.gif`, title: 'Party', width: 2, height: 2 }], next: null } })
            : route.fulfill({ status: 201, json: { status: 'pending', gif: { id: 2 } } })));
        for (const host of [GIF_HOST, OTHER_HOST]) {
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
        assert.ok(gifRequests.bob.some(url => url.endsWith('/party.gif')));

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
        await waitFor(bob, () => document.querySelectorAll('.gif-box img.gif-media').length === 2);
        assert.equal(await bob.evaluate(() => document.getElementById('gif-external-toggle').checked), true, 'setting follows the consent');

        // Favorit (auch extern) und Einstellungen.
        await bob.click(`[data-gif-favorite="${OTHER_HOST}/dance.gif"]`);
        assert.deepEqual(await bob.evaluate(() => gifState.favorites.map(item => item.url)), [`${OTHER_HOST}/dance.gif`]);
        assert.deepEqual(await alice.evaluate(() => gifState.recent.map(item => item.source)), ['url', 'library']);
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
