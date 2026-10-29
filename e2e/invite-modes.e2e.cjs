// End-to-End: Einladungslinks merken sich den Modus. Alice laedt aus "Entdecken" ein:
//   - Bob (alle Bereiche, gerade im Chat-Modus) landet im Entdecken-Modus, der Chat in "Grid & Event";
//     seine Nachricht landet bei Alice in derselben Liste.
//   - Carol (nur "Social") hat den Bereich aus: es oeffnet sich nichts, nur ein Hinweis.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

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
    async function user(name, setup) {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await noPrefetch(page);
        await page.evaluate(setup);
        return page;
    }
    // Kein Profil-Prefetch im Hintergrund (grid-filter.js): unter Last baute er sonst gelegentlich parallel
    // eine Verbindung auf, und die Einladungs-Nachricht kam nicht rechtzeitig an.
    const noPrefetch = page => page.evaluate(() => { window.prefetchGridProfiles = () => {}; });
    const open = async (page, link) => {
        await page.goto(`${BASE_URL}${new URL(link).pathname}${new URL(link).hash}`);
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1));
        await noPrefetch(page);
    };

    try {
        const alice = await user('Alice', () => setAppMode('discovery'));
        const aliceId = await alice.evaluate(() => state.myProfile.id);
        const link = await alice.evaluate(() => getMyInviteLink());
        assert.match(link, /~discovery$/);

        const bob = await user('Bob', () => setAppMode('chat'));
        const bobId = await bob.evaluate(() => state.myProfile.id);
        await open(bob, link);
        await waitFor(bob, id => state.activeChatPeerId === id, aliceId);
        assert.equal(await bob.evaluate(() => state.appMode), 'discovery', 'switched to the mode of the invite');
        assert.equal(await bob.evaluate(id => state.chatScopes[id], aliceId), 'discovery');
        await bob.evaluate(() => { document.getElementById('chat-input').value = 'hallo aus der einladung'; return sendChatMessage(); });
        await waitFor(alice, id => (state.chats[id] || []).some(message => message.text === 'hallo aus der einladung'), bobId);
        assert.equal(await alice.evaluate(id => state.chatScopes[id], bobId), 'discovery', 'same list at the inviter');
        assert.equal(await alice.evaluate(id => isInCurrentChatList(id), bobId), true, 'visible in her current list');

        const carol = await user('Carol', () => setModeScope('social'));
        await open(carol, link);
        await carol.waitForTimeout(2500);
        assert.match(await carol.textContent('body'), /Diese Einladung ist für „Entdecken“/);
        assert.equal(await carol.evaluate(id => state.chatPeerIds.includes(id), aliceId), false, 'nothing opened');
        assert.equal(await carol.evaluate(() => state.activeChatPeerId), null);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (invite modes)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
