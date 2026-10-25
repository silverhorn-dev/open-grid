// End-to-End: Snap-Kamera mit Fake-Kamera. Gesten (doppelt tippen = Kamera wechseln, runter wischen =
// schliessen), Editor (zeichnen, Text, Emoji) und Versand eines geflachten JPEG an den Partner.
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
        await alice.click('[aria-label="Ausloesen"]');
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
        await alice.click('[aria-label="Rueckgaengig"]');
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
        await alice.click('[aria-label="Ausloesen"]');
        await waitFor(alice, () => hasSnapDraft());
        assert.match(await alice.textContent('#snap-send-btn'), /Bild senden/);
        await alice.click('#snap-send-btn');
        await waitFor(bob, () => Object.values(state.chats).flat().filter(message => typeof message.snapData === 'string').length >= 2, null, 30000);
        const image = await bob.evaluate(() => Object.values(state.chats).flat().filter(message => message.snapData).at(-1));
        assert.equal(image.snapMode, undefined, 'sent as a normal image, not a one-time snap');
        assert.equal(await bob.evaluate(message => messagePreview(message), image), 'Bild');

        assert.deepEqual(pageErrors, [], 'no uncaught page errors');
        console.log('E2E OK (snap camera)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
