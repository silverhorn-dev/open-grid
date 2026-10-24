import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRateLimiter, isAllowedPushEndpoint, parsePushHostAllowlist, parseTrustProxy } from '../server/security.js';

test('push endpoints: known services, wildcard subdomains and operator extensions', () => {
    const allowlist = parsePushHostAllowlist('ntfy.example.org');
    assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/x', allowlist), true);
    assert.equal(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x', allowlist), true);
    assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/x', allowlist), true);
    assert.equal(isAllowedPushEndpoint('https://ntfy.example.org/up/x', allowlist), true);
    assert.equal(isAllowedPushEndpoint('https://push.services.mozilla.com.evil/x', allowlist), false);
    assert.equal(isAllowedPushEndpoint('https://10.0.0.5/x', allowlist), false);
    assert.equal(isAllowedPushEndpoint('not a url', allowlist), false);
});

test('rate limiter resets after its window', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2 });
    assert.equal(limiter.take('a', 0), true);
    assert.equal(limiter.take('a', 10), true);
    assert.equal(limiter.take('a', 20), 1);
    assert.equal(limiter.take('b', 20), true, 'keys are independent');
    assert.equal(limiter.take('a', 1001), true);
});

test('trust proxy defaults to private networks only', () => {
    assert.equal(parseTrustProxy(undefined), 'loopback,linklocal,uniquelocal');
    assert.equal(parseTrustProxy('true'), true);
    assert.equal(parseTrustProxy('2'), 2);
    assert.equal(parseTrustProxy('10.0.0.1'), '10.0.0.1');
});

test('rate limits can be scaled for test environments, within bounds', async () => {
    const { scaleRateLimits, DEFAULT_RATE_LIMITS } = await import('../server/security.js');
    assert.equal(scaleRateLimits(DEFAULT_RATE_LIMITS, undefined).register.max, DEFAULT_RATE_LIMITS.register.max);
    assert.equal(scaleRateLimits(DEFAULT_RATE_LIMITS, '20').register.max, DEFAULT_RATE_LIMITS.register.max * 20);
    assert.equal(scaleRateLimits(DEFAULT_RATE_LIMITS, '5000').register.max, DEFAULT_RATE_LIMITS.register.max * 100);
    assert.equal(scaleRateLimits(DEFAULT_RATE_LIMITS, '-3').register.max, DEFAULT_RATE_LIMITS.register.max);
});

