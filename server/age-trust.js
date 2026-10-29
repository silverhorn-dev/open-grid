import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import xpath from 'xpath';

// ================= VERTRAUENSANKER FUER DEN EU-ALTERSNACHWEIS (Board T2) =================
// Welche Aussteller (Proof-of-Age-Anbieter) der Router fuer AGE_PROVIDER=eudi anerkennt:
//   1. AGE_TRUST_CERTS: Ordner mit PEM-Dateien des Betreibers (z. B. nationale Aussteller, Testaussteller)
//   2. Automatischer Import der EU-Liste "Age Verification Trusted List" (ETSI TS 119 612, XML):
//      AGE_TRUSTED_LIST_URL (Standard: die Liste der Kommission, 'off' = kein Import). Die Liste wird
//      nur angenommen, wenn ihre XML-Signatur gueltig ist und der Fingerabdruck (SHA-256) des
//      Signaturzertifikats in AGE_TRUSTED_LIST_SIGNER steht (Standard: das heutige Zertifikat der
//      Kommission, gueltig bis 11/2027). Uebernommen werden nur Dienste vom Typ PAA mit Status
//      "recognized"/"granted", gelesen aus dem signierten Inhalt (Schutz gegen Signature Wrapping).
//      Die letzte gueltige Liste liegt im Datenordner und wird taeglich erneuert.
export const EU_AGE_TRUSTED_LIST_URL = 'https://trust.tech.ec.europa.eu/lists/age-verification/av-tl.xml';
// Signaturzertifikat der Kommission ("EUROPEAN COMMISSION", DIGIT), 2023-11-17 bis 2027-11-17.
export const EU_AGE_TRUSTED_LIST_SIGNERS = ['e0a620fbb6747362bb933ac44169d676a553444716cf5f31605f12a22b8396b1'];
// Test-Liste (Abnahmeumgebung) mit Test- und Demo-Ausstellern, u. a. "Age Verification Reference
// Implementation" (Demo-App der EU); nur fuer die Testseite, nie fuer echte Nachweise.
export const EU_AGE_TEST_TRUSTED_LIST_URL = 'https://acceptance.trust.tech.ec.europa.eu/lists/age-verification/av-tl.xml';
// "TEST European Commission" (DIGIT.B.3), 2025-11-20 bis 2028-11-20.
export const EU_AGE_TEST_TRUSTED_LIST_SIGNERS = ['0ccf87a5abf4db89bde4e10202e2523296bea7d835ba6a5a41054b9e1e6b8949'];
const TRUSTED_SERVICE_TYPE_SUFFIX = '/paa';
const TRUSTED_SERVICE_STATUS = ['recognized', 'granted'];
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const XMLDSIG = 'http://www.w3.org/2000/09/xmldsig#';

export function derToPem(der) {
    const base64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
    return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}

export function pemToDers(text) {
    return [...String(text).matchAll(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/g)]
        .map(match => Buffer.from(match[1].replace(/\s+/g, ''), 'base64'));
}

const fingerprint = der => createHash('sha256').update(der).digest('hex');
const el = name => `*[local-name(.)='${name}']`;

// Prueft Signatur und Unterzeichner einer Trusted List und liefert die anerkannten Aussteller.
export function parseAgeTrustedList(xml, { signers = EU_AGE_TRUSTED_LIST_SIGNERS, now = new Date() } = {}) {
    const document = new DOMParser().parseFromString(String(xml), 'text/xml');
    const signature = xpath.select(`/*/*[local-name(.)='Signature' and namespace-uri(.)='${XMLDSIG}']`, document)[0];
    if (!signature) throw new Error('Trusted list is not signed');
    const certificate = String(xpath.select(`string(.//${el('X509Certificate')})`, signature)).replace(/\s+/g, '');
    if (!certificate) throw new Error('Trusted list signature has no certificate');
    const signerDer = Buffer.from(certificate, 'base64');
    const signerFingerprint = fingerprint(signerDer);
    if (!signers.map(value => value.toLowerCase()).includes(signerFingerprint)) {
        throw new Error(`Trusted list signed by an unknown certificate (${signerFingerprint})`);
    }
    const signerCertificate = new X509Certificate(signerDer);
    if (new Date(signerCertificate.validTo) < now || new Date(signerCertificate.validFrom) > now) {
        throw new Error('Trusted list signer certificate is not valid now');
    }
    const verifier = new SignedXml({ publicCert: derToPem(signerDer), getCertFromKeyInfo: () => null });
    verifier.loadSignature(signature);
    if (!verifier.checkSignature(String(xml))) throw new Error('Trusted list signature is invalid');
    // Nur den signierten Inhalt auswerten: die Referenz auf das ganze Dokument (URI "").
    const references = verifier.getReferences();
    const whole = references.findIndex(reference => reference.uri === '');
    if (whole < 0) throw new Error('Trusted list signature does not cover the document');
    const signed = new DOMParser().parseFromString(verifier.getSignedReferences()[whole], 'text/xml');

    const text = (node, path) => String(xpath.select(`string(${path})`, node)).trim();
    const nextUpdate = text(signed, `//${el('NextUpdate')}/${el('dateTime')}`);
    const issuers = [];
    for (const provider of xpath.select(`//${el('TrustServiceProvider')}`, signed)) {
        const providerName = text(provider, `.//${el('TSPName')}/${el('Name')}`);
        for (const service of xpath.select(`.//${el('TSPService')}`, provider)) {
            const type = text(service, `.//${el('ServiceTypeIdentifier')}`);
            const status = text(service, `.//${el('ServiceStatus')}`).split('/').pop();
            if (!type.toLowerCase().endsWith(TRUSTED_SERVICE_TYPE_SUFFIX) || !TRUSTED_SERVICE_STATUS.includes(status.toLowerCase())) continue;
            const name = text(service, `.//${el('ServiceName')}/${el('Name')}`);
            const path = `.//${el('ServiceDigitalIdentity')}/${el('DigitalId')}/${el('X509Certificate')}`;
            for (const node of xpath.select(path, service)) {
                const der = Buffer.from(String(node.textContent).replace(/\s+/g, ''), 'base64');
                new X509Certificate(der);
                issuers.push({ provider: providerName, service: name, fingerprint: fingerprint(der), der });
            }
        }
    }
    return { issuers, nextUpdate: nextUpdate || null, signerFingerprint };
}

