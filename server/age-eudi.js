import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, X509Certificate } from 'node:crypto';
import { cborEncode, DataItem, Verifier } from '@animo-id/mdoc';

// ================= EU-ALTERSNACHWEIS UEBER DIE WALLET (AGE_PROVIDER=eudi, Board T2) =================
// Ablauf (gleiches Geraet, W3C Digital Credentials API + OpenID4VP 1.0, unsigniert, unverschluesselt):
//   1. start: der Router erzeugt eine Nonce (5 Minuten gueltig) und eine DCQL-Anfrage, die nur
//      `age_over_18` verlangt (EU-Altersnachweis, EU-PID oder ISO-Fuehrerschein, je nach Konfiguration).
//   2. Die App ruft navigator.credentials.get({ digital }) auf; der Nutzer waehlt seine Wallet.
//   3. finish: der Router prueft die mdoc-Antwort (Ausstellersignatur gegen die Vertrauensanker aus
//      age-trust.js, Geraetesignatur ueber Nonce + Herkunft der Seite, Gueltigkeit) und liest nur
//      `age_over_18`. Gespeichert wird davon nur "18+" und ein HMAC des Geraeteschluessels (fuer Sperren).
// Grenzen: Wallets duerfen unregistrierte Anfragen ablehnen (Registrierung als Relying Party ist je
// nach Land Pflicht); Wallets mit wechselnden Geraeteschluesseln machen Sperren pro Wallet wirkungslos.
export const EUDI_DOCTYPES = {
    av: { docType: 'eu.europa.ec.av.1', nameSpace: 'eu.europa.ec.av.1' },
    pid: { docType: 'eu.europa.ec.eudi.pid.1', nameSpace: 'eu.europa.ec.eudi.pid.1' },
    mdl: { docType: 'org.iso.18013.5.1.mDL', nameSpace: 'org.iso.18013.5.1' }
};
const REQUEST_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 10000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const HASHES = { ES256: 'sha256', ES384: 'sha384', ES512: 'sha512', EdDSA: null };

export function parseEudiDoctypes(value) {
    const wanted = String(value ?? '').split(',').map(entry => entry.trim().toLowerCase()).filter(entry => EUDI_DOCTYPES[entry]);
    return wanted.length ? [...new Set(wanted)] : ['av', 'pid', 'mdl'];
}

// ----- Kryptografie fuer @animo-id/mdoc, nur node:crypto -----
function nameField(distinguishedName, field) {
    return String(distinguishedName).split('\n').map(line => line.split('='))
        .filter(([key]) => key === field).map(([, ...rest]) => rest.join('='));
}

function validateChain({ trustedCertificates, x5chain, now }) {
    const chain = x5chain.map(der => new X509Certificate(Buffer.from(der)));
    const trusted = trustedCertificates.map(der => new X509Certificate(Buffer.from(der)));
    for (const certificate of chain) {
        if (new Date(certificate.validFrom) > now || new Date(certificate.validTo) < now) throw new Error('Certificate in chain is not valid now');
    }
    for (let index = 0; index < chain.length - 1; index += 1) {
        if (!chain[index].checkIssued(chain[index + 1]) || !chain[index].verify(chain[index + 1].publicKey)) {
            throw new Error('Broken certificate chain');
        }
    }
    // Anker = ein Zertifikat der Kette selbst (z. B. die EU-Liste nennt den Aussteller direkt)
    // oder die Zertifizierungsstelle, die das letzte Zertifikat der Kette ausgestellt hat.
    const anchored = chain.some(certificate => trusted.some(anchor => anchor.raw.equals(certificate.raw)))
        || trusted.some(anchor => chain.at(-1).checkIssued(anchor) && chain.at(-1).verify(anchor.publicKey));
    if (!anchored) throw new Error('Issuer is not trusted');
}

