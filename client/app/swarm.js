// ================= SCHWARM-ABRUF (Galerie und Alben) =================
// Ist der Besitzer nicht erreichbar, fragen Clients ihre offenen P2P-Kanaele nach Kopien.
// - Galerie: oeffentliche Profilbilder, geprueft gegen den SHA-256 im signierten Profil.
// - Alben: das vom Besitzer signierte Manifest und die Bilder. Der weitergebende Betrachter
//   entschluesselt seine Kopie, setzt das Wasserzeichen des Anfragenden und verschluesselt neu mit
//   dem Inhaltsschluessel. Ansehen kann der Anfragende nur mit den Schluesseln des Besitzers
//   (ALBUM_KEYS), die Zugriffsliste bleibt also in der Hand des Besitzers.
// Es wird nichts zusaetzlich gespeichert: weitergegeben wird nur, was der Client selbst schon hat.
// Schutz gegen Zweitaccounts: Album-Anfragen brauchen ein vom Besitzer signiertes Zugangsticket fuer
// genau den anfragenden Peer. Der Anfragende prueft, dass eine weitergegebene Kopie sein eigenes
// Wasserzeichen traegt (sonst koennte der Weitergebende es weglassen oder faelschen).
const SWARM_FALLBACK_MS = 1500;

function openSwarmPeers(excludeId) {
    return Object.keys(state.dataChannels)
        .filter(peerId => peerId !== excludeId && state.dataChannels[peerId]?.readyState === 'open');
}

// ----- Galerie -----
// Eigene Galerie: Hash pro Bild, damit Dritte Kopien pruefen koennen (wird mit signiert).
async function ensureGalleryHashes() {
    let changed = false;
    for (const item of [...(state.myProfile.gallery || []), ...(state.myProfile.social?.gallery || [])]) {
        if (item.sha256) continue;
        const media = await loadMedia(item.id);
        if (!media?.data) continue;
        item.sha256 = await sha256Base64(media.data);
        changed = true;
    }
    if (changed) await cacheOwnProfile();
}

function requestGalleryImageFromSwarm(ownerId, meta) {
    if (!meta?.sha256) return 0;
    const peers = openSwarmPeers(ownerId);
    peers.forEach(peerId => {
        state.pendingSwarmImages[`${peerId}:${meta.id}`] = { ownerId, version: meta.version };
        sendSecurePayload(peerId, { type: 'SWARM_IMAGE_REQUEST', ownerId, imageId: meta.id, version: meta.version })
            .catch(logBackgroundError('requestGalleryImageFromSwarm'));
    });
    if (peers.length) logDebug(`Galeriebild ${meta.id} von ${ownerId}: frage ${peers.length} Peer(s) im Schwarm.`);
    return peers.length;
}

// Nur oeffentliche Profile (keine Match-Profile) und nur Bilder mit signiertem Hash.
async function handleSwarmImageRequest(peerId, payload) {
    const profile = state.cachedProfiles[payload.ownerId];
    if (!profile?.signedEnvelope || !isProfileShareable(profile) || !isProfileShareable(profile.signedEnvelope.payload)) return;
    const entry = profile.gallery?.find(item => item.id === payload.imageId && item.version === payload.version);
    if (!entry?.sha256) return;
    const media = await loadMedia(payload.imageId);
    if (!media?.data || media.version !== payload.version) return;
    await sendSecurePayload(peerId, {
        type: 'SWARM_IMAGE_RESPONSE',
        ownerId: payload.ownerId,
        imageId: payload.imageId,
        version: payload.version,
        data: media.data
    });
}

async function handleSwarmImageResponse(peerId, payload) {
    const requestKey = `${peerId}:${payload.imageId}`;
    const pending = state.pendingSwarmImages[requestKey];
    if (!pending || pending.ownerId !== payload.ownerId || pending.version !== payload.version) {
        logDebug(`Unangefragtes Schwarm-Bild ${payload.imageId} von ${peerId} verworfen.`);
        return;
    }
    delete state.pendingSwarmImages[requestKey];
    const entry = state.cachedProfiles[payload.ownerId]?.gallery?.find(item => item.id === payload.imageId && item.version === payload.version);
    if (!entry?.sha256 || !isSafeInlineImage(payload.data) || await sha256Base64(payload.data) !== entry.sha256) {
        logDebug(`Schwarm-Bild ${payload.imageId} von ${peerId} passt nicht zum signierten Hash, verworfen.`);
        return;
    }
    const current = await loadMedia(payload.imageId);
    if (current && current.version >= payload.version) return;
    await cacheMedia(payload.imageId, payload.data, payload.version);
    if (state.activeModalPeerId === payload.ownerId && typeof renderModalGalleryImage === 'function') {
        renderModalGalleryImage(payload.imageId, payload.data);
    }
}

