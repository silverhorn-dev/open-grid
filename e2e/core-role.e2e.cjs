// End-to-End: Kern-Seite der Android-App (documentation/ANDROID-APP.md, "Kern im Hintergrund", K1). /core.html ist
// dieselbe App-Shell mit Rolle "core": ohne Bedienung ein vollwertiger Knoten (Router-Verbindung, P2P, empfangen
// und speichern, eigenes Profil ausliefern). Ohne eigenes Profil bleibt der Kern still (kein Einrichten).
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
    const watch = (page, name) => page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
    try {
        // Ohne Profil: der Kern richtet nichts ein und verbindet sich nicht.
        const empty = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        watch(empty, 'empty-core');
        await empty.goto(`${BASE_URL}/core.html`);
        await empty.waitForTimeout(3000);
        assert.equal(await empty.evaluate(() => APP_ROLE), 'core');
        assert.equal(await empty.evaluate(() => Boolean(state.ws)), false, 'no connection without a profile');
        assert.equal(await empty.evaluate(async () => Boolean(await databaseRequest('localProfile', 'readonly', store => store.get('current')))), false, 'no profile created');

        // Alice richtet die App ein (normale Seite), dann laeuft nur noch ihr Kern.
        const aliceContext = await browser.newContext({ locale: 'de-DE' });
        const setup = await aliceContext.newPage();
        watch(setup, 'alice-ui');
        await setup.goto(`${BASE_URL}/`);
        await setup.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = setup.locator('#onboarding-profile-form input').first();
        await input.fill('Alice');
        await input.dispatchEvent('change');
        await setup.click('#complete-onboarding-btn');
        await waitFor(setup, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        const aliceId = await setup.evaluate(() => state.myProfile.id);
        assert.equal(await setup.evaluate(() => APP_ROLE), 'full', 'normal page keeps the full role');
        await setup.close();

        const core = await aliceContext.newPage();
        watch(core, 'alice-core');
        await core.goto(`${BASE_URL}/core.html`);
        await waitFor(core, id => APP_ROLE === 'core' && state.myProfile.id === id && state.ws?.readyState === 1, aliceId);
        assert.equal(await core.evaluate(() => isAppActive()), true, 'core always works, visible or not');

        // Bob schreibt Alice: der Kern nimmt an und speichert (IndexedDB).
        const bob = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        watch(bob, 'bob');
        await bob.goto(`${BASE_URL}/`);
        await bob.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const bobInput = bob.locator('#onboarding-profile-form input').first();
        await bobInput.fill('Bob');
        await bobInput.dispatchEvent('change');
        await bob.click('#complete-onboarding-btn');
        await waitFor(bob, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        const bobId = await bob.evaluate(() => state.myProfile.id);
        await bob.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'an den kern'; await sendChatMessage(); }, aliceId);
        await waitFor(core, async id => (await getDatabaseRecordsByIndex('messages', 'peerId', id)).some(message => message.text === 'an den kern'), bobId, 45000);
        // Ueber P2P (nicht nur ueber den Zwischenspeicher): der Kern haelt den Kanal.
        await waitFor(core, id => isSecureChannelOpen(id), bobId, 30000);

        // Bob holt Alices Profil direkt beim Kern.
        await bob.evaluate(id => { delete state.cachedProfiles[id]; requestMissingProfile(id); }, aliceId);
        // Anfragen sind gedrosselt: bis zur Antwort ab und zu erneut fragen.
        await waitFor(bob, id => {
            if (state.cachedProfiles[id]?.fields?.displayName === 'Alice') return true;
            if (!window.lastProfileAsk || Date.now() - window.lastProfileAsk > 5000) {
                window.lastProfileAsk = Date.now();
                if (isSecureChannelOpen(id)) sendSecurePayload(id, { type: 'PROFILE_REQUEST' }).catch(() => {});
                else requestMissingProfile(id);
            }
            return false;
        }, aliceId, 45000);

        // Antwort des Kerns kommt bei Bob an (Senden aus dem Kern).
        await core.evaluate(async id => {
            state.activeChatPeerId = id;
            document.getElementById('chat-input').value = 'vom kern';
            await sendChatMessage();
        }, bobId);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'vom kern'), aliceId, 30000);
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (core role)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
