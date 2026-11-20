// End-to-End: Sprachnachricht verschriftlichen (stt.js, Board T38 C). Der Router meldet hier ein Modell (nachgebaut),
// Whisper selbst ist durch einen Ersatz ersetzt (echter Test mit Modell: lokal mit den Dateien aus der Docker-Stufe).
// Knopf "Text" an der Sprachnachricht, danach steht der Text dort und bleibt nach dem Neuzeichnen; nur lokal.
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
    try {
        const context = await browser.newContext({ locale: 'de-DE' });
        await context.route('**/api/config', async route => {
            const response = await route.fetch();
            const config = await response.json();
            config.stt = { model: 'whisper-base', sizeMb: 77, library: '/vendor/whisper/x/transformers.min.js', wasmPaths: '/vendor/whisper/x/', modelBase: '/vendor/whisper/x/models/' };
            await route.fulfill({ response, json: config });
        });
        const page = await context.newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Alice');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await waitFor(page, () => Boolean(state.myProfile?.id && state.appConfig?.stt));
        // Eine empfangene Sprachnachricht (kurzer stiller Opus-Clip), Chat offen; Whisper ersetzt.
        await page.evaluate(async () => {
            window.decodeVoiceToMono16k = async () => new Float32Array(16000);
            window.runSttWorker = async (audio, onStatus) => {
                onStatus('working');
                await new Promise(resolve => setTimeout(resolve, 1500));
                return 'bin gleich da';
            };
            const peerId = 'peer-stt';
            state.chats[peerId] = [{ id: 'voice-1', senderId: peerId, audioData: 'data:audio/webm;base64,GkXfow==', audioDuration: 2, createdAt: Date.now(), timestamp: '10:00' }];
            state.activeChatPeerId = peerId;
            switchTab('chat');
            renderChatHistory();
        });
        await page.waitForSelector('[data-stt-button="voice-1"]', { timeout: 5000 });
        await page.click('[data-stt-button="voice-1"]');
        await waitFor(page, () => /Wird verschriftlicht/.test(document.querySelector('[data-stt-status="voice-1"]')?.textContent || ''), undefined, 3000);
        // Neu zeichnen waehrend der Arbeit (z. B. neue Nachricht): Status bleibt sichtbar.
        await page.evaluate(() => renderChatHistory());
        assert.match(await page.textContent('[data-stt-status="voice-1"]'), /Wird verschriftlicht/);
        await waitFor(page, () => document.querySelector('.voice-transcript')?.textContent === 'bin gleich da');
        assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-stt-button="voice-1"]'))), false, 'button gone once there is a text');
        assert.equal(await page.evaluate(() => state.chats['peer-stt'][0].localTranscript), 'bin gleich da');
        // Mitgeschickter Text des Absenders: kein Knopf.
        await page.evaluate(() => {
            state.chats['peer-stt'].push({ id: 'voice-2', senderId: 'peer-stt', audioData: 'data:audio/webm;base64,GkXfow==', audioDuration: 2, transcript: 'schon da', createdAt: Date.now(), timestamp: '10:01' });
            renderChatHistory();
        });
        assert.equal(await page.evaluate(() => Boolean(document.querySelector('[data-stt-button="voice-2"]'))), false);
        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (transcription)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