export function createMdocContext(now = () => new Date()) {
    return {
        crypto: {
            random: length => new Uint8Array(randomBytes(length)),
            digest: ({ digestAlgorithm, bytes }) => new Uint8Array(createHash(digestAlgorithm.replace('-', '').toLowerCase()).update(bytes).digest()),
            calculateEphemeralMacKeyJwk: () => {
                throw new Error('MAC device authentication is not supported');
            }
        },
        cose: {
            sign1: {
                sign: ({ sign1, jwk }) => {
                    const { data, alg } = sign1.getRawSigningData();
                    if (!(alg in HASHES)) throw new Error(`Unsupported algorithm ${alg}`);
                    return new Uint8Array(sign(HASHES[alg], data, { key: createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }));
                },
                verify: ({ jwk, sign1, options }) => {
                    const { alg, signature, data } = sign1.getRawVerificationData(options);
                    if (!(alg in HASHES)) return false;
                    return verify(HASHES[alg], data, { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, signature);
                }
            },
            mac0: {
                sign: () => {
                    throw new Error('MAC device authentication is not supported');
                },
                verify: () => false
            }
        },
        x509: {
            getIssuerNameField: ({ certificate, field }) => nameField(new X509Certificate(Buffer.from(certificate)).issuer, field),
            getPublicKey: ({ certificate }) => new X509Certificate(Buffer.from(certificate)).publicKey.export({ format: 'jwk' }),
            validateCertificateChain: ({ trustedCertificates, x5chain }) => validateChain({ trustedCertificates, x5chain, now: now() }),
            getCertificateData: ({ certificate }) => {
                const parsed = new X509Certificate(Buffer.from(certificate));
                return {
                    issuerName: parsed.issuer,
                    subjectName: parsed.subject,
                    serialNumber: parsed.serialNumber,
                    thumbprint: parsed.fingerprint256.replaceAll(':', '').toLowerCase(),
                    notBefore: new Date(parsed.validFrom),
                    notAfter: new Date(parsed.validTo),
                    pem: parsed.toString()
                };
            }
        }
    };
}

// SessionTranscript fuer OpenID4VP ueber die DC API: 1.0 ([origin, nonce, null], unverschluesselt) und,
// fuer aeltere Wallets, Draft 24 ([origin, client_id, nonce] mit client_id "web-origin:<origin>").
export function eudiSessionTranscripts({ origin, nonce }) {
    const handover = info => cborEncode(DataItem.fromData([
        null,
        null,
        ['OpenID4VPDCAPIHandover', new Uint8Array(createHash('sha256').update(cborEncode(info)).digest())]
    ]));
    return [handover([origin, nonce, null]), handover([origin, `web-origin:${origin}`, nonce])];
}

export function eudiRequest({ nonce, doctypes }) {
    const credentials = doctypes.map(id => ({
        id,
        format: 'mso_mdoc',
        meta: { doctype_value: EUDI_DOCTYPES[id].docType },
        claims: [{ path: [EUDI_DOCTYPES[id].nameSpace, 'age_over_18'] }]
    }));
    return {
        response_type: 'vp_token',
        response_mode: 'dc_api',
        nonce,
        dcql_query: { credentials, credential_sets: [{ options: credentials.map(credential => [credential.id]) }] }
    };
}

// vp_token aus der Antwort der DC API: { <credential-id>: [<base64url DeviceResponse>] } (1.0) oder
// direkt ein String (aeltere Fassungen).
function deviceResponsesFrom(payload) {
    let data = payload?.data ?? payload;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            return [];
        }
    }
    const token = data?.vp_token;
    const values = typeof token === 'string' ? [token] : Object.values(token || {}).flat();
    return values.filter(value => typeof value === 'string' && value.length <= MAX_RESPONSE_BYTES * 2)
        .map(value => new Uint8Array(Buffer.from(value, 'base64url')));
}

