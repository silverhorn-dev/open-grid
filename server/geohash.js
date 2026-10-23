// Geohash-Hilfsfunktionen fuer Grid-Ringe und Entfernungs-Buckets.
// Der Client haelt eine identische Kopie in client/geohash.client.js.

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const EARTH_RADIUS_KM = 6371;

export const GRID_PRECISION = 6;
export const MAX_GRID_RING = 5;

// Obergrenzen in Kilometern; der letzte Bucket ist offen.
export const DISTANCE_BUCKETS = [
    { id: 'lt1', maxKm: 1 },
    { id: '1-5', maxKm: 5 },
    { id: '5-20', maxKm: 20 },
    { id: '20-100', maxKm: 100 },
    { id: '100-300', maxKm: 300 },
    { id: '300-500', maxKm: 500 },
    { id: 'gt500', maxKm: Infinity }
];

export function isGeohash(value, minLength = 1, maxLength = 12) {
    return typeof value === 'string'
        && value.length >= minLength
        && value.length <= maxLength
        && [...value].every(char => BASE32.includes(char));
}

export function encodeGeohash(latitude, longitude, precision = GRID_PRECISION) {
    let latMin = -90;
    let latMax = 90;
    let lonMin = -180;
    let lonMax = 180;
    let hash = '';
    let bits = 0;
    let value = 0;
    let evenBit = true;
    while (hash.length < precision) {
        if (evenBit) {
            const mid = (lonMin + lonMax) / 2;
            if (longitude >= mid) {
                value = value * 2 + 1;
                lonMin = mid;
            } else {
                value *= 2;
                lonMax = mid;
            }
        } else {
            const mid = (latMin + latMax) / 2;
            if (latitude >= mid) {
                value = value * 2 + 1;
                latMin = mid;
            } else {
                value *= 2;
                latMax = mid;
            }
        }
        evenBit = !evenBit;
        if (++bits === 5) {
            hash += BASE32[value];
            bits = 0;
            value = 0;
        }
    }
    return hash;
}

export function decodeGeohashBounds(hash) {
    let latMin = -90;
    let latMax = 90;
    let lonMin = -180;
    let lonMax = 180;
    let evenBit = true;
    for (const char of hash) {
        const index = BASE32.indexOf(char);
        if (index < 0) throw new Error('Invalid geohash');
        for (let bit = 4; bit >= 0; bit--) {
            const bitValue = (index >> bit) & 1;
            if (evenBit) {
                const mid = (lonMin + lonMax) / 2;
                if (bitValue) lonMin = mid;
                else lonMax = mid;
            } else {
                const mid = (latMin + latMax) / 2;
                if (bitValue) latMin = mid;
                else latMax = mid;
            }
            evenBit = !evenBit;
        }
    }
    return { latMin, latMax, lonMin, lonMax };
}

export function decodeGeohash(hash) {
    const { latMin, latMax, lonMin, lonMax } = decodeGeohashBounds(hash);
    return { latitude: (latMin + latMax) / 2, longitude: (lonMin + lonMax) / 2 };
}

// Nachbarn ueber den Zellmittelpunkt plus eine Zellbreite; an den Polen entfallen Zellen.
export function geohashNeighbours(hash) {
    const { latMin, latMax, lonMin, lonMax } = decodeGeohashBounds(hash);
    const latitude = (latMin + latMax) / 2;
    const longitude = (lonMin + lonMax) / 2;
    const latStep = latMax - latMin;
    const lonStep = lonMax - lonMin;
    const neighbours = new Set();
    for (const latOffset of [-1, 0, 1]) {
        for (const lonOffset of [-1, 0, 1]) {
            if (!latOffset && !lonOffset) continue;
            const neighbourLat = latitude + latOffset * latStep;
            if (neighbourLat <= -90 || neighbourLat >= 90) continue;
            let neighbourLon = longitude + lonOffset * lonStep;
            if (neighbourLon >= 180) neighbourLon -= 360;
            if (neighbourLon < -180) neighbourLon += 360;
            neighbours.add(encodeGeohash(neighbourLat, neighbourLon, hash.length));
        }
    }
    neighbours.delete(hash);
    return [...neighbours];
}

// Ring 0 = eigene Zelle, Ring 1 = 3x3 auf Praezision 6, ab Ring 2 je eine Stufe groebere 3x3-Zellen.
export function gridRingCells(hash, ring) {
    const own = hash.substring(0, GRID_PRECISION);
    if (ring <= 0) return [own];
    const prefix = own.substring(0, GRID_PRECISION - Math.max(0, ring - 1));
    return [prefix, ...geohashNeighbours(prefix)];
}

export function distanceKm(from, to) {
    const toRadians = degrees => degrees * Math.PI / 180;
    const deltaLat = toRadians(to.latitude - from.latitude);
    const deltaLon = toRadians(to.longitude - from.longitude);
    const a = Math.sin(deltaLat / 2) ** 2
        + Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(deltaLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function distanceBucket(km) {
    return DISTANCE_BUCKETS.find(bucket => km < bucket.maxKm).id;
}
