// End-to-End: neuer Chat ohne bekanntes Profil (z. B. erste Nachricht ueber den Router-Cache, ohne
// P2P-Sitzung). Das Profil wird aktiv geholt, sobald der Absender online ist: Name in der Chatliste
// ohne Klick aufs Profil.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const debugLogs = [];

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
    async function user(name) {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        page.on('console', message => { if (message.text().startsWith('[OpenGrid]')) debugLogs.push(`[${name}] ${message.text().slice(11, 220)}`); });
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(() => { CONFIG.DEBUG_MODE = true; });
        await page.evaluate(() => setAppMode('chat'));
        return page;
    }

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const aliceId = await alice.evaluate(() => state.myProfile.id);
        const bobId = await bob.evaluate(() => state.myProfile.id);
        // Alice hat Bob geschrieben (ihr Chat existiert); Praesenz meldet der Server nur gegenseitig.
        await alice.evaluate(id => { state.chatScopes[id] = 'social'; rememberChatPeer(id); }, bobId);

        // Bob kennt Alice noch nicht und hat keine Verbindung zu ihr.
        assert.equal(await bob.evaluate(id => Boolean(state.cachedProfiles[id] || state.dataChannels[id]), aliceId), false);

        // Wie eine erste Nachricht ueber den Router-Cache: neuer Chat in Bobs Liste, ohne P2P.
        await bob.evaluate(id => {
            state.chatScopes[id] = 'social';
            state.chatPreviews[id] = { text: 'Hi Bob', at: Date.now(), mine: false };
            switchTab('chat');
            rememberChatPeer(id);
        }, aliceId);

        await waitFor(bob, id => state.cachedProfiles[id]?.fields?.displayName === 'Alice', aliceId);
        await waitFor(bob, () => document.getElementById('active-peers-list').textContent.includes('Alice'));
        assert.equal(await bob.evaluate(() => state.activeModalPeerId || null), null, 'no profile click needed');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (new chat profile)');
    } catch (error) {
        console.log(debugLogs.slice(-60).join('\n'));
        throw error;
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
