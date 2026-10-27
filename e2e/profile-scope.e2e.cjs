// End-to-End: welches Profil ein Kontakt bekommt, haengt an der Liste des Chats, nicht am gerade
// aktiven Modus. Alice ist in "Entdecken" (Dating-Profil mit Alter), Bob schreibt ihr aus "Nur Chat":
// Bob bekommt nur ihr Chat-Profil (Name, Status), kein Alter.
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
    async function user(name, mode) {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(m => setAppMode(m), mode);
        return page;
    }

    try {
        const alice = await user('Alice', 'discovery');
        await alice.evaluate(() => {
            state.myProfile.fields = { ...state.myProfile.fields, age: 31, status: 'Bin da' };
        });
        const bob = await user('Bob', 'chat');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        assert.deepEqual(await bob.evaluate(() => PROFILE_SCHEMAS.chat.map(field => field.key)), ['displayName', 'status'], 'chat schema from the router');

        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await bob.evaluate(() => { document.getElementById('chat-input').value = 'hi'; return sendChatMessage(); });
        await waitFor(alice, id => (state.chats[id] || []).some(message => message.text === 'hi'), bobId);
        assert.equal(await alice.evaluate(id => state.chatScopes[id], bobId), 'social');
        assert.equal(await alice.evaluate(() => state.appMode), 'discovery', 'Alice is still exploring');

        await bob.evaluate(id => { delete state.cachedProfiles[id]; return sendSecurePayload(id, { type: 'PROFILE_REQUEST' }); }, aliceId);
        await waitFor(bob, id => Boolean(state.cachedProfiles[id]?.fields?.displayName), aliceId);
        const fields = await bob.evaluate(id => state.cachedProfiles[id].fields, aliceId);
        assert.equal(fields.age, undefined, `no dating details for a chat contact: ${JSON.stringify(fields)}`);
        assert.equal(fields.status, 'Bin da');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (profile scope)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