function readPemDirectory(directory, log) {
    if (!directory || !existsSync(directory)) return [];
    const ders = [];
    for (const file of readdirSync(directory).filter(name => /\.(pem|crt|cer)$/i.test(name)).sort()) {
        try {
            for (const der of pemToDers(readFileSync(join(directory, file), 'utf8'))) {
                new X509Certificate(der);
                ders.push(der);
            }
        } catch (error) {
            log.warn(`AGE_TRUST_CERTS: ${file} skipped (${error.message})`);
        }
    }
    return ders;
}

export function parseAgeTrustConfig({ certs, listUrl, listSigners } = {}) {
    const url = String(listUrl ?? '').trim();
    const signers = String(listSigners ?? '').split(',').map(value => value.trim().toLowerCase()).filter(value => /^[0-9a-f]{64}$/.test(value));
    return {
        certsDirectory: String(certs ?? '').trim() || null,
        listUrl: url.toLowerCase() === 'off' ? null : (/^https:\/\//.test(url) ? url : EU_AGE_TRUSTED_LIST_URL),
        listSigners: signers.length ? signers : EU_AGE_TRUSTED_LIST_SIGNERS
    };
}

// Vertrauensanker = PEMs des Betreibers + zuletzt gueltige EU-Liste (Datei im Datenordner).
export function createAgeTrustStore({ config, dataDirectory, log, fetchList = defaultFetch, now = () => new Date() }) {
    const cacheFile = dataDirectory ? join(dataDirectory, 'age-trusted-list.xml') : null;
    let manual = readPemDirectory(config.certsDirectory, log);
    let imported = { issuers: [], nextUpdate: null, importedAt: null };
    let timer = null;

    function adopt(xml, source) {
        const parsed = parseAgeTrustedList(xml, { signers: config.listSigners, now: now() });
        imported = { ...parsed, importedAt: now().toISOString() };
        log.info(`Age trusted list (${source}): ${parsed.issuers.length} issuer certificate(s), next update ${parsed.nextUpdate || '?'}`);
        return parsed;
    }

    if (cacheFile && existsSync(cacheFile)) {
        try {
            adopt(readFileSync(cacheFile, 'utf8'), 'cache');
        } catch (error) {
            log.warn(`Cached age trusted list rejected: ${error.message}`);
        }
    }

    async function refresh() {
        if (!config.listUrl) return { ok: false, reason: 'disabled' };
        try {
            const xml = await fetchList(config.listUrl);
            adopt(xml, config.listUrl);
            if (cacheFile) {
                mkdirSync(dataDirectory, { recursive: true });
                writeFileSync(cacheFile, xml);
            }
            return { ok: true, issuers: imported.issuers.length };
        } catch (error) {
            // Die letzte gueltige Liste bleibt in Kraft.
            log.warn(`Age trusted list import failed: ${error.message}`);
            return { ok: false, reason: error.message };
        }
    }

    return {
        refresh,
        start() {
            if (!config.listUrl || timer) return;
            refresh();
            timer = setInterval(refresh, REFRESH_INTERVAL_MS);
            timer.unref?.();
        },
        stop() {
            clearInterval(timer);
            timer = null;
        },
        reloadManual() {
            manual = readPemDirectory(config.certsDirectory, log);
        },
        certificates() {
            const seen = new Set();
            return [...manual, ...imported.issuers.map(issuer => issuer.der)].filter(der => {
                const key = fingerprint(der);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        },
        status() {
            return {
                manual: manual.length,
                imported: imported.issuers.map(({ provider, service, fingerprint: hash }) => ({ provider, service, fingerprint: hash })),
                nextUpdate: imported.nextUpdate,
                importedAt: imported.importedAt
            };
        }
    };
}

async function defaultFetch(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_LIST_BYTES) throw new Error('Trusted list too large');
    return text;
}
