// ================= UMZUG: ALTE ID STILLLEGEN (Board T31) =================
// Nach dem Umzug auf ein anderes Geraet meldet das neue Geraet die alte ID beim Router ab (mit dem alten
// Router-Token aus dem verschluesselten Umzugs-Buendel). Der Router prueft den signierten Nachweis aus
// move.js (Vollmacht der alten Identitaet + Ansage des Delegations-Schluessels) und haelt ihn bereit:
// - die alte Kopie bekommt ihn bei der naechsten Anmeldung (410) und sperrt sich, auch nach Wochen,
// - wer noch an die alte ID schreibt (Pfad C), bekommt ihn (410) und zieht den Chat selbst um.
// Der Nachweis enthaelt nur IDs, Zeitpunkte und oeffentliche Schluessel; der Router lernt dabei "alt -> neu".
import crypto from 'node:crypto';

const MAX_PROOF_TEXT = 4000;
const MAX_SIGNATURE = 200;

function verifyText(jwk, text, signature) {
    try {
        const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        return crypto.verify('sha256', Buffer.from(text), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64'));
    } catch {
        return false;
    }
}

// Liefert { movedTo, proof } oder null, wenn der Nachweis nicht zur alten ID und ihrem Schluessel passt.
export function verifyMoveProof(proof, peerId, identityJwk, now = Date.now()) {
    if (!proof || typeof proof !== 'object' || !identityJwk) return null;
    const { delegation, delegationSignature, announcement, announcementSignature } = proof;
    const texts = [delegation, announcement];
    const signatures = [delegationSignature, announcementSignature];
    if (!texts.every(text => typeof text === 'string' && text.length > 0 && text.length <= MAX_PROOF_TEXT)) return null;
    if (!signatures.every(signature => typeof signature === 'string' && signature.length > 0 && signature.length <= MAX_SIGNATURE)) return null;
    let parsedDelegation;
    let parsedAnnouncement;
    try {
        parsedDelegation = JSON.parse(delegation);
        parsedAnnouncement = JSON.parse(announcement);
    } catch {
        return null;
    }
    if (parsedDelegation?.type !== 'opengrid-move-delegation' || parsedAnnouncement?.type !== 'opengrid-move') return null;
    if (parsedDelegation.from !== peerId || parsedAnnouncement.from !== peerId) return null;
    const movedTo = parsedAnnouncement.to;
    if (typeof movedTo !== 'string' || !movedTo || movedTo.length > 200 || movedTo === peerId) return null;
    if (!(Number(parsedDelegation.expiresAt) > now)) return null;
    if (!verifyText(identityJwk, delegation, delegationSignature)) return null;
    if (!parsedDelegation.delegate || !verifyText(parsedDelegation.delegate, announcement, announcementSignature)) return null;
    return { movedTo, proof: { delegation, delegationSignature, announcement, announcementSignature } };
}
