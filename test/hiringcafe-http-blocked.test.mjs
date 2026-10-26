import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpLooksBlocked } from '../lib/hiringcafe-http-blocked.mjs';

test('httpLooksBlocked treats an explicit 403 as blocked', () => {
  assert.equal(httpLooksBlocked({ status: 403, message: 'HTTP 403 Forbidden' }), true);
});

test('httpLooksBlocked treats Cloudflare challenge text as blocked', () => {
  assert.equal(httpLooksBlocked({ status: 200, body: 'Just a moment...<title>cf-chl' }), true);
});

test('httpLooksBlocked treats a fetch AbortError/timeout as blocked', () => {
  // Confirmed live 2026-10-24..26: the Tailscale-routed HTTP-first fetch
  // stalls past providers/_http.mjs's 10s timeout and throws exactly this —
  // no status, no Cloudflare text, just an AbortError. Before the fix this
  // fell through httpLooksBlocked() as false and crashed the whole scan
  // instead of falling back to patchright.
  const abortErr = new DOMException('This operation was aborted', 'AbortError');
  assert.equal(httpLooksBlocked(abortErr), true);
});

test('httpLooksBlocked treats a generic timeout message as blocked', () => {
  assert.equal(httpLooksBlocked({ message: 'fetch failed', cause: { message: 'request timed out' } }), true);
  assert.equal(httpLooksBlocked({ message: 'fetch failed', cause: { code: 'ETIMEDOUT' } }), true);
});

test('httpLooksBlocked does not misclassify an unrelated app error that happens to mention "timeout"', () => {
  // The generic timeout wording is only trusted off err.cause (real network
  // error codes), never off an arbitrary err.message/err.body — otherwise a
  // legitimate, unrelated failure like a downstream API's own error text
  // would get silently swallowed as "transient block, fall back and retry"
  // instead of surfacing as the real bug it is.
  assert.equal(httpLooksBlocked({ status: 500, message: 'database query timeout exceeded' }), false);
  assert.equal(httpLooksBlocked({ status: 502, body: 'upstream request timeout' }), false);
});

test('httpLooksBlocked does not flag an unrelated real bug as a block', () => {
  assert.equal(httpLooksBlocked({ status: 500, message: 'missing __NEXT_DATA__ on page 0' }), false);
  assert.equal(httpLooksBlocked(new TypeError('Cannot read properties of undefined')), false);
});
