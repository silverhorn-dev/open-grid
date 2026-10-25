// End-to-End: Freunde im Chat-Modus. A addet B, B nimmt im Profil an, beide sind befreundet und sehen
// das volle Profil. Die Chatlisten sind getrennt: der Chat steht unter "Chat & Freunde", nicht im Grid-Modus.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
// Debug-Log der Seiten; wird nur bei einem Fehler ausgegeben.
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
        const page = await (await browser.newContext()).newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        page.on('console', message => { if (message.text().startsWith('[OpenGrid]')) debugLogs.push(`${Date.now() % 1000000} [${name}] ${message.text().slice(11, 200)}`); });
        page.on('dialog', dialog => dialog.accept());
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
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));

        // A schreibt B im Chat-Modus und addet B ueber das Profil.
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await alice.fill('#chat-input', 'hi bob');
        await alice.click('#send-chat-btn');
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'hi bob'), aliceId);
        assert.equal(await bob.evaluate(id => state.chatScopes[id], aliceId), 'social', 'chat lands in the social list');

        await alice.evaluate(id => openProfileModal(id), bobId);
        await alice.click('#modal-match-actions button:has-text("Adden")');
        await waitFor(alice, id => hasSentFriendRequest(id), bobId);
        await waitFor(bob, id => hasFriendRequest(id), aliceId);
        assert.match(await bob.textContent('#active-peers-list'), /hi bob|Moechte dich adden/);

        // B nimmt an.
        await bob.evaluate(id => openProfileModal(id), aliceId);
        await bob.click('#modal-match-actions button:has-text("Annehmen")');
        await waitFor(bob, id => isFriend(id), aliceId);
        await waitFor(alice, id => isFriend(id), bobId);

        // Getrennte Listen: im Grid-Modus taucht der Freundes-Chat nicht auf.
        await bob.evaluate(() => { closeProfileModal(); leaveActiveChat(); });
        await bob.evaluate(() => setAppMode('discovery'));
        assert.equal(await bob.evaluate(id => Boolean(document.querySelector('#active-peers-list')?.textContent.includes('Alice')), aliceId), false);
        await bob.evaluate(() => setAppMode('chat'));
        await waitFor(bob, () => document.querySelector('#active-peers-list')?.textContent.includes('Alice'));

        // Entfernen beendet die Freundschaft auf beiden Seiten.
        await alice.evaluate(id => resetFriendship(id), bobId);
        await waitFor(bob, id => !isFriend(id), aliceId);

        // Grid: erst nach einem Match adden, der Chat wandert dann nach "Chat & Freunde".
        const carol = await user('Carol');
        const dave = await user('Dave');
        await Promise.all([carol, dave].map(page => page.evaluate(() => setAppMode('discovery'))));
        const [carolId, daveId] = await Promise.all([carol, dave].map(page => page.evaluate(() => state.myProfile.id)));
        await carol.evaluate(id => openChatWithPeer(id), daveId);
        await carol.fill('#chat-input', 'hi dave');
        await carol.click('#send-chat-btn');
        await waitFor(dave, id => state.chatScopes[id] === 'discovery', carolId);
        await carol.evaluate(id => openProfileModal(id), daveId);
        assert.equal(await carol.isVisible('#modal-match-actions button:has-text("Adden")'), false, 'no add before a match');
        await carol.evaluate(id => sendFlame(id), daveId);
        await waitFor(dave, id => hasReceivedFlame(id), carolId);
        await dave.evaluate(id => sendFlame(id), carolId);
        await waitFor(carol, id => isMatched(id), daveId);
        // Dave schaltet "Matches koennen mich adden" ab: Carol bekommt mit dem Profil keinen Knopf.
        await dave.evaluate(() => updateMatchingSetting('matchFriends', false));
        await carol.evaluate(id => openProfileModal(id), daveId);
        await waitFor(carol, id => state.cachedProfiles[id]?.allowMatchFriends === false, daveId);
        await carol.evaluate(id => renderProfileMatchActions(id), daveId);
        assert.equal(await carol.isVisible('#modal-match-actions button:has-text("Adden")'), false, 'hidden by the profile flag');
        assert.equal(await carol.evaluate(id => state.cachedProfiles[id]?.chatPolicy?.mode, daveId), 'A', 'chat rules arrive with the profile');
        await dave.evaluate(() => updateMatchingSetting('matchFriends', true));
        await carol.evaluate(id => openProfileModal(id), daveId);
        await waitFor(carol, id => state.cachedProfiles[id]?.allowMatchFriends === true, daveId);
        await carol.evaluate(id => renderProfileMatchActions(id), daveId);
        await carol.click('#modal-match-actions button:has-text("Adden")');
        await waitFor(dave, id => hasFriendRequest(id), carolId);
        await dave.evaluate(id => addFriend(id), carolId);
        await waitFor(carol, id => isFriend(id), daveId);
        assert.equal(await dave.evaluate(id => chatScopeOf(id), carolId), 'social', 'chat moved to "Chat & Freunde"');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (friends)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(debugLogs.slice(-40).join('\n'));
    console.error('E2E FAILED', error);
    process.exit(1);
});