// ----- Alben -----
function requestAlbumFromSwarm(ownerId, albumId) {
    setTimeout(async () => {
        if (state.albumViewer?.albumId !== albumId || isSecureChannelOpen(ownerId)) return;
        if (!state.pendingAlbumRequests[`${ownerId}:${albumId}`] && state.albums[albumId]?.manifest) return;
        const ticket = await loadAlbumTicket(albumId);
        if (!ticket) return;
        openSwarmPeers(ownerId).forEach(peerId => {
            state.pendingSwarmAlbums[`${peerId}:${albumId}`] = ownerId;
            sendSecurePayload(peerId, { type: 'SWARM_ALBUM_REQUEST', ownerId, albumId, ticket })
                .catch(logBackgroundError('requestAlbumFromSwarm'));
        });
    }, SWARM_FALLBACK_MS);
}

async function requestAlbumImageFromSwarm(album, item) {
    const ticket = await loadAlbumTicket(album.id);
    if (!ticket) return;
    openSwarmPeers(album.ownerId).forEach(peerId => {
        state.pendingSwarmImages[`${peerId}:${item.id}`] = { ownerId: album.ownerId, albumId: album.id, version: item.version };
        sendSecurePayload(peerId, {
            type: 'SWARM_ALBUM_IMAGE_REQUEST',
            ownerId: album.ownerId,
            albumId: album.id,
            imageId: item.id,
            version: item.version,
            ticket
        }).catch(logBackgroundError('requestAlbumImageFromSwarm'));
    });
}

// Nur fuer den Peer am anderen Ende des Kanals, mit gueltigem Ticket des Besitzers.
async function hasValidSwarmTicket(peerId, payload) {
    const now = (await fetchServerTime().catch(() => ({ now: Date.now() }))).now;
    const valid = await verifyAlbumTicket(payload.ticket, { ownerId: payload.ownerId, albumId: payload.albumId, viewerId: peerId, now });
    if (!valid) logDebug(`Schwarm-Anfrage fuer Album ${payload.albumId} von ${peerId} ohne gueltiges Ticket abgelehnt.`);
    return valid;
}

// Weitergeben nur, was vom Besitzer signiert ist.
async function handleSwarmAlbumRequest(peerId, payload) {
    const album = state.albums[payload.albumId];
    if (!album || album.ownerId !== payload.ownerId || album.ownerId === state.myProfile.id || !album.manifest) return;
    if (!await hasValidSwarmTicket(peerId, payload)) return;
    await sendSecurePayload(peerId, { type: 'SWARM_ALBUM_RESPONSE', ownerId: album.ownerId, albumId: album.id, manifest: album.manifest });
}

async function handleSwarmAlbumResponse(peerId, payload) {
    const requestKey = `${peerId}:${payload.albumId}`;
    if (state.pendingSwarmAlbums[requestKey] !== payload.ownerId) return;
    delete state.pendingSwarmAlbums[requestKey];
    if (!await verifyAlbumManifest(payload.manifest, payload.ownerId, payload.albumId)) {
        logDebug(`Album-Manifest ${payload.albumId} von ${peerId} ist nicht vom Besitzer signiert, verworfen.`);
        return;
    }
    const manifest = payload.manifest.payload;
    // Nur neuere Staende uebernehmen (Version, dann Aenderungszeit des Besitzers).
    const known = state.albums[payload.albumId];
    const knownStamp = known?.manifest?.payload;
    if (known && (known.keyVersion > manifest.keyVersion
        || (knownStamp && knownStamp.keyVersion === manifest.keyVersion && (knownStamp.updatedAt || 0) >= (manifest.updatedAt || 0)))) return;
    const album = {
        id: manifest.id,
        ownerId: payload.ownerId,
        name: String(manifest.name || 'Album').substring(0, 80),
        keyVersion: Number.isInteger(manifest.keyVersion) ? manifest.keyVersion : 1,
        items: (Array.isArray(manifest.items) ? manifest.items : [])
            .filter(item => typeof item?.id === 'string' && Number.isInteger(item.version))
            .slice(0, 500)
            .map(item => ({ id: item.id.substring(0, 200), version: item.version })),
        manifest: payload.manifest,
        receivedAt: Date.now()
    };
    state.albums[album.id] = album;
    await persistAlbum(album);
    if (!state.albumKeys[album.id]) await loadAlbumKeys(album.id).catch(() => false);
    if (state.albumViewer?.albumId === album.id) await renderAlbumViewer(album);
}

