// End-to-End: Umzug per Datei (transfer.js, Board T31). Alte Kopie mit Profil, Chat und Album exportiert eine
// verschluesselte .opengrid-Datei; ein frisches Geraet uebernimmt sie beim Einrichten (falsches Passwort wird
// abgelehnt) und startet mit denselben Daten, aber eigener Node-ID. Danach signierter Umzug: Bob zieht den Chat
// auf die neue ID um, die alte Kopie sperrt sich.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const PASSWORD = 'umzug-test-123';

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
    const newPage = async () => {
        const context = await browser.newContext({ locale: 'de-DE', acceptDownloads: true });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        return page;
    };
    const onboard = async (page, name) => {
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id && state.myProfile.updatedAt));
    };
    try {
        // Alte Kopie: Profil, Chat mit Bob, Album, Thema.
        const alice = await newPage();
        await onboard(alice, 'Alice Alt');
        const bob = await newPage();
        await onboard(bob, 'Bob');
        const aliceId = await alice.evaluate(() => state.myProfile.id);
        const bobId = await bob.evaluate(() => state.myProfile.id);
        await bob.evaluate(async id => {
            await openChatWithPeer(id);
            document.getElementById('chat-input').value = 'hallo alice';
            await sendChatMessage();
        }, aliceId);
        await waitFor(alice, id => (state.chats[id] || []).some(message => message.text === 'hallo alice'), bobId);
        await alice.evaluate(async id => {
            await openChatWithPeer(id);
            document.getElementById('chat-input').value = 'hallo bob';
            await sendChatMessage();
            document.getElementById('new-album-name').value = 'Umzugsalbum';
            await createAlbum();
            localStorage.setItem('opengrid-theme', 'light');
        }, bobId);

        // Export ueber die Einstellungen.
        await alice.evaluate(() => openTransferExport());
        await alice.fill('#transfer-export-password', PASSWORD);
        await alice.fill('#transfer-export-password-repeat', 'anders');
        await alice.click('#transfer-export-btn');
        assert.match(await alice.locator('#transfer-export-error').textContent(), /verschieden/);
        await alice.fill('#transfer-export-password-repeat', PASSWORD);
        const [download] = await Promise.all([alice.waitForEvent('download'), alice.click('#transfer-export-btn')]);
        assert.match(download.suggestedFilename(), /^opengrid-.*\.opengrid$/);
        const file = path.join(os.tmpdir(), `transfer-${Date.now()}.opengrid`);
        await download.saveAs(file);
        const raw = fs.readFileSync(file, 'utf8');
        assert.ok(!raw.includes('hallo bob') && !raw.includes('Alice Alt') && !raw.includes('Umzugsalbum'), 'file is encrypted');

        // Neues Geraet: beim Einrichten uebernehmen.
        const fresh = await newPage();
        const freshId = await fresh.evaluate(() => state.nodeId);
        assert.notEqual(freshId, aliceId);
        await fresh.click('#onboarding-transfer-btn');
        await fresh.setInputFiles('#transfer-import-file', file);
        await fresh.fill('#transfer-import-password', 'falsch-falsch');
        await fresh.click('#transfer-import-btn');
        await waitFor(fresh, () => /Falsches Passwort/.test(document.getElementById('transfer-import-error').textContent), null, 60000);
        await fresh.fill('#transfer-import-password', PASSWORD);
        await Promise.all([fresh.waitForEvent('load', { timeout: 60000 }), fresh.click('#transfer-import-btn')]);

        // Nach dem Neustart: kein Einrichten, gleiche Daten, eigene ID.
        await waitFor(fresh, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.updatedAt));
        assert.equal(await fresh.locator('#profile-onboarding-modal').isVisible(), false, 'no onboarding after import');
        const after = await fresh.evaluate(async peer => {
            await loadChatHistory(peer);
            return {
                id: state.myProfile.id,
                name: state.myProfile.fields.displayName,
                messages: (state.chats[peer] || []).map(message => ({ text: message.text, mine: message.senderId === state.myProfile.id })),
                albums: getOwnAlbums().map(album => album.name),
                theme: localStorage.getItem('opengrid-theme'),
                imported: await databaseRequest('keys', 'readonly', store => store.get('transfer-imported'))
            };
        }, bobId);
        assert.equal(after.id, freshId, 'keeps its own node id');
        assert.equal(after.name, 'Alice Alt');
        assert.deepEqual(after.messages.map(message => `${message.mine ? 'me' : 'bob'}:${message.text}`).sort(), ['bob:hallo alice', 'me:hallo bob']);
        assert.deepEqual(after.albums, ['Umzugsalbum']);
        assert.equal(after.theme, 'light');
        assert.equal(after.imported.from, aliceId);

        // Signierter Umzug: Bob zieht den Chat auf die neue ID um, die alte Kopie sperrt sich.
        await waitFor(bob, ([oldId, newId]) => !(state.chatPeerIds || []).includes(oldId) && (state.chatPeerIds || []).includes(newId), [aliceId, freshId], 60000);
        const pinned = await bob.evaluate(async ([oldId, newId]) => ({
            fresh: Boolean((await getPeerIdentity(newId))?.profileSigningKey),
            old: Boolean(await databaseRequest('keys', 'readonly', store => store.get(`peer-identity:${oldId}`)))
        }), [aliceId, freshId]);
        assert.deepEqual(pinned, { fresh: true, old: false }, 'bob pins the new keys and forgets the old identity');
        const bobView = await bob.evaluate(async peer => {
            await loadChatHistory(peer);
            return (state.chats[peer] || []).map(message => message.text).sort();
        }, freshId);
        assert.deepEqual(bobView, ['hallo alice', 'hallo bob'], 'bob keeps the history under the new id');
        await waitFor(alice, () => state.movedAway === true, null, 60000);
        assert.ok(await alice.locator('#moved-away-modal').isVisible(), 'old copy shows the lock notice');
        await alice.click('#moved-away-view-btn');
        assert.ok(await alice.locator('#moved-away-bar').isVisible());
        assert.equal(await alice.evaluate(id => sendChatMessage('x', 'nope', null, null, { peerId: id }), bobId), false, 'old copy cannot send');
        // Bob schreibt an die neue ID, das neue Geraet bekommt es.
        await bob.evaluate(async id => {
            await openChatWithPeer(id);
            document.getElementById('chat-input').value = 'willkommen zurueck';
            await sendChatMessage();
        }, freshId);
        await waitFor(fresh, id => (state.chats[id] || []).some(message => message.text === 'willkommen zurueck'), bobId, 60000);
        const done = await fresh.evaluate(() => databaseRequest('keys', 'readonly', store => store.get('transfer-imported')));
        assert.equal(done.done, true, 'all contacts reached');
        assert.equal(done.move.delegatePrivate, undefined, 'delegate key dropped after the move');
        assert.deepEqual(pageErrors, []);
        console.log('E2E OK (transfer file)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
