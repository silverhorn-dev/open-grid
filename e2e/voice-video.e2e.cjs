// End-to-End: Sprachnachrichten und Videos.
// - Alice nimmt mit dem (Fake-)Mikrofon 2 s auf und sendet: Bob bekommt die Aufnahme P2P und kann sie
//   abspielen; die Chatliste zeigt "Sprachnachricht (0:02)".
// - Eine fast volle Sprachnachricht (60 s) passt auch durch den Router-Cache (Kanal halb tot).
// - Video: Bob bekommt zuerst nur die Vorschau, das Video selbst kommt ueber den DataChannel
//   (Original-Uebertragung) und laesst sich abspielen.
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
    const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
    const pageErrors = [];
    async function user(name) {
        const context = await browser.newContext({ permissions: ['microphone'] });
        const page = await context.newPage();
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
        await alice.evaluate(id => openChatWithPeer(id), bobId);
        await waitFor(alice, id => isSecureChannelOpen(id), bobId);
        await bob.evaluate(id => { switchTab('chat'); return openChatWithPeer(id); }, aliceId);

        // Leeres Feld: Mikrofon statt Senden.
        assert.equal(await alice.isVisible('#chat-voice-btn'), true, 'mic shown for an empty input');
        assert.equal(await alice.isVisible('#send-chat-btn'), false);
        await alice.fill('#chat-input', 'x');
        assert.equal(await alice.isVisible('#send-chat-btn'), true, 'send shown with text');
        await alice.fill('#chat-input', '');

        // Aufnehmen und senden.
        await alice.click('#chat-voice-btn');
        await waitFor(alice, () => Boolean(state.voiceRecording));
        assert.equal(await alice.isVisible('#chat-voice-bar'), true);
        await alice.waitForTimeout(2300);
        await alice.click('#chat-voice-bar button[aria-label="Sprachnachricht senden"]');
        await waitFor(bob, () => Object.values(state.chats).flat().some(message => message.audioData));
        const voice = await bob.evaluate(() => Object.values(state.chats).flat().find(message => message.audioData));
        assert.match(voice.audioData, /^data:audio\//);
        assert.ok(voice.audioDuration >= 2 && voice.audioDuration <= 3, `duration ${voice.audioDuration}`);
        assert.match(await bob.textContent('#active-peers-list'), /Sprachnachricht \(0:0[23]\)/);
        await bob.click(`[data-voice="${voice.id}"] .voice-play`);
        await waitFor(bob, id => state.voicePlayback?.messageId === id, voice.id);

        await bob.evaluate(() => stopVoicePlayback());

        // Lange Sprachnachricht (Grenzen fuer den Test verkuerzt): am Maximum stoppt die Aufnahme nur.
        await alice.evaluate(() => { VOICE_LIMITS.inlineSeconds = 2; VOICE_LIMITS.maxSeconds = 4; });
        const voiceCount = async page => page.evaluate(() => Object.values(state.chats).flat().filter(message => message.audioData).length);
        const sentBefore = await voiceCount(alice);
        await alice.click('#chat-voice-btn');
        await waitFor(alice, () => state.voiceRecording?.finished === true, null, 15000);
        assert.equal(await alice.isVisible('#chat-voice-direct-hint'), true, 'hint: the rest goes direct only');
        assert.match(await alice.textContent('#chat-voice-time'), /Maximum/);
        await alice.waitForTimeout(1500);
        assert.equal(await voiceCount(alice), sentBefore, 'nothing is sent automatically');
        await alice.click('#chat-voice-bar button[aria-label="Sprachnachricht senden"]');
        await waitFor(bob, () => Object.values(state.chats).flat().some(message => message.audioSplitAt && message.originalReady), null, 30000);
        const long = await bob.evaluate(() => Object.values(state.chats).flat().find(message => message.audioSplitAt));
        assert.ok(long.audioSplitAt >= 1.8 && long.audioSplitAt <= 3, `split at ${long.audioSplitAt}`);
        assert.ok(long.audioDuration >= 3.8, `total ${long.audioDuration}`);
        assert.match(long.original.mime, /^audio\//);
        await bob.click(`[data-voice="${long.id}"] .voice-play`);
        await waitFor(bob, () => state.voicePlayback?.part === 1, null, 15000);
        await bob.evaluate(() => stopVoicePlayback());

        // Fast volle Sprachnachricht ueber den Router-Cache (Bobs Kanal halb tot).
        await bob.evaluate(id => {
            const original = handleSignalingMessage;
            const originalInitiate = initiateP2PConnection;
            // Auch Bob selbst baut kein P2P auf (sonst holt er den Rest sofort ueber eine neue Verbindung).
            window.initiateP2PConnection = async () => {};
            window.restoreSignaling = () => {
                window.handleSignalingMessage = original;
                window.initiateP2PConnection = originalInitiate;
            };
            window.handleSignalingMessage = async message => (message.type === 'SDP_OFFER' ? undefined : original(message));
            state.dataChannels[id].onmessage = null;
            state.dataChannels[id].send = () => {};
        }, aliceId);
        await alice.evaluate(() => sendChatMessage(null, '', null, null, {
            audio: { data: `data:audio/webm;codecs=opus;base64,${'A'.repeat(140000)}`, duration: 58 }
        }));
        await waitFor(bob, () => Object.values(state.chats).flat().some(message => message.audioDuration === 58), null, 30000);
        assert.equal(await bob.evaluate(() => Object.values(state.chats).flat().find(message => message.audioDuration === 58).deliveredVia), 'Encrypted Path C', 'long voice message fits the router cache');

        // Lange Sprachnachricht ohne direkte Verbindung: der Anfang kommt ueber den Cache, beim Abspielen
        // wartet Bob am Ende des Anfangs; sobald P2P wieder steht, kommt der Rest und es geht weiter.
        await alice.click('#chat-voice-btn');
        await waitFor(alice, () => state.voiceRecording?.finished === true, null, 15000);
        await alice.click('#chat-voice-bar button[aria-label="Sprachnachricht senden"]');
        await waitFor(bob, count => Object.values(state.chats).flat().filter(message => message.audioSplitAt).length === count, 2, 40000);
        const offline = await bob.evaluate(() => Object.values(state.chats).flat().filter(message => message.audioSplitAt).sort((a, b) => b.createdAt - a.createdAt)[0]);
        assert.equal(offline.originalReady, undefined, 'rest not there yet');
        assert.equal(offline.deliveredVia, 'Encrypted Path C');
        assert.equal(await bob.isVisible(`#chat-message-${offline.id} .voice-rest-hint`), true);
        await bob.click(`[data-voice="${offline.id}"] .voice-play`);
        await waitFor(bob, () => state.voicePlayback?.waiting === true, null, 15000);
        await bob.evaluate(async id => {
            window.restoreSignaling();
            Object.values(state.webrtcConnections).forEach(connection => connection.close());
            delete state.dataChannels[id];
            delete state.sessionKeys[id];
            await initiateP2PConnection(id);
        }, aliceId);
        await waitFor(bob, () => state.voicePlayback?.part === 1, null, 40000);
        await bob.evaluate(() => stopVoicePlayback());

        // Video (nur P2P): neue, gesunde Verbindung.
        await bob.reload();
        await waitFor(bob, () => Boolean(state.ws && state.ws.readyState === 1));
        await bob.evaluate(async id => { switchTab('chat'); await openChatWithPeer(id); }, aliceId);
        await waitFor(alice, id => isSecureChannelOpen(id), bobId, 40000);
        await alice.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 240;
            const context = canvas.getContext('2d');
            const stream = canvas.captureStream(25);
            const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
            const chunks = [];
            recorder.ondataavailable = event => chunks.push(event.data);
            const stopped = new Promise(resolve => { recorder.onstop = resolve; });
            recorder.start(100);
            for (let frame = 0; frame < 30; frame++) {
                context.fillStyle = `hsl(${frame * 12} 80% 50%)`;
                context.fillRect(0, 0, 320, 240);
                await new Promise(resolve => setTimeout(resolve, 40));
            }
            recorder.stop();
            await stopped;
            await sendVideoFile(new File(chunks, 'clip.webm', { type: 'video/webm' }));
        });
        await waitFor(bob, () => Object.values(state.chats).flat().some(message => message.video));
        const videoMessage = await bob.evaluate(() => Object.values(state.chats).flat().find(message => message.video));
        assert.match(videoMessage.snapData, /^data:image\/jpeg/, 'poster image');
        assert.match(videoMessage.original.mime, /^video\/webm/);
        await waitFor(bob, () => Object.values(state.chats).flat().some(message => message.video && message.originalReady), null, 40000);
        await bob.click(`[data-video="${videoMessage.id}"]`);
        await waitFor(bob, () => !document.getElementById('video-viewer').classList.contains('hidden')
            && document.getElementById('video-viewer-video').src.startsWith('blob:'));
        assert.match(await bob.textContent('#video-viewer-title'), /Alice/);
        await bob.keyboard.press('Escape');
        await waitFor(bob, () => document.getElementById('video-viewer').classList.contains('hidden'));
        assert.equal(await bob.evaluate(() => document.getElementById('video-viewer-video').getAttribute('src')), null, 'blob released');

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (voice and video)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
