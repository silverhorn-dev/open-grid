// End-to-End: Standardwerte vom Router (CLIENT_DEFAULTS ueber /api/config) und der Listen-Wechsel
// zwischen "Grid & Event" und "Chat & Freunde" in beiden Varianten ("nur Liste ansehen", "Modus wechseln").
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

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
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        // Betreiber-Standards: Quick-Switcher beim Hochziehen, Listen-Wechsel "nur ansehen".
        await page.route('**/api/config', async route => {
            const response = await route.fetch();
            const config = await response.json();
            await route.fulfill({ response, json: { ...config, clientDefaults: { pullUpAction: 'switcher', listSwitchBehavior: 'view' } } });
        });
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Lister');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        assert.equal(await page.evaluate(() => state.pullUpAction), 'switcher', 'router default applied');
        assert.equal(await page.evaluate(() => state.listSwitchSettings.behavior), 'view');

        await page.evaluate(async () => {
            // Echte (gespeicherte) Chats, damit ein spaeteres Neuladen der Chatliste sie behaelt.
            await persistChatMessage('node_grid', { id: 'g1', peerId: 'node_grid', senderId: 'node_grid', text: 'hi', timestamp: '10:00', createdAt: 1, scope: 'discovery' });
            await persistChatMessage('node_friend', { id: 'f1', peerId: 'node_friend', senderId: 'node_friend', text: 'hey', timestamp: '10:00', createdAt: 2, scope: 'social' });
            await setChatScope('node_grid', 'discovery');
            await setChatScope('node_friend', 'social');
            await loadChatPeerIds();
            state.cachedProfiles.node_grid = { fields: { displayName: 'Grid-Kontakt' } };
            state.cachedProfiles.node_friend = { fields: { displayName: 'Freundes-Chat' } };
            await setAppMode('discovery');
            switchTab('chat');
        });
        const listText = () => page.textContent('#active-peers-list');
        assert.match(await listText(), /Grid-Kontakt/);
        assert.doesNotMatch(await listText(), /Freundes-Chat/);

        // "Nur Liste ansehen": andere Liste, Modus bleibt, daneben "Modus wechseln".
        await page.click('#chat-list-switch');
        assert.match(await listText(), /Freundes-Chat/);
        assert.equal(await page.evaluate(() => state.appMode), 'discovery');
        assert.match(await page.textContent('#chat-list-scope'), /Chat & Freunde/);
        assert.equal(await page.isVisible('#chat-list-mode-btn'), true);
        // Tab-Wechsel fuehrt zur Liste des Modus zurueck.
        await page.evaluate(() => { switchTab('editprofile'); switchTab('chat'); });
        assert.match(await listText(), /Grid-Kontakt/);
        // "Modus wechseln" aus der angesehenen Liste.
        await page.click('#chat-list-switch');
        await page.click('#chat-list-mode-btn');
        await waitFor(page, () => ['chat', 'friends'].includes(state.appMode));
        assert.match(await listText(), /Freundes-Chat/);

        // Variante "Modus wechseln": der Knopf wechselt direkt zurueck zu Grid & Event.
        await page.evaluate(() => updateListSwitchSetting('behavior', 'mode'));
        await page.click('#chat-list-switch');
        await waitFor(page, () => state.appMode === 'discovery');
        assert.match(await listText(), /Grid-Kontakt/);

        // Abschaltbar.
        await page.evaluate(() => updateListSwitchSetting('enabled', false));
        assert.equal(await page.isVisible('#chat-list-switch'), false);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (list switch, router defaults)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
