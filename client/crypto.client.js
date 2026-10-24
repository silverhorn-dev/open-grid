function bytesToBase64(bytes) {
    let binary = '';
    bytes.forEach(byte => {
        binary += String.fromCharCode(byte);
    });
    return window.btoa(binary);
}

function base64ToBytes(value) {
    return Uint8Array.from(window.atob(value), character => character.charCodeAt(0));
}

async function signProfileData(profileData, privateKey, jwkPublic) {
    const encoder = new TextEncoder();
    const payloadToSign = {
        ownerId: profileData.id,
        version: profileData.version,
        updatedAt: profileData.updatedAt,
        fields: profileData.fields,
        avatar: profileData.avatar,
        gallery: profileData.gallery || [],
        // Mit signiert, damit Dritte Match-Profile nicht als oeffentlich weitergeben koennen.
        audience: profileData.audience || 'public'
    };
    const dataString = JSON.stringify(payloadToSign);
    const signatureArrayBuffer = await window.crypto.subtle.sign(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        privateKey,
        encoder.encode(dataString)
    );
    return {
        payload: payloadToSign,
        publicKey: jwkPublic,
        signature: bytesToBase64(new Uint8Array(signatureArrayBuffer))
    };
}

function publicJwksMatch(left, right) {
    return Boolean(left && right)
        && left.kty === right.kty
        && left.crv === right.crv
        && left.x === right.x
        && left.y === right.y;
}

// Allgemeiner signierter Umschlag (z. B. Album-Manifest) mit dem ECDSA-Identitaetsschluessel.
async function signEnvelope(payload, privateKey, jwkPublic) {
    const signature = await window.crypto.subtle.sign(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        privateKey,
        new TextEncoder().encode(JSON.stringify(payload))
    );
    return { payload, publicKey: jwkPublic, signature: bytesToBase64(new Uint8Array(signature)) };
}

// Prueft einen Umschlag nur gegen einen bereits gepinnten Schluessel (kein Vertrauen auf Erstkontakt).
async function verifyEnvelope(envelope, expectedPublicKey) {
    try {
        if (!expectedPublicKey || !envelope?.payload || typeof envelope.signature !== 'string') return false;
        if (!publicJwksMatch(envelope.publicKey, expectedPublicKey)) return false;
        const key = await window.crypto.subtle.importKey('jwk', expectedPublicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        return await window.crypto.subtle.verify(
            { name: 'ECDSA', hash: { name: 'SHA-256' } },
            key,
            base64ToBytes(envelope.signature),
            new TextEncoder().encode(JSON.stringify(envelope.payload))
        );
    } catch {
        return false;
    }
}

async function sha256Base64(text) {
    return bytesToBase64(new Uint8Array(await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

/**
 * Prueft die Signatur eines Profilumschlags.
 *
 * Rueckgabe:
 *   'trusted'  - Signatur gueltig und Schluessel entspricht dem gepinnten Key
 *   'unpinned' - Signatur gueltig, es existiert aber noch kein gepinnter Key
 *   false      - Umschlag unvollstaendig, Owner falsch, Key abweichend oder
 *                Signatur ungueltig
 *
 * 'unpinned' tritt im Swarm auf, wenn ein Profil ueber einen Dritten kommt und
 * noch nie ein direkter KEY_HELLO stattgefunden hat. Der Umschlag ist dann
 * kryptografisch intakt, aber der Schluessel selbst ist unbestaetigt und darf
 * nicht als vertrauenswuerdig gepinnt werden.
 */
async function verifySignedProfile(signedEnvelope, expectedOwnerId, expectedPublicKey) {
    try {
        if (!signedEnvelope?.payload || !signedEnvelope.signature || !signedEnvelope.publicKey) return false;
        const {payload, publicKey, signature} = signedEnvelope;
        if (payload.ownerId !== expectedOwnerId) return false;
        // Ein bereits gepinnter Schluessel ist bindend: weicht er ab, ist das ein
        // Austauschversuch und nicht bloss ein fehlendes Pinning.
        if (expectedPublicKey && !publicJwksMatch(publicKey, expectedPublicKey)) return false;
        const importedPubKey = await window.crypto.subtle.importKey('jwk', publicKey, {
            name: 'ECDSA',
            namedCurve: 'P-256'
        }, false, ['verify']);
        const valid = await window.crypto.subtle.verify({
            name: 'ECDSA',
            hash: {name: 'SHA-256'}
        }, importedPubKey, base64ToBytes(signature), new TextEncoder().encode(JSON.stringify(payload)));
        if (!valid) return false;
        return expectedPublicKey ? 'trusted' : 'unpinned';
    } catch (e) {
        if (typeof logDebug !== 'undefined') logDebug(`Profile signature verification failed: ${e.message}`);
        return false;
    }
}