// Betrachter C gibt sein Bild an B weiter: entschluesseln, Wasserzeichen fuer B, neu verschluesseln.
async function handleSwarmAlbumImageRequest(peerId, payload) {
    const album = state.albums[payload.albumId];
    if (!album || album.ownerId !== payload.ownerId || album.ownerId === state.myProfile.id || !album.manifest) return;
    if (!await hasValidSwarmTicket(peerId, payload)) return;
    const item = album.items.find(entry => entry.id === payload.imageId && entry.version === payload.version);
    const stored = item ? await loadMedia(item.id) : null;
    if (!stored?.encrypted || stored.version !== item.version || stored.keyVersion !== album.keyVersion
        || stored.keyScheme !== ALBUM_KEY_SCHEME) return;
    if (!state.albumKeys[album.id] && !await loadAlbumKeys(album.id).catch(() => false)) return;
    const key = state.albumKeys[album.id]?.keys.get(item.id);
    const dataUrl = key ? await decryptAlbumImage(album.id, item.id, stored.encrypted) : null;
    if (!dataUrl) return;
    await sendSecurePayload(peerId, {
        type: 'SWARM_ALBUM_IMAGE_RESPONSE',
        ownerId: album.ownerId,
        albumId: album.id,
        imageId: item.id,
        version: item.version,
        keyVersion: album.keyVersion,
        keyScheme: ALBUM_KEY_SCHEME,
        encrypted: await encryptAlbumImageFor(peerId, dataUrl, key, album.manifest.payload.watermark !== false)
    });
}

async function handleSwarmAlbumImageResponse(peerId, payload) {
    const requestKey = `${peerId}:${payload.imageId}`;
    const pending = state.pendingSwarmImages[requestKey];
    const album = state.albums[payload.albumId];
    const item = album?.items.find(entry => entry.id === payload.imageId);
    if (!pending || pending.albumId !== payload.albumId || pending.ownerId !== payload.ownerId || pending.version !== payload.version
        || !album || album.ownerId !== payload.ownerId || item?.version !== payload.version || payload.keyVersion !== album.keyVersion) {
        logDebug(`Unangefragtes Album-Bild ${payload.imageId} von ${peerId} verworfen.`);
        return;
    }
    delete state.pendingSwarmImages[requestKey];
    const current = await loadMedia(payload.imageId);
    if (current?.encrypted && current.version === item.version && current.keyVersion === album.keyVersion
        && current.keyScheme === ALBUM_KEY_SCHEME && !current.relayedBy) return;
    if (!await relayedCopyCarriesOwnWatermark(album, payload)) {
        logDebug(`Weitergegebenes Album-Bild ${payload.imageId} von ${peerId} traegt nicht das eigene Wasserzeichen, verworfen.`);
        return;
    }
    await storeReceivedAlbumImage(album, payload, peerId);
}

// Will der Besitzer ein Wasserzeichen (signiertes Manifest), muss die Kopie das eigene Tag tragen.
// Geprueft wird mit den eigenen Album-Schluesseln; ohne gueltige Schluessel keine weitergegebene Kopie.
async function relayedCopyCarriesOwnWatermark(album, payload) {
    if (album.manifest?.payload?.watermark === false) return true;
    if (!state.albumKeys[album.id] && !await loadAlbumKeys(album.id).catch(() => false)) return false;
    const dataUrl = await decryptAlbumImage(album.id, payload.imageId, payload.encrypted);
    if (!dataUrl || typeof identifyWatermark !== 'function') return false;
    const match = await identifyWatermark(dataUrl, [state.myProfile.id]).catch(() => null);
    return match?.peerId === state.myProfile.id;
}
