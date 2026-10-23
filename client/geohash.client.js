// Geohash-Encoder fuer den eigenen Standort. Entspricht encodeGeohash in server/geohash.js.
const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const GRID_PRECISION = 6;
const MAX_GRID_RING = 5;

const DISTANCE_BUCKET_LABELS = {
    lt1: 'Sehr nah',
    '1-5': 'In der Naehe',
    '5-20': 'In der Stadt',
    '20-100': '20-100 km',
    '100-300': '100-300 km',
    '300-500': '300-500 km',
    gt500: '> 500 km'
};

function encodeGeohash(latitude, longitude, precision = GRID_PRECISION) {
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
            hash += GEOHASH_BASE32[value];
            bits = 0;
            value = 0;
        }
    }
    return hash;
}
