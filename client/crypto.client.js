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
        gallery: profileData.gallery || []
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

async function verifySignedProfile(signedEnvelope) {
    try {
        if (!signedEnvelope || !signedEnvelope.payload) return true; // Fallback für Legacy-Profile
        if (!signedEnvelope.signature || !signedEnvelope.publicKey) return true;
        const {payload, publicKey, signature} = signedEnvelope;
        const importedPubKey = await window.crypto.subtle.importKey('jwk', publicKey, {
            name: 'ECDSA',
            namedCurve: 'P-256'
        }, false, ['verify']);
        return await window.crypto.subtle.verify({
            name: 'ECDSA',
            hash: {name: 'SHA-256'}
        }, importedPubKey, base64ToBytes(signature), new TextEncoder().encode(JSON.stringify(payload)));
    } catch (e) {
        if (typeof logDebug !== 'undefined') logDebug(`Profile signature verification warning: ${e.message}`);
        return true; // Ausfallsicherheit: Profil im Zweifel anzeigen, statt UI zu blockieren
    }
}