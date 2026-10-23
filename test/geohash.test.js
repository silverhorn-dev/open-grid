import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import {
    decodeGeohash,
    distanceBucket,
    distanceKm,
    encodeGeohash,
    geohashNeighbours,
    gridRingCells
} from '../server/geohash.js';

test('encodes and decodes the reference geohash', () => {
    assert.equal(encodeGeohash(57.64911, 10.40744, 11), 'u4pruydqqvj');
    const center = decodeGeohash('u4pruydqqvj');
    assert.ok(Math.abs(center.latitude - 57.64911) < 0.0001);
    assert.ok(Math.abs(center.longitude - 10.40744) < 0.0001);
});

test('returns the eight neighbours of a cell', () => {
    const neighbours = geohashNeighbours('u10j2k');
    assert.equal(neighbours.length, 8);
    assert.ok(!neighbours.includes('u10j2k'));
    assert.ok(neighbours.every(hash => hash.length === 6));
    for (const hash of neighbours) {
        assert.ok(geohashNeighbours(hash).includes('u10j2k'));
    }
});

test('builds coarser rings from shorter prefixes', () => {
    assert.deepEqual(gridRingCells('u10j2k', 0), ['u10j2k']);
    assert.equal(gridRingCells('u10j2k', 1).length, 9);
    assert.equal(gridRingCells('u10j2k', 2)[0], 'u10j2');
    assert.equal(gridRingCells('u10j2k', 5)[0], 'u1');
    // Jeder Ring enthaelt alle Zellen des vorherigen.
    for (let ring = 1; ring <= 5; ring++) {
        const outer = gridRingCells('u10j2k', ring);
        for (const cell of gridRingCells('u10j2k', ring - 1)) {
            assert.ok(outer.some(prefix => cell.startsWith(prefix)), `ring ${ring} misses ${cell}`);
        }
    }
});

test('maps distances to the agreed buckets', () => {
    assert.equal(distanceBucket(0), 'lt1');
    assert.equal(distanceBucket(3), '1-5');
    assert.equal(distanceBucket(12), '5-20');
    assert.equal(distanceBucket(50), '20-100');
    assert.equal(distanceBucket(200), '100-300');
    assert.equal(distanceBucket(400), '300-500');
    assert.equal(distanceBucket(900), 'gt500');
    const berlin = { latitude: 52.52, longitude: 13.405 };
    const munich = { latitude: 48.137, longitude: 11.575 };
    assert.ok(Math.abs(distanceKm(berlin, munich) - 504) < 5);
});

test('client geohash encoder matches the server', () => {
    const context = {};
    vm.runInNewContext(readFileSync(new URL('../client/geohash.client.js', import.meta.url), 'utf8'), context);
    for (const [latitude, longitude] of [[57.64911, 10.40744], [52.52, 13.405], [-33.86, 151.21], [0, 0]]) {
        assert.equal(context.encodeGeohash(latitude, longitude, 6), encodeGeohash(latitude, longitude, 6));
    }
});
