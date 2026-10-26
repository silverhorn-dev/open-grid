// End-to-End: Snap-Kamera mit Fake-Kamera. Gesten (doppelt tippen = Kamera wechseln, runter wischen =
// schliessen), Editor (zeichnen, Text, Emoji) und Versand eines geflachten JPEG an den Partner.
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
    const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const pageErrors = [];
    async function user(name) {
        const context = await browser.newContext({ locale: 'de-DE', viewport: { width: 420, height: 860 }, permissions: ['camera'] });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(`[${name}] ${error.message}`));
        page.on('console', message => { if (message.text().startsWith('[OpenGrid]')) debugLogs.push(`${Date.now() % 1000000} [${name}] ${message.text().slice(11, 200)}`); });
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill(name);
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.ws && state.ws.readyState === 1 && state.myProfile.id));
        await page.evaluate(() => { CONFIG.DEBUG_MODE = true; });
        return page;
    }

    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const bobId = await bob.evaluate(() => state.myProfile.id);
        await alice.evaluate(id => openChatWithPeer(id), bobId);

        const openCamera = async () => {
            await alice.evaluate(() => openSnapUploadModal());
            await waitFor(alice, () => document.getElementById('snap-video-preview').videoWidth > 0);
        };
        const stageBox = async () => alice.locator('#snap-camera-stage').boundingBox();

        // Doppelt tippen wechselt die Kamera.
        await openCamera();
        const facingBefore = await alice.evaluate(() => state.snapFacingMode);
        const box = await stageBox();
        await alice.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await alice.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await waitFor(alice, before => state.snapFacingMode !== before, facingBefore, 5000);

        // Nach unten wischen schliesst die Kamera.
        await waitFor(alice, () => document.getElementById('snap-video-preview').videoWidth > 0);
        await alice.mouse.move(box.x + box.width / 2, box.y + 200);
        await alice.mouse.down();
        await alice.mouse.move(box.x + box.width / 2, box.y + 300, { steps: 5 });
        await alice.mouse.move(box.x + box.width / 2, box.y + 420, { steps: 5 });
        await alice.mouse.up();
        await waitFor(alice, () => document.getElementById('snap-capture-modal').classList.contains('hidden'), null, 5000);
        assert.equal(await alice.evaluate(() => state.mediaStream), null, 'camera stopped');

        // Aufnehmen und bearbeiten.
        await openCamera();
        assert.equal(await alice.isVisible('#snap-torch-btn'), false, 'fake camera has no torch');
        await alice.click('[aria-label="Auslösen"]');
        await waitFor(alice, () => hasSnapDraft() && !document.getElementById('snap-editor').classList.contains('hidden'));
        await alice.click('#snap-tool-draw');
        const draw = await alice.locator('#snap-edit-draw').boundingBox();
        await alice.mouse.move(draw.x + 30, draw.y + 30);
        await alice.mouse.down();
        await alice.mouse.move(draw.x + draw.width - 30, draw.y + draw.height / 2, { steps: 10 });
        await alice.mouse.up();
        await alice.click('[aria-label="Text"]');
        await alice.fill('#snap-text-input', 'Hallo Bob');
        await alice.press('#snap-text-input', 'Enter');
        await alice.click('#snap-tool-emoji');
        await alice.click('#snap-emoji-row button >> nth=2');
        const editState = await alice.evaluate(() => ({ strokes: snapEditor.strokes.length, items: snapEditor.items.map(item => item.kind) }));
        assert.equal(editState.strokes, 1);
        assert.deepEqual(editState.items, ['text', 'emoji']);
        await alice.click('[aria-label="Rückgängig"]');
        assert.equal(await alice.evaluate(() => snapEditor.items.length), 1, 'undo removes the emoji');
        await alice.click('#snap-tool-emoji');
        await alice.click('#snap-emoji-row button >> nth=2');
        await alice.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/snap-editor.png` : '/tmp/snap-editor.png' });
        await alice.click('#snap-send-btn');

        // Bob bekommt ein einziges JPEG unter dem Pfad-C-Limit.
        await waitFor(bob, () => Object.values(state.chats).some(list => list.some(message => typeof message.snapData === 'string')), null, 30000);
        const snap = await bob.evaluate(() => Object.values(state.chats).flat().find(message => message.snapData).snapData);
        assert.match(snap, /^data:image\/jpeg;base64,/);
        assert.ok(snap.length <= 70000, `snap size ${snap.length}`);
        assert.equal(await alice.evaluate(() => hasSnapDraft()), false, 'editor cleared after sending');

        // "Als Bild senden": seitlich wischen schaltet um, das Bild bleibt dauerhaft im Chat.
        await openCamera();
        const stage = await stageBox();
        await alice.mouse.move(stage.x + stage.width * 0.65, stage.y + stage.height * 0.35);
        await alice.mouse.down();
        await alice.mouse.move(stage.x + 30, stage.y + stage.height * 0.35 + 10, { steps: 8 });
        await alice.mouse.up();
        await waitFor(alice, () => state.snapSendMode === 'image', null, 5000);
        assert.equal(await alice.textContent('#snap-mode-pill'), 'Bild');
        await alice.click('#snap-mode-switch');
        assert.equal(await alice.evaluate(() => state.snapSendMode), 'snap', 'label button switches back');
        await alice.click('#snap-mode-switch');
        await alice.click('[aria-label="Auslösen"]');
        await waitFor(alice, () => hasSnapDraft());
        assert.match(await alice.textContent('#snap-send-btn'), /Bild senden/);
        await alice.click('#snap-send-btn');
        await waitFor(bob, () => Object.values(state.chats).flat().filter(message => typeof message.snapData === 'string').length >= 2, null, 30000);
        const image = await bob.evaluate(() => Object.values(state.chats).flat().filter(message => message.snapData).at(-1));
        assert.equal(image.snapMode, undefined, 'sent as a normal image, not a one-time snap');
        assert.ok(image.imageSize?.w > 0 && image.imageSize?.h > 0, 'image size travels with the message');
        assert.equal(await bob.evaluate(message => messagePreview(message), image), 'Bild');

        // "Original": volle Qualitaet nur ueber P2P, Bob bekommt erst die Vorschau, dann das Original.
        await openCamera();
        await alice.click('#snap-mode-switch');
        await alice.click('[aria-label="Auslösen"]');
        await waitFor(alice, () => hasSnapDraft());
        assert.equal(await alice.isVisible('#snap-original-option'), true, 'original toggle in image mode');
        await alice.check('#snap-original-toggle');
        await alice.click('#snap-send-btn');
        const originalId = await alice.evaluate(async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
            return state.chats[state.activeChatPeerId].at(-1).id;
        });
        const sentOriginal = await alice.evaluate(id => state.chats[state.activeChatPeerId].find(message => message.id === id).original, originalId);
        assert.ok(sentOriginal && sentOriginal.size > 0, 'message carries the original meta');
        await waitFor(bob, id => Object.values(state.chats).flat().find(message => message.id === id)?.originalReady === true, originalId, 30000);
        const received = await bob.evaluate(async id => (await loadMedia(`orig_${id}`)).data.length, originalId);
        assert.equal(received, sentOriginal.size, 'original arrived completely');
        const preview = await bob.evaluate(id => Object.values(state.chats).flat().find(message => message.id === id).snapData.length, originalId);
        assert.ok(preview <= 70000, 'preview stays small');

        // Mehrfachauswahl aus der Galerie: drei Snaps auf einmal.
        const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
        const beforePick = await bob.evaluate(() => Object.values(state.chats).flat().filter(message => message.snapMode === 'replay').length);
        await openCamera();
        await alice.setInputFiles('#snap-file-input', [1, 2, 3].map(index => ({ name: `bild${index}.png`, mimeType: 'image/png', buffer: tinyPng })));
        await waitFor(bob, count => Object.values(state.chats).flat().filter(message => message.snapMode === 'replay').length >= count + 3, beforePick, 30000);

        // Bob schaut sie hintereinander: Doppeltippen fuehrt zum naechsten, nach dem letzten zu.
        const aliceIdForQueue = await alice.evaluate(() => state.myProfile.id);
        await bob.evaluate(id => openChatWithPeer(id), aliceIdForQueue);
        const queue = await bob.evaluate(id => unseenReplaySnaps(id).map(message => message.id), aliceIdForQueue);
        // Ein frueherer, ungesehener Snap plus die drei aus der Galerie.
        assert.equal(queue.length, 4);
        await bob.evaluate(id => openReplaySnap(id), queue[0]);
        assert.match(await bob.textContent('#secure-snap-queue'), /Noch 3 Snaps/);
        const viewer = await bob.locator('#secure-snap-viewer').boundingBox();
        const tapCenter = async () => {
            await bob.mouse.click(viewer.x + viewer.width / 2, viewer.y + viewer.height / 2);
            await bob.mouse.click(viewer.x + viewer.width / 2, viewer.y + viewer.height / 2);
        };
        await tapCenter();
        await waitFor(bob, id => state.secureSnapViewing?.messageId === id, queue[1], 5000);
        await bob.evaluate(() => updateSnapSetting('nextGesture', 'swipe'));
        await bob.mouse.move(viewer.x + viewer.width * 0.8, viewer.y + viewer.height / 2);
        await bob.mouse.down();
        await bob.mouse.move(viewer.x + viewer.width * 0.2, viewer.y + viewer.height / 2 + 5, { steps: 6 });
        await bob.mouse.up();
        await waitFor(bob, id => state.secureSnapViewing?.messageId === id, queue[2], 5000);
        const swipeLeft = async () => {
            await bob.mouse.move(viewer.x + viewer.width * 0.8, viewer.y + viewer.height / 2);
            await bob.mouse.down();
            await bob.mouse.move(viewer.x + viewer.width * 0.2, viewer.y + viewer.height / 2 + 5, { steps: 6 });
            await bob.mouse.up();
        };
        await swipeLeft();
        await waitFor(bob, id => state.secureSnapViewing?.messageId === id, queue[3], 5000);
        await swipeLeft();
        await waitFor(bob, () => document.getElementById('secure-snap-viewer').classList.contains('hidden'), null, 5000);
        assert.deepEqual(await bob.evaluate(ids => ids.map(id => state.chats[state.activeChatPeerId].find(message => message.id === id).snapViews), queue), [1, 1, 1, 1], 'each counted once');

        // Ablauf nach der ersten Ansicht: Alice stellt 15 min ein, das geht als Enum mit dem Snap mit.
        await alice.evaluate(() => updateSnapSetting('expiry', '15m'));
        const expiringId = await alice.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 120;
            canvas.height = 120;
            canvas.getContext('2d').fillRect(0, 0, 120, 120);
            await sendChatMessage(canvas.toDataURL('image/jpeg'), '');
            return state.chats[state.activeChatPeerId].at(-1).id;
        });
        const aliceIdForExpiry = await alice.evaluate(() => state.myProfile.id);
        await waitFor(bob, id => Object.values(state.chats).flat().some(message => message.id === id), expiringId, 30000);
        await bob.evaluate(id => openChatWithPeer(id), aliceIdForExpiry);
        assert.equal(await bob.evaluate(id => state.chats[state.activeChatPeerId].find(message => message.id === id).snapExpiry, expiringId), '15m');
        await bob.evaluate(id => openReplaySnap(id), expiringId);
        await bob.evaluate(() => closeSecureSnapViewer());
        await bob.waitForTimeout(300);
        // Kein Restzeit-Hinweis beim Empfaenger.
        assert.doesNotMatch(await bob.textContent('#chat-messages'), /\d+\s*min|verbleib|noch \d/i, 'no time-left label for the receiver');
        // 16 Minuten spaeter: weg, auch beim Absender.
        await bob.evaluate(async ([peerId, id]) => {
            state.chats[peerId].find(message => message.id === id).firstViewedAt -= 16 * 60 * 1000;
            await expireUsedReplaySnaps(peerId);
        }, [aliceIdForExpiry, expiringId]);
        assert.equal(await bob.evaluate(id => Boolean(state.chats[state.activeChatPeerId].find(message => message.id === id).snapData), expiringId), false, 'expired at the receiver');
        await waitFor(alice, id => !state.chats[state.activeChatPeerId].find(message => message.id === id).snapData, expiringId, 30000);

        // Bob speichert einen Einmal-Snap: Alice erfaehrt es.
        const snapId = await alice.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 200;
            canvas.height = 200;
            canvas.getContext('2d').fillRect(0, 0, 200, 200);
            await sendChatMessage(canvas.toDataURL('image/jpeg'), 'zum speichern');
            return state.chats[state.activeChatPeerId].at(-1).id;
        });
        const aliceId = await alice.evaluate(() => state.myProfile.id);
        await waitFor(bob, id => Object.values(state.chats).flat().some(message => message.id === id), snapId, 30000);
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await bob.evaluate(id => openReplaySnap(id), snapId);
        await bob.click('#secure-snap-save');
        await waitFor(alice, id => state.chats[state.activeChatPeerId].find(message => message.id === id)?.savedByPeer === true, snapId, 30000);
        await alice.evaluate(() => renderChatHistory());
        assert.match(await alice.textContent('#chat-messages'), /vom Empfänger gespeichert/);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (snap camera)');
        if (process.env.E2E_DEBUG) console.log(debugLogs.filter(entry => /KEY_HELLO|Schluessel|haengt|Path C skipped/.test(entry)).join('\n'));
    } finally {
        if (process.env.E2E_DEBUG) console.log(debugLogs.join('\n'));
        await browser.close();
    }
}

main().catch(error => {
    console.error(debugLogs.slice(-40).join('\n'));
    console.error('E2E FAILED', error);
    process.exit(1);
});
