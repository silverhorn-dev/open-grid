// End-to-End (nur Smartphone-Variante): Chatliste bleibt im Bildschirm und scrollt in sich,
// Kurzstatus steht in eigener Zeile, die Alben-Karte erscheint im Chat-Modus erst mit eigenem Album.
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
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext({ locale: 'de-DE', ...devices['iPhone 13'] })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Mobile');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));

        await page.evaluate(async () => {
            await setAppMode('chat');
            for (let index = 0; index < 25; index++) {
                const id = `node_fake_${index}`;
                state.friendState[id] = { sentAt: 2, receivedAt: 3, resetAt: 0 };
                state.cachedProfiles[id] = { fields: { displayName: `Freund ${index} mit einem sehr langen Namen` }, presenceText: 'Im Club bis spaet' };
                state.chatPeerIds.push(id);
                state.chatPreviews[id] = { text: `Nachricht ${index}`, at: Date.now() - index * 60000, mine: false };
            }
            switchTab('chat');
            renderActivePeerList();
        });
        await page.waitForTimeout(400);
        const layout = await page.evaluate(() => {
            const list = document.getElementById('active-peers-list');
            return { page: document.documentElement.scrollHeight, viewport: window.innerHeight, scrollable: list.scrollHeight > list.clientHeight };
        });
        assert.ok(layout.page <= layout.viewport + 2, `page does not scroll (${layout.page} > ${layout.viewport})`);
        assert.equal(layout.scrollable, true, 'the chat list scrolls itself');
        assert.equal(await page.isVisible('#active-peers-list >> text=Im Club bis spaet >> nth=0'), true, 'presence visible on mobile');

        // Auch wenn die Seite scrollt (z. B. ein- und ausfahrende Adressleiste), bleibt der Kopf der Liste stehen.
        await page.evaluate(() => { document.body.style.paddingBottom = '600px'; window.scrollTo(0, 400); });
        await page.waitForTimeout(200);
        const head = await page.evaluate(() => ({
            top: Math.round(document.getElementById('chat-list-head').getBoundingClientRect().top),
            header: Math.round(document.querySelector('header.app-header').getBoundingClientRect().bottom)
        }));
        assert.ok(Math.abs(head.top - head.header) <= 2, `list head stays pinned below the app header (${head.top} vs ${head.header})`);
        await page.evaluate(() => { document.body.style.paddingBottom = ''; window.scrollTo(0, 0); });

        // Offener Chat (fest ueber dem Bildschirm): auch wenn die Seite darunter gescrollt war und die
        // Kontaktleiste den aktuellen Chat in die Mitte holt, bleibt das Eingabefeld ganz sichtbar.
        await page.evaluate(async () => {
            document.body.style.paddingBottom = '600px';
            window.scrollTo(0, 300);
            await openChatWithPeer('node_fake_20');
        });
        await waitFor(page, () => document.querySelectorAll('#chat-switch-bar button').length > 5);
        await page.waitForTimeout(300);
        const chatBox = await page.evaluate(() => {
            const bar = document.querySelector('#chat-window-panel .chat-input-bar').getBoundingClientRect();
            return { top: bar.top, bottom: bar.bottom, height: window.innerHeight, offset: window.visualViewport ? window.visualViewport.offsetTop : 0 };
        });
        assert.ok(chatBox.top >= 0 && chatBox.bottom <= chatBox.height + 1, `chat input bar inside the screen (${chatBox.top}-${chatBox.bottom} of ${chatBox.height})`);
        assert.equal(chatBox.offset, 0, 'visual viewport not shifted');
        await page.evaluate(() => { document.body.style.paddingBottom = ''; window.scrollTo(0, 0); });
        await page.reload();
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        assert.equal(await page.evaluate(() => history.scrollRestoration), 'manual', 'no scroll restoration after reload');

        // Alben-Karte: im Chat-Modus ohne eigene Alben versteckt, mit Album sichtbar.
        await page.evaluate(() => switchTab('editprofile'));
        assert.equal(await page.isVisible('#album-manager-card'), false);
        await page.evaluate(async () => {
            await saveAlbum({ id: 'alb_m', ownerId: state.myProfile.id, name: 'Urlaub', items: [], acl: ['node_fake_1'], secret: createAlbumSecret(), keyVersion: 1 });
        });
        assert.equal(await page.isVisible('#album-manager-card'), true);
        await page.evaluate(() => setAppMode('discovery'));
        assert.equal(await page.isVisible('#album-manager-card'), true);

        // Menue: Modus direkt umschalten; Einstellungen ueber das Menue.
        await page.evaluate(() => openMenu());
        assert.equal(await page.locator('#menu-modes .menu-mode').count() >= 2, true, 'mode chips in the menu');
        assert.match(await page.textContent('#menu-modes .menu-mode.is-active'), /Entdecken/);
        await page.click('#menu-modes .menu-mode >> text=Nur Chat');
        await waitFor(page, () => state.appMode === 'chat');
        assert.match(await page.textContent('#menu-modes .menu-mode.is-active'), /Nur Chat/);
        await page.evaluate(() => closeMenu());

        // Zahnrad im Profil oeffnet die Einstellungen. Wischen: im Profil nach links = Menue; in den
        // Einstellungen seitlich = Bereiche blaettern, verlassen nur oben nach unten.
        // (Vorher war ein Chat offen: das Wischen zwischen Tabs muss trotzdem gehen.)
        await page.evaluate(() => switchTab('editprofile'));
        const cdp = await page.context().newCDPSession(page);
        // Ueber der Ueberschrift der Ansicht (Eingabefelder und Auswahlen nehmen selbst keine Tab-Wischer an).
        const drag = async (from, to) => {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
            for (let step = 1; step <= 8; step++) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (to.x - from.x) * step / 8, y: from.y + (to.y - from.y) * step / 8 }] });
                await page.waitForTimeout(16);
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await page.waitForTimeout(300);
        };
        const headingY = async () => {
            const heading = await page.locator('main section:not(.hidden) h2').first().boundingBox();
            return heading.y + heading.height / 2;
        };
        const swipe = async (fromX, toX) => {
            const y = await headingY();
            await drag({ x: fromX, y }, { x: toX, y });
        };
        // Das Menue vom vorigen Schritt faehrt noch heraus und laege sonst unter dem Finger.
        await page.waitForTimeout(800);
        // Grid: oben nach unten ziehen = aktualisieren (kurz ziehen tut nichts).
        await page.evaluate(() => { switchTab('grid'); window.scrollTo(0, 0); window.__refreshes = 0; refreshGrid = async () => { window.__refreshes += 1; }; });
        await page.waitForTimeout(300);
        const statusLine = await page.locator('.grid-status-line').boundingBox();
        await drag({ x: 200, y: statusLine.y + 10 }, { x: 200, y: statusLine.y + 40 });
        assert.equal(await page.evaluate(() => window.__refreshes), 0, 'short pull does nothing');
        await drag({ x: 200, y: statusLine.y + 10 }, { x: 200, y: statusLine.y + 220 });
        await waitFor(page, () => window.__refreshes === 1);
        assert.equal(await page.evaluate(() => document.getElementById('grid-pull-refresh').style.height), '0px', 'indicator closes');
        await page.evaluate(() => switchTab('editprofile'));
        await page.waitForTimeout(300);

        await swipe(330, 80);
        await waitFor(page, () => document.getElementById('app-menu').classList.contains('is-open'));
        assert.equal(await page.evaluate(() => document.getElementById('view-editprofile').classList.contains('hidden')), false, 'profile stays');
        // Menue nach rechts wischen = schliessen.
        await page.waitForTimeout(400);
        const menuBox = await page.locator('#app-menu').boundingBox();
        await drag({ x: menuBox.x + 60, y: menuBox.y + menuBox.height / 2 }, { x: menuBox.x + 260, y: menuBox.y + menuBox.height / 2 });
        await waitFor(page, () => !document.getElementById('app-menu').classList.contains('is-open'));
        await page.waitForTimeout(800);

        // Eigenes Profil: Wischen darf auf einem (nicht fokussierten) Eingabefeld starten.
        const field = page.locator('#view-editprofile input[type="text"], #view-editprofile textarea').first();
        await field.evaluate(element => { element.blur(); element.scrollIntoView({ block: 'center' }); });
        await page.waitForTimeout(200);
        const fieldBox = await field.boundingBox();
        await drag({ x: Math.min(330, fieldBox.x + fieldBox.width - 10), y: fieldBox.y + fieldBox.height / 2 }, { x: 60, y: fieldBox.y + fieldBox.height / 2 });
        await waitFor(page, () => document.getElementById('app-menu').classList.contains('is-open'));
        await page.evaluate(() => { closeMenu(); window.scrollTo(0, 0); });
        await page.waitForTimeout(800);

        await page.click('#profile-settings-btn');
        await waitFor(page, () => !document.getElementById('view-keys').classList.contains('hidden'));
        assert.equal(await page.evaluate(() => document.querySelector('[data-tab-btn="editprofile"][data-nav="bottom"]').classList.contains('is-active')), true, 'profile stays highlighted');
        await page.evaluate(() => switchSettingsTab('general'));
        await swipe(330, 80);
        await waitFor(page, () => state.settingsTab === 'privacy');
        await swipe(80, 330);
        await waitFor(page, () => state.settingsTab === 'general');
        // Wischen darf auf einem Schalter starten (der reagiert auf Tippen) und schaltet ihn nicht um.
        await page.evaluate(() => switchSettingsTab('chat'));
        await page.evaluate(() => document.getElementById('chat-swipe-close-toggle').scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(200);
        const toggle = await page.locator('#chat-swipe-close-toggle').boundingBox();
        const toggleBefore = await page.evaluate(() => document.getElementById('chat-swipe-close-toggle').checked);
        await drag({ x: toggle.x + toggle.width / 2, y: toggle.y + toggle.height / 2 }, { x: toggle.x + toggle.width / 2 - 240, y: toggle.y + toggle.height / 2 });
        await waitFor(page, () => state.settingsTab === 'media');
        assert.equal(await page.evaluate(() => document.getElementById('chat-swipe-close-toggle').checked), toggleBefore, 'switch unchanged');
        // Am ersten Bereich nach rechts = Einstellungen verlassen.
        await page.evaluate(() => switchSettingsTab('general'));
        await swipe(80, 330);
        await waitFor(page, () => !document.getElementById('view-editprofile').classList.contains('hidden'));
        await page.click('#profile-settings-btn');
        await waitFor(page, () => !document.getElementById('view-keys').classList.contains('hidden'));
        await page.evaluate(() => { switchSettingsTab('privacy'); window.scrollTo(0, 0); });
        const y = await headingY();
        await drag({ x: 200, y }, { x: 200, y: y + 260 });
        await waitFor(page, () => !document.getElementById('view-editprofile').classList.contains('hidden'));

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (mobile layout)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
