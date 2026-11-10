// End-to-End: Gruppen-Kern (conversations.js, Board T36 P1). Die Gruppe wird hier direkt angelegt (Anlegen und
// Oberflaeche folgen in P2). Alice schreibt in die Gruppe; Bob und Carol bekommen die Nachricht in der Gruppe
// (nicht im 1:1-Chat), signiert und mit der Gruppe in der Operation. Ein Nicht-Mitglied kann nichts einschleusen.
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
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        return page;
    }
    try {
        const [alice, bob, carol, mallory] = [await user('Alice'), await user('Bob'), await user('Carol'), await user('Mallory')];
        const [aliceId, bobId, carolId, malloryId] = await Promise.all([alice, bob, carol, mallory].map(page => page.evaluate(() => state.myProfile.id)));
        const group = { id: 'group_e2e00000-1111-2222-3333-444455556666', name: 'Crew', members: [aliceId, bobId, carolId], admins: [aliceId], createdAt: Date.now() };
        for (const page of [alice, bob, carol]) await page.evaluate(async g => { await saveGroup(g); rememberChatPeer(g.id); }, group);

        await alice.evaluate(async id => {
            state.activeChatPeerId = id;
            document.getElementById('chat-input').value = 'hallo gruppe';
            await sendChatMessage();
        }, group.id);
        for (const [page, name] of [[bob, 'bob'], [carol, 'carol']]) {
            await waitFor(page, gid => (state.chats[gid] || []).some(message => message.text === 'hallo gruppe'), group.id, 45000)
                .catch(error => { throw new Error(`${name}: ${error.message}`); });
        }
        const received = await bob.evaluate(async ([gid, sender]) => ({
            inGroup: (state.chats[gid] || []).find(message => message.text === 'hallo gruppe')?.senderId === sender,
            inOneToOne: (state.chats[sender] || []).some(message => message.text === 'hallo gruppe'),
            operation: (await getChatOperations(gid)).find(operation => operation.type === 'MESSAGE_PUT')
        }), [group.id, aliceId]);
        assert.equal(received.inGroup, true, 'stored in the group with the real sender');
        assert.equal(received.inOneToOne, false, 'not in the 1:1 chat');
        assert.equal(received.operation.conversationId, group.id);
        assert.equal(typeof received.operation.sig, 'string', 'signed');

        // Bob antwortet, Alice und Carol sehen es in der Gruppe.
        await bob.evaluate(async id => {
            state.activeChatPeerId = id;
            document.getElementById('chat-input').value = 'hi crew';
            await sendChatMessage();
        }, group.id);
        await waitFor(alice, gid => (state.chats[gid] || []).some(message => message.text === 'hi crew'), group.id, 45000);
        await waitFor(carol, gid => (state.chats[gid] || []).some(message => message.text === 'hi crew'), group.id, 45000);

        // Mallory (kein Mitglied) schickt Bob eine "Gruppen"-Nachricht: verworfen.
        await mallory.evaluate(async ([gid, target]) => {
            const operation = { operationId: 'put:evil-1', type: 'MESSAGE_PUT', messageId: 'evil-1', actorId: state.myProfile.id, createdAt: Date.now(),
                conversationId: gid, message: { id: 'evil-1', senderId: state.myProfile.id, text: 'eingeschleust', timestamp: '12:00', createdAt: Date.now() } };
            await sendSecurePayload(target, { type: 'CHAT_OPERATION', operation, conversationId: gid });
        }, [group.id, bobId]);
        await bob.waitForTimeout(8000);
        assert.equal(await bob.evaluate(gid => (state.chats[gid] || []).some(message => message.text === 'eingeschleust'), group.id), false, 'non-members cannot write into a group');
        assert.equal(await bob.evaluate(id => (state.chats[id] || []).some(message => message.text === 'eingeschleust'), malloryId), false, 'nor land in the 1:1 chat');
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (groups core)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
