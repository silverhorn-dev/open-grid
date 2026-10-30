// End-to-End: Nacktbild-Filter (T3) mit einem Test-Modell (markiert rote Bilder). Ohne Modell und
// ohne Einschalten bleibt alles wie bisher; eingeschaltet erscheint ein fremdes Bild unscharf, der
// erste Tipp zeigt es (ohne den Viewer zu oeffnen), danach ist es auch im Viewer scharf.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function main() {
    if (process.env.MOBILE || process.env.OFFLINE) return;
    const browser = await chromium.launch();
    const pageErrors = [];
    try {
        const page = await (await browser.newContext({ locale: 'de-DE' })).newPage();
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(`${BASE_URL}/`);
        await page.waitForSelector('#complete-onboarding-btn', { state: 'visible', timeout: 20000 });
        const input = page.locator('#onboarding-profile-form input').first();
        await input.fill('Filter');
        await input.dispatchEvent('change');
        await page.click('#complete-onboarding-btn');
        await page.waitForTimeout(1500);

        assert.equal(await page.evaluate(() => state.nudityFilter), false, 'off by default');
        await page.evaluate(() => { switchTab('keys'); switchSettingsTab('media'); });
        assert.equal(await page.isVisible('#nudity-filter-no-model'), false, 'the router ships a model');

        // Echtes Modell vom Router (NSFWJS im Worker): fuenf Klassen, Summe ~1, Schwelle aus der Konfiguration.
        const real = await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 240;
            const context = canvas.getContext('2d');
            const gradient = context.createLinearGradient(0, 0, 320, 240);
            gradient.addColorStop(0, '#1e3a8a');
            gradient.addColorStop(1, '#a7f3d0');
            context.fillStyle = gradient;
            context.fillRect(0, 0, 320, 240);
            const bitmap = await createImageBitmap(canvas);
            const predictions = await classifyNudity(bitmap, 'nsfwjs');
            // Warteschlange: mehrere Bilder gleichzeitig angefragt, alle kommen nacheinander durch.
            const batch = await Promise.all(Array.from({ length: 5 }, () => classifyNudity(bitmap, 'nsfwjs').then(result => result.length)));
            return { config: state.appConfig.nudity, predictions, batch, workerStarted: Boolean(nudityWorker) };
        });
        // Standard ist NudeNet; ohne installiertes NudeNet (Repo ohne Docker) gilt nsfwjs.
        assert.equal(real.config.model, real.config.models.nudenet ? 'nudenet' : 'nsfwjs');
        assert.deepEqual(real.batch, [5, 5, 5, 5, 5], 'queued images all get checked');
        assert.equal(real.config.threshold, real.config.models.nudenet ? 0.4 : 0.7, 'default threshold of the active model');
        assert.equal(real.workerStarted, true);
        assert.deepEqual(real.predictions.map(entry => entry.className).sort(), ['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy']);
        const total = real.predictions.reduce((sum, entry) => sum + entry.probability, 0);
        assert.ok(Math.abs(total - 1) < 0.01, `probabilities sum to 1: ${total}`);

        // Testseite im Debug-Modus: Datei waehlen -> Werte je Klasse.
        await page.evaluate(() => document.querySelectorAll('.debug-only').forEach(element => element.classList.remove('debug-only')));
        const png = Buffer.from(await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 64;
            canvas.getContext('2d').fillRect(0, 0, 64, 64);
            return canvas.toDataURL('image/png').split(',')[1];
        }), 'base64');
        await page.selectOption('#nudity-test-model', 'nsfwjs');
        await page.setInputFiles('#nudity-test-input', { name: 'probe.png', mimeType: 'image/png', buffer: png });
        let report = '';
        for (let attempt = 0; attempt < 60 && !/Neutral \d+ %/.test(report); attempt += 1) {
            await page.waitForTimeout(500);
            report = await page.textContent('#nudity-test-results');
        }
        assert.match(report, /probe\.png/);
        assert.match(report, /nsfwjs · Sichtbar · \d+ % · \d+ ms · .*Neutral \d+ %/, report);

        // Vergleich: dasselbe Bild mit dem groesseren Modell (Graph-Modell).
        await page.selectOption('#nudity-test-model', 'nsfwjs-mid');
        await page.setInputFiles('#nudity-test-input', { name: 'probe-mid.png', mimeType: 'image/png', buffer: png });
        report = '';
        for (let attempt = 0; attempt < 90 && !/nsfwjs-mid · .*Neutral \d+ %/.test(report); attempt += 1) {
            await page.waitForTimeout(500);
            report = await page.textContent('#nudity-test-results');
        }
        assert.match(report, /probe-mid\.png.*nsfwjs-mid · \S+ · \d+ % · \d+ ms · .*Neutral \d+ %/, report);

        // Optionale Modelle (nur wenn der Router sie hat, z. B. NUDITY_MODEL_DIR mit fetch.sh befuellt).
        const optional = await page.evaluate(() => Object.keys(state.appConfig.nudity.models || {}).filter(id => ['bumble', 'nudenet'].includes(id)));
        const expectedClass = { bumble: /Lewd \d+ %/, nudenet: /(EXPOSED|COVERED|FACE)_?\w* \d+ %/ };
        for (const modelId of optional) {
            await page.selectOption('#nudity-test-model', modelId);
            await page.setInputFiles('#nudity-test-input', { name: `probe-${modelId}.png`, mimeType: 'image/png', buffer: png });
            report = '';
            for (let attempt = 0; attempt < 240 && !new RegExp(`${modelId} · `).test(report) && !/fehlgeschlagen|failed/i.test(report); attempt += 1) {
                await page.waitForTimeout(500);
                report = await page.textContent('#nudity-test-results');
            }
            assert.match(report, new RegExp(`probe-${modelId}\\.png.*${modelId} · Sichtbar · \\d+ % · \\d+ ms · `), report);
            assert.match(report, expectedClass[modelId], report);
            console.log(`optional model ${modelId}: ${report.slice(report.indexOf(`${modelId} · `)).slice(0, 160)}`);
        }

        // Ab hier deterministisch: nur das Test-Modell (rote Bilder).
        await page.evaluate(() => { nudityClassifiers.length = 0; });

        const result = await page.evaluate(async () => {
            const image = color => {
                const canvas = document.createElement('canvas');
                canvas.width = 400;
                canvas.height = 300;
                const context = canvas.getContext('2d');
                context.fillStyle = color;
                context.fillRect(0, 0, 400, 300);
                return canvas.toDataURL('image/png');
            };
            const centre = canvas => {
                const [r, g, b] = canvas.getContext('2d').getImageData(canvas.width / 2, 20, 1, 1).data;
                return [r, g, b];
            };
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            registerNudityClassifier({
                id: 'test-red',
                classify: async bitmap => {
                    const probe = new OffscreenCanvas(1, 1).getContext('2d');
                    probe.drawImage(bitmap, 0, 0, 1, 1);
                    const [r, g] = probe.getImageData(0, 0, 1, 1).data;
                    return r > 200 && g < 50 ? 0.99 : 0.01;
                }
            });
            await updateNudityFilter(true);
            const red = image('#ff0000');
            const green = image('#00ff00');
            let opened = 0;
            const flagged = createSecureImage(red, '');
            flagged.onclick = () => { opened += 1; };
            const harmless = createSecureImage(green, '');
            const mine = createSecureImage(red, '', null, { own: true });
            document.body.append(flagged, harmless, mine);
            await wait(500);
            const before = { blurred: flagged.dataset.nudityBlurred, pixel: centre(flagged), harmless: harmless.dataset.nudityBlurred, mine: mine.dataset.nudityBlurred };
            flagged.click();
            await wait(400);
            const after = { blurred: flagged.dataset.nudityBlurred || null, pixel: centre(flagged), opened };
            flagged.click();
            const secondClickOpened = opened;
            openImageViewer([red], 0);
            await wait(500);
            const viewerCanvas = document.getElementById('image-viewer-image');
            return { before, after, secondClickOpened, viewerBlurred: viewerCanvas.dataset.nudityBlurred || null, noModelHidden: document.getElementById('nudity-filter-no-model').classList.contains('hidden') };
        });
        assert.equal(result.noModelHidden, true);
        assert.equal(result.before.blurred, 'true');
        assert.ok(result.before.pixel[0] < 200, `blurred and darkened: ${result.before.pixel}`);
        assert.equal(result.before.harmless, undefined, 'harmless images stay sharp');
        assert.equal(result.before.mine, undefined, 'own images are never checked');
        assert.equal(result.after.blurred, null);
        assert.deepEqual(result.after.pixel, [255, 0, 0], 'revealed image is sharp');
        assert.equal(result.after.opened, 0, 'the revealing tap does not open the viewer');
        assert.equal(result.secondClickOpened, 1);
        assert.equal(result.viewerBlurred, null, 'revealed images stay visible in the viewer');

        // Warnung vor dem Senden: Treffer -> Nachfrage (Abbrechen stoppt), harmlos -> keine Nachfrage.
        const dialogs = [];
        const answer = { accept: false };
        const onDialog = dialog => {
            dialogs.push(dialog.message());
            return answer.accept ? dialog.accept() : dialog.dismiss();
        };
        page.on('dialog', onDialog);
        const sendCheck = color => page.evaluate(async fill => {
            const canvas = document.createElement('canvas');
            canvas.width = 200;
            canvas.height = 200;
            const context = canvas.getContext('2d');
            context.fillStyle = fill;
            context.fillRect(0, 0, 200, 200);
            return confirmNudeSend([canvas]);
        }, color);
        assert.equal(await sendCheck('#00ff00'), true, 'harmless image: no question');
        assert.equal(dialogs.length, 0);
        assert.equal(await sendCheck('#ff0000'), false, 'hit: cancel stops sending');
        assert.equal(dialogs[0], 'Das sieht nach einem Nacktbild aus. Trotzdem senden?');
        answer.accept = true;
        assert.equal(await sendCheck('#ff0000'), true, 'hit: confirmed');
        page.off('dialog', onDialog);

        // Bildbetrachter: ein unscharfes Bild im Viewer laesst sich per Tippen aufdecken (der Viewer faengt
        // den Zeiger auf der Buehne ab, der Klick erreicht die Canvas nicht).
        const viewerResult = await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 300;
            const context = canvas.getContext('2d');
            context.fillStyle = '#ff0000';
            context.fillRect(0, 0, 400, 300);
            // Andere Quelle als oben (die ist schon aufgedeckt).
            context.fillStyle = '#fe0000';
            context.fillRect(0, 0, 10, 10);
            const red = canvas.toDataURL('image/png');
            openImageViewer([red], 0);
            await new Promise(resolve => setTimeout(resolve, 500));
            return document.getElementById('image-viewer-image').dataset.nudityBlurred || null;
        });
        assert.equal(viewerResult, 'true', 'blurred in the viewer');
        const stage = await page.locator('#image-viewer-stage').boundingBox();
        await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => document.getElementById('image-viewer-image').dataset.nudityBlurred || null), null, 'a tap in the viewer reveals the image');
        assert.equal(await page.evaluate(() => viewer.scale), 1, 'the revealing tap does not zoom');
        await page.evaluate(() => closeImageViewer());

        // Snap-Viewer: die Canvas bekommt keine Klicks; Tippen auf den Viewer deckt auf, erst dann laeuft die Zeit.
        const snap = await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 300;
            canvas.height = 300;
            const context = canvas.getContext('2d');
            context.fillStyle = '#ff0000';
            context.fillRect(0, 0, 300, 300);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            openSecureSnapViewer('');
            state.secureSnapViewing = { mode: 'received', peerId: 'x', snapId: 'y', pendingCountdown: 5 };
            const image = document.getElementById('secure-snap-image');
            delete image.dataset.ownImage;
            await drawSecureImage(image, blob);
            image.classList.remove('hidden');
            return { blurred: image.dataset.nudityBlurred || null };
        });
        assert.equal(snap.blurred, 'true', 'snap blurred');
        assert.equal(await page.isVisible('#secure-snap-countdown'), false, 'no countdown while blurred');
        const box = await page.locator('#secure-snap-viewer').boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(400);
        assert.equal(await page.evaluate(() => document.getElementById('secure-snap-image').dataset.nudityBlurred || null), null, 'tap on the viewer reveals the snap');
        assert.equal(await page.isVisible('#secure-snap-countdown'), true, 'countdown starts after revealing');
        await page.evaluate(() => closeSecureSnapViewer());

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (nudity filter)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
