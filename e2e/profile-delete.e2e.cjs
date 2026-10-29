// End-to-End: Profil loeschen. Alice loescht ihr Profil: bei Bob (online) und Carol (offline, spaeter ueber
// Pfad C) verschwinden Verlauf und Bilder, der Chat bleibt mit "Profil wurde geloescht", schreiben geht nicht
// mehr. Alice ist aus dem Grid verschwunden, ihre App startet mit dem Onboarding.
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
    async function user(name) {
        const context = await browser.newContext({ locale: 'de-DE' });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(() => setAppMode('chat'));
        return { context, page };
    }

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const carol = await user('Carol');
        const [aliceId, bobId, carolId] = await Promise.all([alice.page, bob.page, carol.page].map(page => page.evaluate(() => state.myProfile.id)));
        for (const [other, otherId] of [[bob, bobId], [carol, carolId]]) {
            await alice.page.evaluate(id => openChatWithPeer(id), otherId);
            await alice.page.fill('#chat-input', `hallo ${otherId}`);
            await alice.page.click('#send-chat-btn');
            await waitFor(other.page, id => (state.chats[id] || []).length > 0, aliceId);
        }

        // Carol geht offline (App zu, Daten bleiben), dann loescht Alice ihr Profil.
        await carol.page.close();
        await alice.page.evaluate(() => { switchTab('keys'); switchSettingsTab('general'); });
        await alice.page.click('#delete-profile-btn');
        await waitFor(alice.page, () => !document.getElementById('profile-onboarding-modal').classList.contains('hidden'), null, 30000);
        assert.equal(await alice.page.evaluate(() => (state.chatPeerIds || []).length), 0, 'fresh start without chats');

        // Bob (online): nur noch die Zeile, schreiben gesperrt, Liste zeigt den Hinweis.
        await waitFor(bob.page, id => { const messages = state.chats[id] || []; return messages.length === 1 && messages[0].system === 'profileDeleted'; }, aliceId);
        await bob.page.evaluate(id => openChatWithPeer(id), aliceId);
        await waitFor(bob.page, () => document.querySelector('#chat-messages .chat-system-note')?.textContent === 'Profil wurde gelöscht');
        assert.equal(await bob.page.isDisabled('#chat-input'), true, 'cannot write any more');
        assert.equal(await bob.page.evaluate(async id => (await getDatabaseRecordsByIndex('messages', 'peerId', id)).length, aliceId), 1, 'history deleted in the database');
        assert.match(await bob.page.textContent('#active-peers-list'), /Profil wurde gelöscht/);
        // Router: Alice ist weg.
        assert.equal(await bob.page.evaluate(async id => {
            const response = await fetch(`/api/grid?geohash=${state.myProfile.geohash}`);
            return (await response.json()).peers.some(peer => peer.id === id);
        }, aliceId), false, 'gone from the grid');

        // Carol kommt zurueck: der Hinweis liegt im Router-Cache.
        const page = await carol.context.newPage();
        page.on('pageerror', error => pageErrors.push(`[Carol] ${error.message}`));
        await page.goto(`${BASE_URL}/`);
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await waitFor(page, async id => { await fetchQueuedCacheMessages(); const messages = state.chats[id] || []; return messages.length === 1 && messages[0].system === 'profileDeleted'; }, aliceId);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (profile delete)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
