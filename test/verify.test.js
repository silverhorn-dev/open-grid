import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import jpeg from 'jpeg-js';
import { buildApp } from '../server/app.js';
import { createStore } from '../server/database.js';
import { ALIGN_TEMPLATE, decodeYuNet, headYaw, poseMatches, similarityTransform } from '../server/face-verify.js';
import { checkVerification } from '../server/verify.js';

test('YuNet output: anchor-free decoding to box + 5 points in image coordinates, with NMS', () => {
    const outputs = {};
    for (const stride of [8, 16, 32]) {
        const cells = (640 / stride) ** 2;
        outputs[`cls_${stride}`] = new Float32Array(cells);
        outputs[`obj_${stride}`] = new Float32Array(cells);
        outputs[`bbox_${stride}`] = new Float32Array(cells * 4);
        outputs[`kps_${stride}`] = new Float32Array(cells * 10);
    }
    // Ein Gesicht in Zelle (Zeile 5, Spalte 7) der Stufe 32, dazu ein schwaecherer Doppeltreffer daneben.
    const put = (stride, row, col, score) => {
        const index = row * (640 / stride) + col;
        outputs[`cls_${stride}`][index] = score;
        outputs[`obj_${stride}`][index] = score;
        // Gleiche Groesse in Pixeln (128 x 160) auf beiden Stufen.
        outputs[`bbox_${stride}`].set([0.5, 0.5, Math.log(128 / stride), Math.log(160 / stride)], index * 4);
        outputs[`kps_${stride}`].set([0.2, 0.3, 0.8, 0.3, 0.5, 0.5, 0.3, 0.7, 0.7, 0.7], index * 10);
    };
    put(32, 5, 7, 0.9);
    put(16, 11, 15, 0.7);
    const faces = decodeYuNet(outputs, { scale: 0.5 });
    assert.equal(faces.length, 1, 'overlapping weaker hit removed');
    const [face] = faces;
    assert.ok(Math.abs(face.score - 0.9) < 1e-6);
    // Mitte (7.5, 5.5) * 32 = (240, 176), Groesse 128 x 160, zurueck auf das Bild: / 0.5.
    assert.deepEqual(face.box.map(value => Math.round(value)), [352, 192, 256, 320]);
    assert.deepEqual(face.landmarks[2].map(value => Math.round(value)), [480, 352], 'nose');
});

test('head pose from the 5 points: straight, turned to the own left (nose right in the image), turned right', () => {
    const face = noseOffset => [[100, 100], [160, 100], [130 + noseOffset, 130], [110, 160], [150, 160]];
    assert.ok(Math.abs(headYaw(face(0))) < 0.01);
    assert.equal(poseMatches('straight', headYaw(face(3))), true);
    assert.equal(poseMatches('left', headYaw(face(20))), true);
    assert.equal(poseMatches('right', headYaw(face(-20))), true);
    assert.equal(poseMatches('left', headYaw(face(-20))), false);
    assert.equal(poseMatches('straight', headYaw(face(20))), false);
});

test('alignment: the template maps onto itself, a scaled/moved face back onto the template', () => {
    const identity = similarityTransform(ALIGN_TEMPLATE, ALIGN_TEMPLATE);
    assert.ok(Math.abs(identity.scale - 1) < 1e-9 && Math.abs(identity.cos - 1) < 1e-9 && Math.abs(identity.tx) < 1e-9);
    const moved = ALIGN_TEMPLATE.map(([x, y]) => [x * 2 + 100, y * 2 + 50]);
    const transform = similarityTransform(moved, ALIGN_TEMPLATE);
    const [x, y] = moved[2];
    const mapped = [transform.scale * (transform.cos * x - transform.sin * y) + transform.tx, transform.scale * (transform.sin * x + transform.cos * y) + transform.ty];
    assert.ok(Math.hypot(mapped[0] - ALIGN_TEMPLATE[2][0], mapped[1] - ALIGN_TEMPLATE[2][1]) < 1e-6);
});

// Ersatz-Modelle: Bilder werden an ihrer Breite erkannt (Profil 40 px, Schritte 20/21/22 px).
const STRAIGHT = [[100, 100], [160, 100], [130, 130], [110, 160], [150, 160]];
const pose = { straight: STRAIGHT, left: STRAIGHT.map(([x, y], index) => (index === 2 ? [x + 20, y] : [x, y])), right: STRAIGHT.map(([x, y], index) => (index === 2 ? [x - 20, y] : [x, y])) };
function fakeModels({ person = [1, 0, 0], profilePerson = [1, 0, 0], faces = 1, posesByWidth = {} } = {}) {
    return {
        async detect(image) {
            if (image.width === 40) return [{ score: 0.9, box: [0, 0, 120, 120], landmarks: STRAIGHT }];
            return Array.from({ length: faces }, () => ({ score: 0.9, box: [0, 0, 120, 120], landmarks: pose[posesByWidth[image.width]] }));
        },
        async embed(image) {
            return image.width === 40 ? profilePerson : person;
        }
    };
}
const image = width => ({ width, height: width });

