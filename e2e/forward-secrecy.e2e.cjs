// End-to-End: Forward Secrecy (forward-secrecy.js, Board T36 P5). P2P-Sitzung aus signierten Wegwerf-Schluesseln
// (private Teile verworfen), Pfad C als Umschlag v3 mit Wegwerf-Schluessel und Prekey des Empfaengers, Gruppen-
// Buendel mit Kettenindex. Alles kommt an; die Ableitung ist nach dem Lesen nicht wiederholbar.
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
    try {
        const alice = await user('Alice');
        let bob = await user('Bob');
        let carol = await user('Carol');
        const [aliceId, bobId, carolId] = await Promise.all([alice, bob, carol].map(page => page.evaluate(() => state.myProfile.id)));
        await befriend(alice, bob);
        await befriend(alice, carol);

        // P2P: Sitzung mit Forward Secrecy, privater Wegwerf-Schluessel verworfen, Prekey der Gegenseite gemerkt.
        await waitFor(alice, id => Boolean(state.channelEphemerals[id]?.sessionKey) && state.sessionKeys[id] === state.channelEphemerals[id].sessionKey, bobId);
        assert.equal(await alice.evaluate(id => state.channelEphemerals[id].privateKey, bobId), null, 'ephemeral private key dropped');
        await waitFor(alice, id => peerPrekeyFor(id).then(Boolean), bobId);
        const groupId = await alice.evaluate(async ids => (await createGroup('FS', ids)).id, [bobId, carolId]);
        await waitFor(bob, id => Boolean(getGroup(id)), groupId, 45000);
        await waitFor(carol, id => Boolean(getGroup(id)), groupId, 45000);

        // Pfad C: Bob und Carol offline.
        await bob.close();
        await carol.close();
        await alice.waitForTimeout(3000);
        const uploads = [];
        alice.on('request', request => {
            if (request.url().endsWith('/api/cache') && request.method() === 'POST') uploads.push(JSON.parse(request.postData() || '{}'));
        });
        await alice.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'fs eins'; await sendChatMessage(); }, bobId);
        await alice.evaluate(async id => { state.activeChatPeerId = id; document.getElementById('chat-input').value = 'fs gruppe 1'; await sendChatMessage(); }, groupId);
        await alice.evaluate(async id => { state.activeChatPeerId = id; document.getElementById('chat-input').value = 'fs gruppe 2'; await sendChatMessage(); }, groupId);
        await alice.waitForTimeout(12000);
        const single = uploads.filter(upload => upload.recipientId === bobId).map(upload => JSON.parse(upload.ciphertextPayload));
        assert.ok(single.length >= 1, 'single upload for bob');
        assert.ok(single.every(envelope => envelope.version === 3 && envelope.ephemeralKey?.x && typeof envelope.prekeyId === 'string'), 'v3 with prekey');
        const bundles = uploads.filter(upload => Array.isArray(upload.recipientIds)).map(upload => JSON.parse(upload.ciphertextPayload));
        assert.deepEqual(bundles.map(envelope => [envelope.version, envelope.n]), [[3, 0], [3, 1]], 'group chain index per message');

        bob = await user('Bob', false);
        carol = await user('Carol', false);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'fs eins'), aliceId, 60000);
        for (const page of [bob, carol]) {
            await waitFor(page, id => ['fs gruppe 1', 'fs gruppe 2'].every(text => (state.chats[id] || []).some(message => message.text === text)), groupId, 60000);
        }
        // Gruppen-Kette beim Empfaenger weitergerueckt (verbrauchte Glieder weg).
        const chain = await carol.evaluate(async ([gid, sender]) => {
            const record = await loadGroupKeys(gid);
            return Object.values(record.members[sender] || {})[0];
        }, [groupId, aliceId]);
        assert.equal(chain.n, 2);
        assert.deepEqual(chain.skipped, {});
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (forward secrecy)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
