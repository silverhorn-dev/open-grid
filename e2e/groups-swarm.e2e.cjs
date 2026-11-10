// End-to-End: Medien-Schwarm (originals.js, Board T36 P3). Alice schickt ein Original in die Gruppe, Bob holt es
// direkt bei ihr. Carol war offline; als sie zurueckkommt, ist Alice weg: Carol bekommt das Original von Bob,
// geprueft gegen Groesse und Hash aus Alices signierter Nachricht. Der Router-Zwischenspeicher sieht nur die Vorschau.
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
        const bob = await user('Bob');
        let carol = await user('Carol');
        const [bobId, carolId] = await Promise.all([bob, carol].map(page => page.evaluate(() => state.myProfile.id)));
        await befriend(alice, bob);
        await befriend(alice, carol);
        const groupId = await alice.evaluate(async ids => (await createGroup('Schwarm', ids)).id, [bobId, carolId]);
        await waitFor(bob, id => Boolean(getGroup(id)), groupId, 45000);
        await waitFor(carol, id => Boolean(getGroup(id)), groupId, 45000);
        await carol.close();
        await bob.evaluate(id => openChatWithPeer(id), groupId);

        // Alice: Bild mit Original (gross, nur P2P) in die Gruppe.
        const uploads = [];
        alice.on('request', request => {
            if (request.url().endsWith('/api/cache') && request.method() === 'POST') uploads.push(request.postData() || '');
        });
        const messageId = await alice.evaluate(async id => {
            await openChatWithPeer(id);
            const canvas = document.createElement('canvas');
            canvas.width = 900; canvas.height = 700;
            const context = canvas.getContext('2d');
            for (let index = 0; index < 400; index++) {
                context.fillStyle = `hsl(${index * 37 % 360}, 70%, ${30 + index % 40}%)`;
                context.fillRect((index * 53) % 900, (index * 97) % 700, 60, 40);
            }
            const preview = canvas.toDataURL('image/jpeg', 0.3);
            const original = await createOriginalImage(canvas, id);
            await sendChatMessage(preview, '', null, null, { original });
            return state.chats[id].at(-1).id;
        }, groupId);
        const meta = await alice.evaluate(([id, mid]) => state.chats[id].find(message => message.id === mid).original, [groupId, messageId]);
        assert.ok(meta.size > 64 * 1024, 'original larger than one chunk');
        await waitFor(bob, mid => Object.values(state.chats).flat().find(message => message.id === mid)?.originalReady === true, messageId, 45000);

        // Alice geht, Carol kommt: Original nur von Bob moeglich.
        await alice.waitForTimeout(3000);
        await alice.close();
        carol = await user('Carol', false);
        await carol.evaluate(id => openChatWithPeer(id), groupId);
        await waitFor(carol, mid => Object.values(state.chats).flat().some(message => message.id === mid), messageId, 60000);
        await waitFor(carol, mid => Object.values(state.chats).flat().find(message => message.id === mid)?.originalReady === true, messageId, 90000);
        const received = await carol.evaluate(async mid => (await loadMedia(`orig_${mid}`)).data, messageId);
        assert.equal(received.length, meta.size, 'complete original from the swarm');
        assert.equal(await carol.evaluate(async data => sha256Base64(data), received), meta.sha256, 'hash matches the signed message');
        assert.ok(uploads.every(body => body.length < meta.size), 'the original never went through the router cache');
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (group media swarm)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
