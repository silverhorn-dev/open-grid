// End-to-End: Kontextmenue einer Nachricht (Reaktionen + Aktionen). Desktop: Rechtsklick und "mehr"
// in der Hover-Leiste; mobil: langes Druecken. Regressionen: (1) ein Neuzeichnen des Chats (neue
// Nachricht, Reaktion) schloss das Menue; (2) nach mehreren Aktionen hintereinander ging das naechste
// Menue gleich wieder zu (verspaeteter Zurueck-Schritt des vorherigen).
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function waitFor(page, predicate, arg, timeout = 20000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await page.evaluate(predicate, arg).catch(() => false)) return;
        await page.waitForTimeout(150);
    }
    throw new Error(`Timed out waiting for ${predicate}`);
}

async function main() {
    if (process.env.OFFLINE) return;
    const mobile = Boolean(process.env.MOBILE);
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const context = await browser.newContext({ locale: 'de-DE', ...(mobile ? devices['Pixel 7'] : { viewport: { width: 1000, height: 800 } }) });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Menu');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        await page.evaluate(async () => {
            await setAppMode('chat');
            const id = 'node_fake_menu';
            state.chatScopes[id] = 'social';
            state.cachedProfiles[id] = { fields: { displayName: 'Alice' } };
            state.chatPeerIds.push(id);
            switchTab('chat');
            await openChatWithPeer(id);
            state.chats[id] = [];
            for (const n of [1, 2, 3]) {
                const message = {
                    id: `m${n}`, senderId: n === 2 ? state.myProfile.id : id, text: `Nachricht ${n}`,
                    createdAt: Date.now() - (5 - n) * 1000, timestamp: '12:00'
                };
                state.chats[id].push(message);
                await persistChatMessage(id, message);
            }
            renderChatHistory();
        });
        await page.waitForTimeout(300);

        const cdp = mobile ? await context.newCDPSession(page) : null;
        const centre = async selector => {
            const box = await page.locator(selector).boundingBox();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        };
        const openMenu = async messageId => {
            const point = await centre(`#chat-message-${messageId} .chat-bubble`);
            if (mobile) {
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
                await page.waitForTimeout(600);
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            } else {
                await page.mouse.click(point.x, point.y, { button: 'right' });
            }
            await waitFor(page, id => document.getElementById('message-menu')?.dataset.messageId === id, messageId, 5000);
        };
        const menuOpen = () => page.evaluate(() => Boolean(document.getElementById('message-menu')));

        // Fremde Nachricht: 6 Reaktionen, Antworten/Kopieren/Markieren, kein Loeschen.
        await openMenu('m1');
        const content = await page.evaluate(() => ({
            reactions: document.querySelectorAll('#message-menu .message-menu-reaction').length,
            items: [...document.querySelectorAll('#message-menu .message-menu-item span')].map(item => item.textContent),
            highlighted: document.getElementById('chat-message-m1').classList.contains('message-menu-target')
        }));
        assert.equal(content.reactions, 6);
        assert.deepEqual(content.items, ['Antworten', 'Kopieren', 'Für dich markieren']);
        assert.equal(content.highlighted, true);

        // (1) Neuzeichnen und eine neue Nachricht: Menue bleibt, Markierung wandert mit.
        await page.evaluate(() => {
            renderChatHistory();
            state.chats.node_fake_menu.push({ id: 'm4', senderId: 'node_fake_menu', text: 'neu', createdAt: Date.now(), timestamp: '12:01' });
            renderChatHistory();
        });
        await page.waitForTimeout(300);
        assert.equal(await menuOpen(), true, 'a re-render keeps the menu open');
        assert.equal(await page.evaluate(() => document.getElementById('chat-message-m1').classList.contains('message-menu-target')), true);

        // Reagieren schliesst das Menue und setzt die Reaktion.
        await page.evaluate(() => {
            window.reactCalls = [];
            const original = reactToMessage;
            window.reactToMessage = (...args) => { window.reactCalls.push(args); return original(...args); };
        });
        await page.click('#message-menu .message-menu-reaction:nth-child(1)');
        await waitFor(page, () => !document.getElementById('message-menu'));
        await page.waitForTimeout(300);
        assert.ok(await page.evaluate(() => state.chats.node_fake_menu.find(message => message.id === 'm1').reactions?.[state.myProfile.id]?.emoji),
            `reaction set: ${await page.evaluate(() => JSON.stringify(window.reactCalls))}`);

        // (2) Mehrere Aktionen hintereinander, jedes neue Menue bleibt offen.
        for (const messageId of ['m3', 'm2', 'm1']) {
            await openMenu(messageId);
            await page.waitForTimeout(700);
            assert.equal(await menuOpen(), true, `menu for ${messageId} stays open after earlier actions`);
            await page.click('#message-menu .message-menu-item:has(.fa-star)');
            await waitFor(page, () => !document.getElementById('message-menu'));
        }
        assert.equal(await page.evaluate(() => state.chats.node_fake_menu.filter(message => message.starred).length), 3);

        // Eigene Nachricht: mit Loeschen; schliessen per Tipp daneben bzw. Esc / Zurueck.
        await openMenu('m2');
        assert.match(await page.textContent('#message-menu'), /Löschen/);
        await page.mouse.click(5, 5);
        await waitFor(page, () => !document.getElementById('message-menu'));
        await openMenu('m2');
        if (mobile) await page.goBack();
        else await page.keyboard.press('Escape');
        await waitFor(page, () => !document.getElementById('message-menu'));
        assert.equal(await page.evaluate(() => state.activeChatPeerId), 'node_fake_menu', 'closing the menu does not leave the chat');

        if (!mobile) {
            // Hover-Leiste: "mehr" oeffnet dasselbe Menue.
            // Headless-Chromium meldet "hover: none" (Touch-Ansicht mit Pfeil); echte Desktops die Leiste.
            await page.hover('#chat-message-m3 .chat-bubble');
            const noHover = await page.evaluate(() => matchMedia('(hover: none)').matches);
            await page.click(noHover ? '#chat-message-m3 .message-actions-toggle' : '#chat-message-m3 .message-action[aria-label="Weitere Aktionen"]', { timeout: 5000 });
            await waitFor(page, () => document.getElementById('message-menu')?.dataset.messageId === 'm3');
        }

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log(`E2E OK (message menu${mobile ? ', mobile' : ''})`);
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
