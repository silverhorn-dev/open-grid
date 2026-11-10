// End-to-End: Verlauf und Abgleich in Gruppen (conversations.js, delivery.client.js, Board T36 P2b).
// - Carol wird mit "letzte 50 Nachrichten" hinzugefuegt und bekommt den bisherigen Verlauf per Gruppen-Sync.
// - Dave wird ohne Verlauf hinzugefuegt: nichts Altes, aber neue Nachrichten.
// - Bob war offline, ohne Zwischenspeicher: verpasste Gruppen-Nachrichten kommen ueber den Gruppen-Sync.
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
    const contexts = {};
    async function user(name, onboard = true) {
        contexts[name] = contexts[name] || await browser.newContext({ locale: 'de-DE' });
        const page = await contexts[name].newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(`${BASE_URL}/`);
        if (onboard) {
            await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
            const input = page.locator('#onboarding-profile-form input').first();
            await input.fill(name);
            await input.dispatchEvent('change');
            await page.click('#complete-onboarding-btn');
        }
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
    const say = (page, groupId, text) => page.evaluate(async ([id, value]) => {
        state.activeChatPeerId = id;
        document.getElementById('chat-input').value = value;
        await sendChatMessage();
    }, [groupId, text]);
    const texts = (page, groupId) => page.evaluate(id => (state.chats[id] || []).map(message => message.text).filter(Boolean), groupId);
    try {
        let bob;
        const alice = await user('Alice');
        bob = await user('Bob');
        const carol = await user('Carol');
        const dave = await user('Dave');
        const [bobId, carolId, daveId] = await Promise.all([bob, carol, dave].map(page => page.evaluate(() => state.myProfile.id)));
        for (const other of [bob, carol, dave]) await befriend(alice, other);

        const groupId = await alice.evaluate(async id => (await createGroup('Verlauf', [id])).id, bobId);
        await waitFor(bob, id => Boolean(getGroup(id)), groupId, 45000);
        for (const text of ['alt 1', 'alt 2', 'alt 3']) await say(alice, groupId, text);
        await waitFor(bob, id => ['alt 1', 'alt 2', 'alt 3'].every(text => (state.chats[id] || []).some(message => message.text === text)), groupId, 45000);

        // Carol mit Verlauf, Dave ohne.
        await alice.evaluate(([id, member]) => addGroupMembers(id, [member], 'last50'), [groupId, carolId]);
        await alice.evaluate(([id, member]) => addGroupMembers(id, [member], 'none'), [groupId, daveId]);
        await waitFor(carol, id => Boolean(getGroup(id)), groupId, 45000);
        await waitFor(dave, id => Boolean(getGroup(id)), groupId, 45000);
        await carol.evaluate(id => openChatWithPeer(id), groupId);
        await dave.evaluate(id => openChatWithPeer(id), groupId);
        await waitFor(carol, id => ['alt 1', 'alt 2', 'alt 3'].every(text => (state.chats[id] || []).some(message => message.text === text)), groupId, 60000);
        await say(alice, groupId, 'neu');
        await waitFor(dave, id => (state.chats[id] || []).some(message => message.text === 'neu'), groupId, 45000);
        await dave.waitForTimeout(3000);
        assert.deepEqual((await texts(dave, groupId)).filter(text => text.startsWith('alt')), [], 'no history for Dave');

        // Bob offline, Alice ohne Zwischenspeicher, Alice laedt neu (keine Sende-Queue): nur der Gruppen-Sync hilft.
        await bob.close();
        await alice.evaluate(() => { state.gridSettings.cacheEnabled = false; });
        await say(alice, groupId, 'verpasst');
        await alice.reload();
        await waitFor(alice, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        bob = await user('Bob', false);
        await bob.evaluate(id => openChatWithPeer(id), groupId);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'verpasst'), groupId, 60000);
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (group history and sync)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
