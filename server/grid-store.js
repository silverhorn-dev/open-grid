const spatialGrid = new Map();
const removedPeers = new Map();

export async function storePeerRegistration(env, session) {
    if (env.OPENGRID_KV) {
        const previousGeohash = await env.OPENGRID_KV.get(`peer:${session.peerId}`);
        if (previousGeohash && previousGeohash !== session.geohash) {
            await Promise.all([
                env.OPENGRID_KV.delete(`grid:${previousGeohash}:${session.peerId}`),
                env.OPENGRID_KV.put(`removed:${previousGeohash}:${session.peerId}`, String(Date.now()), { expirationTtl: 2592000 })
            ]);
        }
        const gridRecord = {
            name: session.name,
            thumbnail: session.thumbnail
        };
        const presenceRecord = {
            registrationId: session.registrationId
        };
        await Promise.all([
            env.OPENGRID_KV.put(`grid:${session.geohash}:${session.peerId}`, JSON.stringify(gridRecord), { expirationTtl: 600 }),
            env.OPENGRID_KV.put(`peer:${session.peerId}`, session.geohash, { expirationTtl: 600 }),
            env.OPENGRID_KV.put(`presence:${session.peerId}`, JSON.stringify(presenceRecord), { expirationTtl: 600 }),
            env.OPENGRID_KV.delete(`removed:${session.geohash}:${session.peerId}`)
        ]);
        return;
    }

    removePeerFromMemoryGrid(session.peerId);
    session.lastSeen = Date.now();
    removedPeers.get(session.geohash)?.delete(session.peerId);
    if (!spatialGrid.has(session.geohash)) spatialGrid.set(session.geohash, new Map());
    spatialGrid.get(session.geohash).set(session.peerId, session);
}

export async function getPeerRegistrations(env, geohash) {
    if (env.OPENGRID_KV) {
        const entries = await env.OPENGRID_KV.list({ prefix: `grid:${geohash}:`, limit: 1000 });
        const sessions = await Promise.all(entries.keys.map(async (key) => {
            const record = await env.OPENGRID_KV.get(key.name, 'json');
            if (!record) return null;
            const peerId = key.name.substring(`grid:${geohash}:`.length);
            return {
                peerId,
                geohash,
                ...record
            };
        }));
        return sessions.filter(Boolean);
    }

    const cellMap = spatialGrid.get(geohash);
    if (!cellMap) return [];
    const now = Date.now();
    for (const [peerId, session] of cellMap.entries()) {
        if (now - session.lastSeen >= 600000) cellMap.delete(peerId);
    }
    return Array.from(cellMap.values());
}

export async function getRemovedPeerIds(env, geohash) {
    if (!env.OPENGRID_KV) return Array.from(removedPeers.get(geohash) || []);
    const prefix = `removed:${geohash}:`;
    const entries = await env.OPENGRID_KV.list({ prefix, limit: 1000 });
    return entries.keys.map(key => key.name.substring(prefix.length));
}

export async function removePeerRegistration(env, peerId, registrationId, geohash = null) {
    if (env.OPENGRID_KV) {
        const registeredGeohash = geohash || await env.OPENGRID_KV.get(`peer:${peerId}`);
        if (!registeredGeohash) return 0;

        const key = `grid:${registeredGeohash}:${peerId}`;
        const presence = await env.OPENGRID_KV.get(`presence:${peerId}`, 'json');
        if (!presence || presence.registrationId !== registrationId) return 0;

        await Promise.all([
            env.OPENGRID_KV.delete(key),
            env.OPENGRID_KV.delete(`peer:${peerId}`),
            env.OPENGRID_KV.delete(`presence:${peerId}`),
            env.OPENGRID_KV.put(`removed:${registeredGeohash}:${peerId}`, String(Date.now()), { expirationTtl: 2592000 })
        ]);
        return 1;
    }

    const removed = removePeerFromMemoryGrid(peerId, geohash, registrationId);
    if (removed && geohash) {
        if (!removedPeers.has(geohash)) removedPeers.set(geohash, new Set());
        removedPeers.get(geohash).add(peerId);
    }
    return removed;
}

function removePeerFromMemoryGrid(peerId, geohash = null, registrationId = null) {
    let removed = 0;
    const cells = geohash ? [[geohash, spatialGrid.get(geohash)]] : spatialGrid.entries();

    for (const [cellGeohash, cellMap] of cells) {
        const session = cellMap?.get(peerId);
        if (!session || (registrationId && session.registrationId !== registrationId)) continue;
        cellMap.delete(peerId);
        removed += 1;
        if (cellMap.size === 0) spatialGrid.delete(cellGeohash);
    }

    return removed;
}