export function createEudiAgeProvider({ trust, doctypes = ['av', 'pid', 'mdl'], origins = [], now = () => new Date(), log }) {
    const pending = new Map();
    const context = createMdocContext(now);
    const verifier = new Verifier();
    const accepted = new Map(doctypes.map(id => [EUDI_DOCTYPES[id].docType, EUDI_DOCTYPES[id].nameSpace]));

    function prune() {
        const time = now().getTime();
        for (const [peerId, entry] of pending) if (entry.expiresAt <= time) pending.delete(peerId);
        while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    }

    async function verifyOne(encoded, nonce, origin) {
        let lastError = null;
        const transcripts = eudiSessionTranscripts({ origin, nonce });
        for (const [index, transcript] of transcripts.entries()) {
            try {
                const mdoc = await verifier.verifyDeviceResponse({
                    encodedDeviceResponse: encoded,
                    encodedSessionTranscript: transcript,
                    trustedCertificates: trust.certificates(),
                    now: now()
                }, context);
                return { mdoc, transcript: index === 0 ? 'openid4vp-1.0' : 'openid4vp-draft-24' };
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error('Verification failed');
    }

    // Nur fuer die Testseite: Aussteller ohne persoenliche Daten (Name des Zertifikats, Land).
    function issuerOf(document) {
        try {
            const certificate = new X509Certificate(Buffer.from(document.issuerSigned.issuerAuth.certificate));
            const field = name => nameField(certificate.subject, name)[0] || null;
            return { name: field('CN') || field('O'), country: field('C') };
        } catch {
            return null;
        }
    }

    return {
        id: 'eudi',
        start({ peerId }) {
            prune();
            const nonce = randomBytes(32).toString('base64url');
            pending.set(peerId, { nonce, expiresAt: now().getTime() + REQUEST_TTL_MS });
            return { kind: 'eudi', protocol: 'openid4vp-v1-unsigned', request: eudiRequest({ nonce, doctypes }) };
        },
        async finish({ peerId, payload, origin }) {
            prune();
            const entry = pending.get(peerId);
            pending.delete(peerId);
            if (!entry) return { over18: false, reason: 'No open request' };
            if (!trust.certificates().length) return { over18: false, reason: 'No trusted issuers configured' };
            const expectedOrigins = origins.length ? origins : [origin].filter(Boolean);
            const errors = [];
            const responses = deviceResponsesFrom(payload);
            for (const encoded of responses) {
                for (const candidate of expectedOrigins) {
                    try {
                        const { mdoc, transcript } = await verifyOne(encoded, entry.nonce, candidate);
                        const documents = mdoc.documents.map(document => ({
                            docType: document.docType,
                            issuer: issuerOf(document),
                            ageOver18: document.getIssuerNameSpace(accepted.get(document.docType) || document.docType)?.get('age_over_18') ?? null
                        }));
                        const details = { origin: candidate, transcript, documents };
                        const ageOf = document => document.getIssuerNameSpace(accepted.get(document.docType))?.get('age_over_18');
                        const usable = mdoc.documents.filter(document => accepted.has(document.docType) && typeof ageOf(document) === 'boolean');
                        // Ein gueltiger Nachweis "unter 18" zaehlt auch: Gruppe 'minor' (getrenntes Entdecken).
                        const match = usable.find(document => ageOf(document) === true) || usable[0];
                        if (!match) return { over18: false, reason: 'No accepted credential with age_over_18', details };
                        const deviceKey = match.issuerSigned.issuerAuth.decodedPayload.deviceKeyInfo?.deviceKey;
                        const subject = deviceKey ? `eudi:${createHash('sha256').update(cborEncode(deviceKey)).digest('hex')}` : null;
                        const over18 = ageOf(match) === true;
                        return { over18, minor: !over18, subject, details };
                    } catch (error) {
                        errors.push(error.message);
                        log?.info?.(`EUDI age check rejected: ${error.message}`);
                    }
                }
            }
            return { over18: false, reason: responses.length ? 'Invalid presentation' : 'No presentation in the answer', details: { errors: [...new Set(errors)] } };
        }
    };
}

// ----- Testseite (Debug-Modus): echte Pruefung, aber ohne Speichern und ohne Freischalten -----
// Vertraut der Test-Liste der EU (Demo- und Test-Aussteller) und der echten Liste; beide werden erst
// beim ersten Test geladen (danach hoechstens taeglich). AGE_EUDI_TEST=false schaltet es ab.
export function registerEudiTestRoutes(app, { allowRequest, requirePeerAuth, isString, createTrust, appOrigins = [], log }) {
    let provider = null;
    let trusts = null;
    let loadedAt = 0;
    async function ready() {
        if (!trusts) {
            trusts = createTrust();
            provider = createEudiAgeProvider({
                trust: { certificates: () => trusts.flatMap(trust => trust.certificates()) },
                origins: appOrigins,
                log
            });
        }
        if (Date.now() - loadedAt > 24 * 60 * 60 * 1000) {
            await Promise.all(trusts.map(trust => trust.refresh()));
            loadedAt = Date.now();
        }
        return provider;
    }
    const authed = (request, reply) => {
        if (!allowRequest('safety', request.ip, reply)) return null;
        const peerId = request.body?.peerId;
        if (!isString(peerId, 200)) {
            reply.code(400).send({ error: 'peerId required' });
            return null;
        }
        return requirePeerAuth(request, reply, peerId) ? peerId : null;
    };
    app.post('/api/safety/age-test/start', async (request, reply) => {
        const peerId = authed(request, reply);
        if (!peerId) return reply;
        const current = await ready();
        return { ...current.start({ peerId: `test:${peerId}` }), issuers: trusts.flatMap(trust => trust.status().imported).length };
    });
    app.post('/api/safety/age-test/finish', async (request, reply) => {
        const peerId = authed(request, reply);
        if (!peerId) return reply;
        const current = await ready();
        const result = await current.finish({ peerId: `test:${peerId}`, payload: request.body?.payload, origin: `${request.protocol}://${request.host}` });
        return { over18: result.over18 === true, minor: result.minor === true, reason: result.reason || null, details: result.details || null };
    });
}

