// End-to-End: Gruppen ueber die Oberflaeche (conversations.js, Board T36 P2a). Alice erstellt aus ihren Freunden
// eine Gruppe, Bob und Carol bekommen sie (signierter Zustand vom Admin), Nachrichten mit Absendernamen, Admin
// entfernt Carol, Bob tritt aus. Gruppen gibt es nur in Chat & Freunde (und Events).
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
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
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
        return page;
    }
    async function befriend(a, b) {
        const [aId, bId] = await Promise.all([a, b].map(page => page.evaluate(() => state.myProfile.id)));
        await a.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'hi'; await sendChatMessage(); }, bId);
        await waitFor(b, id => (state.chats[id] || []).length > 0, aId);
        await a.evaluate(id => addFriend(id), bId);
        await waitFor(b, id => hasFriendRequest(id), aId);
        await b.evaluate(id => addFriend(id), aId);
        await waitFor(a, id => isFriend(id), bId);
    }
    try {
        const [alice, bob, carol] = [await user('Alice'), await user('Bob'), await user('Carol')];
        const [aliceId, bobId, carolId] = await Promise.all([alice, bob, carol].map(page => page.evaluate(() => state.myProfile.id)));
        await befriend(alice, bob);
        await befriend(alice, carol);

        // Alice erstellt die Gruppe in der Chatliste.
        await alice.evaluate(() => { leaveActiveChat(); switchTab('chat'); });
        await alice.click('#group-create-open');
        await alice.fill('#group-name-input', 'Crew');
        await alice.check(`[data-group-candidate="${bobId}"]`);
        await alice.check(`[data-group-candidate="${carolId}"]`);
        await alice.click('#group-create-btn');
        await waitFor(alice, () => typeof isGroupId === 'function' && isGroupId(state.activeChatPeerId));
        const groupId = await alice.evaluate(() => state.activeChatPeerId);
        await waitFor(alice, () => document.getElementById('chat-peer-name').textContent === 'Crew'
            && /3 Mitglieder/.test(document.getElementById('chat-peer-status').textContent), null, 10000);

        // Bob und Carol bekommen die Gruppe.
        for (const page of [bob, carol]) await waitFor(page, id => Boolean(getGroup(id)) && state.chatPeerIds.includes(id), groupId, 45000);

        // Nachricht mit Absendername.
        await alice.fill('#chat-input', 'hallo crew');
        await alice.click('#send-chat-btn');
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'hallo crew'), groupId, 45000);
        await bob.evaluate(id => openChatWithPeer(id), groupId);
        await bob.waitForSelector(`#chat-messages [data-group-sender="${aliceId}"]`, { timeout: 10000 });
        await waitFor(bob, id => document.querySelector(`#chat-messages [data-group-sender="${id}"]`)?.textContent === 'Alice', aliceId, 10000);
        await waitFor(carol, id => (state.chats[id] || []).some(message => message.text === 'hallo crew'), groupId, 45000);
        // Kein Loeschen/Blockieren im Gruppen-Menue.
        assert.equal(await bob.evaluate(() => document.getElementById('block-peer-btn').classList.contains('hidden')), true);
        assert.equal(await bob.evaluate(() => document.getElementById('chat-menu-group').classList.contains('hidden')), false);

        // Nur Admins: Bob sieht keine Admin-Knoepfe.
        await bob.evaluate(() => chatMenuGroupInfo());
        await bob.waitForSelector('#group-leave-btn', { timeout: 5000 });
        assert.equal(await bob.locator('[data-group-remove]').count(), 0, 'no admin actions for members');
        await bob.evaluate(() => closeMediaModal());

        // Admin entfernt Carol.
        await alice.evaluate(() => chatMenuGroupInfo());
        await alice.click(`[data-group-remove="${carolId}"]`);
        await waitFor(carol, id => getGroup(id)?.removed === true, groupId, 45000);
        assert.equal(await carol.evaluate(id => getPeerChatAllowance(id).allowed, groupId), false, 'removed members cannot write');
        await waitFor(bob, ([id, removed]) => !getGroup(id).members.includes(removed), [groupId, carolId], 45000);

        // Bob tritt aus.
        await bob.evaluate(() => chatMenuGroupInfo());
        await bob.click('#group-leave-btn');
        await waitFor(bob, id => getGroup(id)?.left === true, groupId);
        await waitFor(alice, ([id, left]) => !getGroup(id).members.includes(left), [groupId, bobId], 45000);
        assert.deepEqual(await alice.evaluate(id => getGroup(id).members, groupId), [aliceId]);
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (groups)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