test('verification check: one face per step, matching pose, same person in all steps and on the profile picture', async () => {
    const steps = ['left', 'straight', 'right'];
    const posesByWidth = { 20: 'left', 21: 'straight', 22: 'right' };
    const frames = [image(20), image(21), image(22)];
    const run = options => checkVerification({ steps, frames, profileImage: image(40), threshold: 0.363, models: fakeModels({ posesByWidth, ...options }) });
    assert.deepEqual(await run({}), { ok: true });
    assert.equal((await run({ profilePerson: [0, 1, 0] })).reason, 'mismatch', 'someone else on the profile picture');
    assert.equal((await run({ faces: 2 })).reason, 'many-faces');
    assert.equal((await run({ faces: 0 })).reason, 'no-face');
    // Foto vom Foto: ueberall geradeaus.
    assert.deepEqual(await run({ posesByWidth: { 20: 'straight', 21: 'straight', 22: 'straight' } }), { ok: false, reason: 'pose', step: 'left' });
});

// ----- Routen -----
function tinyJpeg(width) {
    const data = Buffer.alloc(width * width * 4, 128);
    return `data:image/jpeg;base64,${jpeg.encode({ data, width, height: width }, 80).data.toString('base64')}`;
}

async function registered(app, peerId) {
    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const authToken = randomBytes(32).toString('base64url');
    const registrationId = `registration-${peerId}`;
    const signature = sign('sha256', Buffer.from(JSON.stringify({ peerId, registrationId, authToken })), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    const response = await app.inject({ method: 'POST', url: '/api/register', payload: { peerId, registrationId, geohash: 'u10j2k', authToken, registrationProof: { publicKey: keys.publicKey.export({ format: 'jwk' }), signature } } });
    assert.equal(response.statusCode, 200);
    return { authorization: `Bearer ${response.json().authToken}` };
}

async function clientVerify(badge, sig, key) {
    const context = vm.createContext({ TextEncoder, Uint8Array, window: { atob, btoa, crypto: webcrypto } });
    vm.runInContext(`${readFileSync(new URL('../client/crypto.client.js', import.meta.url), 'utf8')}\nthis.verify = verifyOperationSignature;`, context);
    return context.verify({ ...badge, sig }, { kty: 'EC', crv: 'P-256', x: key.x, y: key.y });
}

test('verification routes: steps, check, badge signed by the router (verifiable like profile signatures), grid flag', async () => {
    const posesByWidth = {};
    const models = fakeModels({ posesByWidth });
    const store = createStore(':memory:');
    const app = await buildApp({ store, metrics: false, verifySettings: { enabled: true, threshold: 0.363, days: 90 }, verifyModels: models });
    try {
        const config = (await app.inject({ method: 'GET', url: '/api/config' })).json().verify;
        assert.equal(config.enabled, true);
        assert.ok(config.key.x && config.key.y);
        const headers = await registered(app, 'peer-v');
        const started = await app.inject({ method: 'POST', url: '/api/verify/start', headers, payload: { peerId: 'peer-v' } });
        assert.equal(started.statusCode, 200);
        const { sessionId, steps } = started.json();
        assert.deepEqual([...steps].sort(), ['left', 'right', 'straight']);
        // Bild je Schritt (Breite 20 + Index), passende Haltung.
        steps.forEach((step, index) => { posesByWidth[20 + index] = step; });
        const frames = steps.map((_, index) => tinyJpeg(20 + index));
        const profileImage = tinyJpeg(40);
        const avatarSha256 = createHash('sha256').update(profileImage).digest('base64');
        assert.equal((await app.inject({ method: 'POST', url: '/api/verify/finish', headers, payload: { peerId: 'peer-v', sessionId, frames, profileImage, avatarSha256: 'falsch' } })).json().reason, 'profile-hash');
        // Sitzung ist nach einem Versuch verbraucht: neue holen.
        const again = (await app.inject({ method: 'POST', url: '/api/verify/start', headers, payload: { peerId: 'peer-v' } })).json();
        again.steps.forEach((step, index) => { posesByWidth[20 + index] = step; });
        const finished = await app.inject({ method: 'POST', url: '/api/verify/finish', headers, payload: { peerId: 'peer-v', sessionId: again.sessionId, frames, profileImage, avatarSha256 } });
        const result = finished.json();
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.badge.subject, 'peer-v');
        assert.equal(result.badge.avatarSha256, avatarSha256);
        assert.ok(result.badge.expiresAt - result.badge.issuedAt === 90 * 24 * 60 * 60 * 1000);
        assert.equal(await clientVerify(result.badge, result.sig, config.key), true, 'client can check the router signature');
        assert.equal(await clientVerify({ ...result.badge, subject: 'peer-x' }, result.sig, config.key), false, 'bound to the subject');
        const grid = (await app.inject({ method: 'GET', url: '/api/grid?geohash=u10j2k' })).json().peers;
        assert.equal(grid.find(peer => peer.id === 'peer-v')?.verified, true);
        // Hoechstens 5 Versuche am Tag.
        for (let attempt = 0; attempt < 3; attempt++) await app.inject({ method: 'POST', url: '/api/verify/start', headers, payload: { peerId: 'peer-v' } });
        assert.equal((await app.inject({ method: 'POST', url: '/api/verify/start', headers, payload: { peerId: 'peer-v' } })).statusCode, 429);
    } finally {
        await app.close();
    }
    // Aus (Standard): keine Route, kein Haken im Grid.
    const off = await buildApp({ store: createStore(':memory:'), metrics: false });
    try {
        assert.equal((await off.inject({ method: 'GET', url: '/api/config' })).json().verify.enabled, false);
        const headers = await registered(off, 'peer-w');
        assert.equal((await off.inject({ method: 'POST', url: '/api/verify/start', headers, payload: { peerId: 'peer-w' } })).statusCode, 404);
    } finally {
        await off.close();
    }
});
