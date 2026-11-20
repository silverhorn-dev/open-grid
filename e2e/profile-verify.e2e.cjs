// End-to-End: Profilbild verifizieren (verify.js, Board T37 V2). Alice laedt ein Profilbild hoch, stimmt zu,
// die "Kamera" (Canvas) und ein nachgebauter Erkenner fuehren durch die Schritte, je Schritt mehrere Ausschnitte; die Router-Antworten (/api/verify/*) sind hier nachgebaut, die
// echte Pruefung testet test/verify.test.js. Danach traegt Alices Profil den Haken, Bob bekommt ihn mit dem
// Profil und sieht ihn (Profil-Popup, Chat-Kopf, Grid-Karte, Filter "nur verifizierte", Board T37 V3); ein neues
// Profilbild nimmt ihn wieder weg. Der nachgebaute Router signiert wie server/verify.js (P-256, kanonisches JSON).
const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { chromium } = require('playwright');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const ROUTER_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ROUTER_JWK = ROUTER_KEY.publicKey.export({ format: 'jwk' });
const canonical = value => (value === null || typeof value !== 'object' ? JSON.stringify(value)
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`);
const signBadge = badge => sign('sha256', Buffer.from(canonical(badge)), { key: ROUTER_KEY.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');

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
    const finished = [];
    const verifiedIds = new Set();
    async function user(name, verifyRouter = false) {
        const context = await browser.newContext({ locale: 'de-DE' });
        await context.route('**/api/config', async route => {
            const response = await route.fetch();
            const config = await response.json();
            config.verify = { enabled: true, key: { x: ROUTER_JWK.x, y: ROUTER_JWK.y }, steps: ['straight', 'left', 'right'], days: 90 };
            await route.fulfill({ response, json: config });
        });
        // Grid-Markierung des Routers fuer Verifizierte.
        await context.route(/\/api\/grid(\?|$)/, async route => {
            const response = await route.fetch();
            const grid = await response.json();
            (grid.peers || []).forEach(peer => { if (verifiedIds.has(peer.id)) peer.verified = true; });
            await route.fulfill({ response, json: grid });
        });
        if (verifyRouter) {
            await context.route('**/api/verify/start', route => route.fulfill({
                json: { sessionId: 'session-1', steps: ['straight', 'left', 'right'], expiresAt: Date.now() + 180000, maxFrames: 48 }
            }));
            await context.route('**/api/verify/finish', route => {
                const body = route.request().postDataJSON();
                finished.push(body);
                const now = Date.now();
                const badge = { subject: body.peerId, avatarSha256: body.avatarSha256, issuedAt: now, expiresAt: now + 90 * 86400000 };
                verifiedIds.add(body.peerId);
                return route.fulfill({ json: { ok: true, badge, sig: signBadge(badge) } });
            });
        }
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
    async function uploadAvatar(page, shade) {
        const png = await page.evaluate(value => {
            const canvas = document.createElement('canvas');
            canvas.width = 400;
            canvas.height = 400;
            const context = canvas.getContext('2d');
            context.fillStyle = `rgb(${value}, 120, 160)`;
            context.fillRect(0, 0, 400, 400);
            return canvas.toDataURL('image/png').split(',')[1];
        }, shade);
        const before = await page.evaluate(() => state.myProfile.avatarFull?.id || null);
        await page.setInputFiles('input[data-change="handleAvatarUpload"]', { name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
        await waitFor(page, previous => Boolean(state.myProfile.avatarFull?.id) && state.myProfile.avatarFull.id !== previous, before);
    }
    try {
        const alice = await user('Alice', true);
        const bob = await user('Bob');
        const [aliceId, bobId] = await Promise.all([alice, bob].map(page => page.evaluate(() => state.myProfile.id)));

        // Profil-Editor (Entdecken-Profil). Ohne Profilbild: Knopf aus.
        await alice.evaluate(async () => { await setAppMode('discovery'); switchTab('editprofile'); renderVerifyCard(); });
        assert.equal(await alice.evaluate(() => document.getElementById('verify-card').classList.contains('hidden')), false, 'card shown when the router verifies');
        assert.equal(await alice.evaluate(() => document.getElementById('verify-start-btn').disabled), true, 'needs a profile picture');

        await uploadAvatar(alice, 200);
        await alice.evaluate(() => renderVerifyCard());
        assert.equal(await alice.evaluate(() => document.getElementById('verify-start-btn').disabled), false);

        // Kamera = Canvas; Gesichtserkenner nachgebaut: ein Gesicht, das der Anleitung folgt (geradeaus/links/rechts).
        await alice.evaluate(() => {
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            const context = canvas.getContext('2d');
            let frame = 0;
            setInterval(() => {
                context.fillStyle = `hsl(${frame++ % 360}, 60%, 50%)`;
                context.fillRect(0, 0, 640, 480);
            }, 100);
            canvas.style.cssText = 'position:fixed;left:-9999px';
            document.body.append(canvas);
            navigator.mediaDevices.getUserMedia = async constraints => {
                window.verifyCameraConstraints = constraints;
                return canvas.captureStream(10);
            };
            window.verifyDetections = 0;
            state.verifyDetector = {
                async detect() {
                    window.verifyDetections++;
                    const step = document.getElementById('verify-instruction')?.dataset.step || 'straight';
                    // Erst ein paar Bilder "noch nicht gedreht", dann in der verlangten Haltung.
                    const turned = window.verifyDetections % 6 > 1;
                    const nose = !turned ? 0 : step === 'left' ? 40 : step === 'right' ? -40 : 0;
                    return [{ score: 0.9, box: [220, 140, 200, 200], landmarks: [[270, 200], [370, 200], [320 + nose, 250], [280, 300], [360, 300]] }];
                }
            };
        });
        await alice.click('#verify-start-btn');
        await alice.waitForSelector('#verify-consent-btn', { state: 'visible' });
        await alice.click('#verify-consent-btn');
        // Schritte in der Reihenfolge des Routers, mit Anweisung und Live-Hinweis.
        await waitFor(alice, () => document.getElementById('verify-instruction')?.dataset.step === 'straight');
        await waitFor(alice, () => document.getElementById('verify-instruction')?.dataset.step === 'left', undefined, 15000);
        assert.match(await alice.textContent('#verify-instruction'), /links/);
        await waitFor(alice, () => /links|halten/.test(document.getElementById('verify-hint').textContent));
        await waitFor(alice, () => document.getElementById('verify-instruction')?.dataset.step === 'right', undefined, 15000);
        await waitFor(alice, () => Boolean(ownVerification()), undefined, 20000);
        assert.equal(await alice.evaluate(() => window.verifyCameraConstraints.video.facingMode), 'user', 'front camera');

        // Was an den Router ging: Folge von Gesichtsausschnitten je Schritt (in Reihenfolge, mit Zeit), Profilbild + Hash.
        assert.equal(finished.length, 1);
        const sent = finished[0];
        assert.equal(sent.sessionId, 'session-1');
        assert.deepEqual([...new Set(sent.frames.map(frame => frame.step))], ['straight', 'left', 'right']);
        assert.ok(sent.frames.length >= 12 && sent.frames.length <= 48, `${sent.frames.length} frames`);
        assert.ok(sent.frames.every((frame, index) => index === 0 || frame.t > sent.frames[index - 1].t), 'time goes forward');
        assert.ok(sent.frames.every(frame => frame.data.startsWith('data:image/jpeg;base64,')));
        assert.ok(sent.frames.every(frame => frame.data.length < 60000), 'small face crops, not full frames');
        assert.equal(sent.avatarSha256, createHash('sha256').update(sent.profileImage).digest('base64'));
        assert.equal(sent.avatarSha256, await alice.evaluate(() => state.myProfile.avatarFull.sha256));
        // Kamera wieder aus.
        assert.equal(await alice.evaluate(() => document.getElementById('verify-video')?.srcObject || null), null);

        // Haken im Profil: Karte und Profil fuer andere.
        await alice.evaluate(() => renderVerifyCard());
        assert.ok(await alice.evaluate(() => document.getElementById('verify-card').classList.contains('is-verified')));
        assert.equal(await alice.evaluate(id => buildProfilePayloadFor(id).verified?.badge.subject, bobId), aliceId);
        await bob.evaluate(async () => { await setAppMode('discovery'); switchTab('grid'); });
        await bob.evaluate(id => openProfileModal(id), aliceId);
        await waitFor(bob, id => state.cachedProfiles[id]?.verified?.badge?.subject === id, aliceId);
        // V3: Bob prueft den Haken mit dem Router-Schluessel und sieht ihn im Profil.
        await waitFor(bob, () => !document.getElementById('modal-profile-verified').classList.contains('hidden'));
        assert.equal(await bob.evaluate(id => checkPeerVerification(id), aliceId), true);
        // Gefaelscht (anderes Bild im Haken): nicht anerkannt.
        assert.equal(await bob.evaluate(id => checkPeerVerification(id, { ...state.cachedProfiles[id], verified: { ...state.cachedProfiles[id].verified, badge: { ...state.cachedProfiles[id].verified.badge, avatarSha256: 'x' } }, avatarFull: { ...state.cachedProfiles[id].avatarFull, sha256: 'x' } }), aliceId), false);
        await bob.evaluate(() => closeProfileModal());
        // Grid-Karte mit Haken; Filter "nur verifizierte" laesst Alice drin.
        await bob.evaluate(() => refreshGrid?.());
        await waitFor(bob, id => state.peers.some(peer => peer.id === id && peer.verified), aliceId);
        await bob.evaluate(() => renderDiscoveryGrid());
        await waitFor(bob, () => document.querySelectorAll('span.verified-badge.absolute').length > 0);
        await bob.evaluate(() => updateGridFilter({ verified: true }));
        assert.equal(await bob.evaluate(id => gridFilterVerdict(id, state.peers.find(peer => peer.id === id)), aliceId), 'match');
        assert.equal(await bob.evaluate(() => gridFilterVerdict('someone-else', { id: 'someone-else' })), 'no');
        await bob.evaluate(() => updateGridFilter({ verified: false }));
        // Chat-Kopf.
        await bob.evaluate(id => openChatWithPeer(id), aliceId);
        await waitFor(bob, () => !document.getElementById('chat-peer-verified').classList.contains('hidden'));

        // V4: Bob laesst im Dating nur Verifizierte schreiben. Alice (verifiziert) kommt durch, Carol nicht.
        const carol = await user('Carol');
        const carolId = await carol.evaluate(() => state.myProfile.id);
        await bob.evaluate(async () => { switchTab('keys'); await updateMatchingSetting('chatVerifiedOnly', true); });
        assert.equal(await bob.evaluate(() => getMyChatPolicy().verifiedOnly), true);
        assert.equal(await bob.evaluate(() => !document.getElementById('chat-verified-row').classList.contains('hidden')), true, 'setting shown when the router verifies');
        assert.equal(await bob.evaluate(id => shouldHoldIncomingMessage(id, { id: 'probe-c', senderId: id, text: 'hi' }), carolId), true, 'unverified sender held');
        assert.equal(await bob.evaluate(id => shouldHoldIncomingMessage(id, { id: 'probe-a', senderId: id, text: 'hi' }), aliceId), false, 'verified sender passes');
        // Absender-Sicht: Carol sieht den Grund, sobald sie Bobs Profil kennt; Alice darf schreiben.
        await carol.evaluate(async () => { await setAppMode('discovery'); });
        await carol.evaluate(id => openProfileModal(id), bobId);
        await waitFor(carol, id => state.cachedProfiles[id]?.chatPolicy?.verifiedOnly === true, bobId);
        const carolAllowance = await carol.evaluate(id => getPeerChatAllowance(id), bobId);
        assert.equal(carolAllowance.allowed, false);
        assert.match(carolAllowance.reason, /verifiziert/);
        await alice.evaluate(async () => { await setAppMode('discovery'); });
        await alice.evaluate(id => openProfileModal(id), bobId);
        await waitFor(alice, id => state.cachedProfiles[id]?.chatPolicy?.verifiedOnly === true, bobId);
        assert.equal(await alice.evaluate(id => getPeerChatAllowance(id).allowed, bobId), true);
        await alice.evaluate(async id => { await openChatWithPeer(id); document.getElementById('chat-input').value = 'hallo verifiziert'; await sendChatMessage(); }, bobId);
        await waitFor(bob, id => (state.chats[id] || []).some(message => message.text === 'hallo verifiziert' && !message.held), aliceId);
        // Chat-Gate fuer den Service Worker: "V".
        assert.equal(await bob.evaluate(() => databaseRequest('keys', 'readonly', store => store.get('chat-gate')).then(gate => gate.mode)), 'V');

        // Neues Profilbild: Haken weg.
        await uploadAvatar(alice, 40);
        assert.equal(await alice.evaluate(() => ownVerification()), null);
        assert.equal(await alice.evaluate(id => buildProfilePayloadFor(id).verified, bobId), undefined);

        assert.deepEqual(pageErrors, [], `no uncaught page errors: ${pageErrors.join(' | ')}`);
        console.log('E2E OK (profile verification)');
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error('E2E FAILED', error);
    process.exit(1);
});
