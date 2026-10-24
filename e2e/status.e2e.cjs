// End-to-End: Status unter Freunden. A postet einen Text- und einen Foto-Status (Fake-Kamera) und
// setzt einen Kurzstatus; B sieht beides in der Statusleiste bzw. Chatliste, ein Nicht-Freund nicht.
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
    const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const pageErrors = [];
    async function user(name) {
        const context = await browser.newContext({ viewport: { width: 420, height: 860 }, permissions: ['camera'] });
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
        await page.evaluate(() => switchTab('chat'));
        return page;
    }

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const carol = await user('Carol');
        const [aliceId, bobId, carolId] = await Promise.all([alice, bob, carol].map(page => page.evaluate(() => state.myProfile.id)));

        // A und B werden Freunde, C schreibt A nur an.
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await alice.fill('#chat-input', 'hi');
        await alice.click('#send-chat-btn');
        await alice.evaluate(id => addFriend(id), bobId);
        await waitFor(bob, id => hasFriendRequest(id), aliceId);
        await bob.evaluate(id => addFriend(id), aliceId);
        await waitFor(alice, id => isFriend(id), bobId);
        await carol.evaluate(id => openChatWithPeer(id), aliceId);
        await carol.fill('#chat-input', 'hallo');
        await carol.click('#send-chat-btn');
        await waitFor(alice, id => state.chatPeerIds.includes(id), carolId);

        // Text-Status ueber den Composer.
        await alice.evaluate(() => leaveActiveChat());
        await alice.click('#status-bar button >> nth=0');
        await alice.fill('#status-text-input', 'Im Park');
        await alice.click('#status-post-text-btn');
        await waitFor(bob, id => activeStatusesOf(id).some(status => status.text === 'Im Park'), aliceId);
        await waitFor(bob, () => document.querySelectorAll('#status-bar button').length === 2);

        // Foto-Status ueber Kamera + Editor ("+" am eigenen Bubble, der Bubble selbst zeigt jetzt den Status).
        await alice.click('#status-bar button >> nth=0 >> span.absolute');
        await alice.click('#status-photo-btn');
        await waitFor(alice, () => document.getElementById('snap-video-preview').videoWidth > 0);
        await alice.click('[aria-label="Ausloesen"]');
        await waitFor(alice, () => hasSnapDraft());
        assert.match(await alice.textContent('#snap-send-btn'), /Status/);
        await alice.click('#snap-send-btn');
        await waitFor(bob, id => activeStatusesOf(id).some(status => status.kind === 'photo'), aliceId);

        // B schaut sich die Status an (Text, dann Foto als Canvas).
        await bob.evaluate(() => leaveActiveChat());
        await bob.click('#status-bar button >> nth=1');
        await waitFor(bob, () => !document.getElementById('status-viewer').classList.contains('hidden'));
        assert.equal(await bob.textContent('#status-viewer-text'), 'Im Park');
        await bob.click('[aria-label="Naechster Status"]');
        await waitFor(bob, () => document.getElementById('status-viewer-image').width > 0);
        assert.equal(await bob.isVisible('#status-viewer-delete'), false, 'cannot delete others');
        await bob.evaluate(() => closeStatusViewer());

        // Kurzstatus: B sieht ihn, C (kein Freund) bekommt nichts.
        await alice.click('#status-bar button >> nth=0');
        await waitFor(alice, () => !document.getElementById('status-viewer').classList.contains('hidden'));
        assert.equal(await alice.isVisible('#status-viewer-delete'), true, 'own status can be deleted');
        await alice.evaluate(() => closeStatusViewer());
        await alice.click('#status-bar button >> nth=0 >> span.absolute');
        await alice.fill('#status-presence-input', 'Im Club');
        await alice.click('#status-presence-btn');
        await waitFor(bob, id => presenceTextOf(id) === 'Im Club', aliceId);
        await waitFor(bob, () => document.getElementById('active-peers-list').textContent.includes('Im Club'));
        await carol.waitForTimeout(1500);
        assert.equal(await carol.evaluate(id => activeStatusesOf(id).length, aliceId), 0, 'non-friend gets no status');
        assert.equal(await carol.evaluate(id => state.cachedProfiles[id]?.presenceText || '', aliceId), '', 'non-friend gets no presence');

        // A loescht den Text-Status; er verschwindet bei B.
        const textId = await alice.evaluate(() => activeStatusesOf(state.myProfile.id).find(status => status.kind === 'text').id);
        await alice.evaluate(id => deleteOwnStatus(id), textId);
        await waitFor(bob, id => !state.statuses[id], textId);

        assert.deepEqual(pageErrors, [], 'no uncaught page errors');
        console.log('E2E OK (status)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
