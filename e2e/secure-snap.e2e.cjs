// End-to-End: Secure Snaps. (1) Die erste Ansicht laeuft die volle Anzeigedauer (vorher brach sie ab,
// wenn der Live-Stream beim ersten Mal zu spaet startete). (2) Geht die Anfrage verloren, baut Bob den
// Kanal neu auf und fragt erneut, statt ewig auf die Freigabe zu warten. (3) Alice sieht ihren eigenen
// Secure Snap, solange Bob noch Ansichten hat; danach nicht mehr.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const debugLogs = [];

async function waitFor(page, predicate, arg, timeout = 30000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        if (await page.evaluate(predicate, arg).catch(() => false)) return;
        await page.waitForTimeout(200);
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
        page.on('console', message => { if (message.text().startsWith('[OpenGrid]')) debugLogs.push(`${Date.now() % 1000000} [${name}] ${message.text().slice(11, 200)}`); });
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(() => { CONFIG.DEBUG_MODE = true; setAppMode('chat'); });
        return page;
    }
    const visibleContent = page => page.evaluate(() => {
        const image = document.getElementById('secure-snap-image');
        const video = document.getElementById('secure-snap-video');
        return (!image.classList.contains('hidden') && image.width > 0) || (!video.classList.contains('hidden') && video.readyState >= 2);
    });

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));

        // Alice schickt einen Secure Snap: 2 Ansichten, je 4 Sekunden.
        await alice.evaluate(async id => {
            await openChatWithPeer(id);
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 240;
            canvas.getContext('2d').fillRect(0, 0, 320, 240);
            const data = canvas.toDataURL('image/jpeg', 0.9);
            await sendChatMessage(null, '', null, await createSecureSnap(data, id, 2, 4));
        }, bobId);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.secureSnap?.encrypted), aliceId);
        const messageId = await bob.evaluate(id => state.chats[id].find(message => message.secureSnap).id, aliceId);
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await waitFor(bob, id => isSecureChannelOpen(id), aliceId);

        // (3a) Bob hat noch Ansichten: Alice sieht ihren eigenen Snap.
        const ownId = await alice.evaluate(id => state.chats[id].find(message => message.secureSnap).id, bobId);
        await alice.evaluate(id => openOwnSecureSnap(id), ownId);
        await waitFor(alice, () => {
            const image = document.getElementById('secure-snap-image');
            return !image.classList.contains('hidden') && image.width > 0;
        }, null, 10000);
        await alice.evaluate(() => closeSecureSnapViewer());

        // (1) Erste Ansicht: Inhalt erscheint und bleibt fast die ganze Dauer sichtbar.
        await bob.evaluate(id => requestSecureSnapView(id), messageId);
        await waitFor(bob, () => {
            const image = document.getElementById('secure-snap-image');
            const video = document.getElementById('secure-snap-video');
            return (!image.classList.contains('hidden') && image.width > 0) || (!video.classList.contains('hidden') && video.readyState >= 2);
        }, null, 20000);
        await bob.waitForTimeout(3000);
        assert.equal(await bob.isVisible('#secure-snap-viewer'), true, 'still open after 3 of 4 seconds');
        assert.equal(await visibleContent(bob), true, 'content still visible');
        await waitFor(bob, () => document.getElementById('secure-snap-viewer').classList.contains('hidden'), null, 10000);

        // (2) Die naechste Anfrage verschluckt Alice einmal (wie in einem halb toten Kanal).
        await alice.evaluate(() => {
            const original = handleSnapViewRequest;
            let dropped = false;
            window.handleSnapViewRequest = async (peerId, payload) => {
                if (!dropped) {
                    dropped = true;
                    return;
                }
                return original(peerId, payload);
            };
        });
        await bob.evaluate(id => requestSecureSnapView(id), messageId);
        try {
            await waitFor(bob, () => {
                const image = document.getElementById('secure-snap-image');
                const video = document.getElementById('secure-snap-video');
                return (!image.classList.contains('hidden') && image.width > 0) || (!video.classList.contains('hidden') && video.readyState >= 2);
            }, null, 40000);
        } catch (error) {
            const dump = page => page.evaluate(() => ({
                viewing: state.secureSnapViewing && { ...state.secureSnapViewing, timer: undefined, requestTimer: undefined },
                status: document.getElementById('secure-snap-status').textContent,
            }));
            console.log('BOB', JSON.stringify(await dump(bob)));
            console.log('ALICE', JSON.stringify(await dump(alice)));
            console.log(debugLogs.slice(-60).join('\n'));
            throw error;
        }
        await bob.evaluate(() => closeSecureSnapViewer());
        await waitFor(bob, id => state.chats[id].find(message => message.secureSnap)?.secureSnap.expired === true, aliceId, 10000);

        // (3b) Alle Ansichten verbraucht: auch bei Alice weg.
        await waitFor(alice, id => (state.chats[id].find(message => message.secureSnap)?.secureSnap.viewsUsed || 0) >= 2, bobId, 10000);
        await alice.evaluate(id => openOwnSecureSnap(id), ownId);
        await alice.waitForTimeout(500);
        assert.equal(await alice.isVisible('#secure-snap-viewer'), false, 'gone for the sender after the last view');
        assert.equal(await alice.evaluate(id => state.chats[id].find(message => message.secureSnap).secureSnap.encrypted, bobId), undefined);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (secure snap)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
