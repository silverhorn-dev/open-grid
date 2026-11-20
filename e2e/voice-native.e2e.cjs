// End-to-End: Sprachnachricht ueber die Aufnahme der Android-App (voice.js nativeVoiceRecorder, VoiceRecorder.kt).
// Die App ist nachgebaut (Bruecke mit `audioRecorder`); getUserMedia darf dabei nie aufgerufen werden, weil das
// Mikrofon in der WebView den Renderer beendet (T38). Bob bekommt die Sprachnachricht wie gewohnt.
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
        await page.evaluate(() => setAppMode('chat'));
        return page;
    }
    try {
        const alice = await user('Alice');
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));
        await bob.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'hi'; await sendChatMessage(); }, aliceId);
        await waitFor(alice, id => (state.chats[id] || []).some(message => message.text === 'hi'), bobId);

        // Alice ist "in der App": Bruecke mit eigener Aufnahme; Teile sind kurze Opus/OGG-Data-URLs.
        await alice.evaluate(() => {
            window.nativeActions = [];
            navigator.mediaDevices.getUserMedia = async () => { window.getUserMediaCalled = true; throw new Error('must not be used'); };
            nativeBridge.capabilities = { ...(nativeBridge.capabilities || {}), audioRecorder: true };
            nativeBridge.port = {
                postMessage(raw) {
                    const request = JSON.parse(raw);
                    const answer = result => setTimeout(() => handleNativeMessage(JSON.stringify({ v: 1, id: request.id, ok: true, result })), 20);
                    if (request.type !== 'recordAudio') return answer(null);
                    window.nativeActions.push(request.data.action);
                    if (request.data.action === 'start') return answer({ mime: 'audio/ogg;codecs=opus' });
                    if (request.data.action === 'cancel') return answer(null);
                    return answer({ data: 'data:audio/ogg;codecs=opus;base64,T2dnUwACAAAAAAAAAAA=', durationMs: 1500 });
                }
            };
        });
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        assert.equal(await alice.evaluate(() => isVoiceSupported()), true);
        await alice.evaluate(() => startVoiceRecording());
        await waitFor(alice, () => Boolean(state.voiceRecording?.native));
        await alice.waitForTimeout(1500);
        await alice.evaluate(() => sendVoiceRecording());
        await waitFor(bob, id => (state.chats[id] || []).some(message => typeof message.audioData === 'string' && message.audioData.startsWith('data:audio/ogg;codecs=opus;base64,')), aliceId);
        assert.deepEqual(await alice.evaluate(() => window.nativeActions), ['start', 'stop']);
        assert.equal(await alice.evaluate(() => Boolean(window.getUserMediaCalled)), false, 'getUserMedia never used in the app');

        // Abbrechen: App verwirft die Aufnahme.
        await alice.evaluate(() => startVoiceRecording());
        await waitFor(alice, () => Boolean(state.voiceRecording?.native));
        await alice.evaluate(() => cancelVoiceRecording());
        assert.deepEqual(await alice.evaluate(() => window.nativeActions.slice(-2)), ['start', 'cancel']);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (voice via app recorder)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
