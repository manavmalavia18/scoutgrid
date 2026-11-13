import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHeaders, classifyBlockedResponse, buildBlockedDiagnostic } from '../lib/hc-blocked-diagnostics.mjs';

test('sanitizeHeaders strips cookies, auth, tokens, and session/license material even if present', () => {
  const headers = {
    'Set-Cookie': 'session=abc123; HttpOnly',
    Cookie: 'foo=bar',
    Authorization: 'Bearer secret-token',
    'X-Api-Token': 'nope',
    'X-License-Key': 'also-nope',
    Server: 'cloudflare',
    'CF-RAY': '8a1b2c3d-SJC',
  };
  const out = sanitizeHeaders(headers);
  assert.deepEqual(out, { server: 'cloudflare', 'cf-ray': '8a1b2c3d-SJC' });
  assert.ok(!('set-cookie' in out));
  assert.ok(!('cookie' in out));
  assert.ok(!('authorization' in out));
});

test('sanitizeHeaders accepts a real Headers object (fetch API shape), not just plain objects', () => {
  const headers = new Headers();
  headers.set('Server', 'cloudflare');
  headers.set('Set-Cookie', 'leak=1');
  headers.set('CF-Mitigated', 'challenge');
  const out = sanitizeHeaders(headers);
  assert.deepEqual(out, { server: 'cloudflare', 'cf-mitigated': 'challenge' });
});

test('sanitizeHeaders drops any header not on the allowlist, even benign-looking ones', () => {
  const out = sanitizeHeaders({ 'x-request-id': 'abc', server: 'cloudflare', 'x-powered-by': 'nextjs' });
  assert.deepEqual(out, { server: 'cloudflare' });
});

test('sanitizeHeaders caps absurdly long header values', () => {
  const out = sanitizeHeaders({ server: 'x'.repeat(10_000) });
  assert.equal(out.server.length, 200);
});

test('sanitizeHeaders tolerates missing/null input', () => {
  assert.deepEqual(sanitizeHeaders(null), {});
  assert.deepEqual(sanitizeHeaders(undefined), {});
});

test('classifyBlockedResponse distinguishes a managed challenge when the title says so', () => {
  const result = classifyBlockedResponse({ status: 403, headers: { server: 'cloudflare', 'cf-ray': 'x' }, markerText: 'Just a moment...' });
  assert.equal(result, 'cloudflare_managed_challenge');
});

test('classifyBlockedResponse distinguishes a JS challenge when classic markers are present', () => {
  const result = classifyBlockedResponse({ status: 403, headers: { server: 'cloudflare' }, markerText: 'window.__cf_chl_jschl_tk__=1' });
  assert.equal(result, 'cloudflare_js_challenge');
});

test('classifyBlockedResponse falls back to a static-403 label for a plain Cloudflare 403 with no challenge markers', () => {
  const result = classifyBlockedResponse({ status: 403, headers: { server: 'cloudflare' }, markerText: 'Forbidden' });
  assert.equal(result, 'cloudflare_static_403');
});

test('classifyBlockedResponse reports unknown rather than guessing when evidence is thin', () => {
  assert.equal(classifyBlockedResponse({ status: 403, headers: {}, markerText: '' }), 'http_403_unspecified');
  assert.equal(classifyBlockedResponse({ status: 500, headers: {}, markerText: '' }), 'unknown');
  assert.equal(classifyBlockedResponse({}), 'unknown');
});

test('classifyBlockedResponse treats a cf-mitigated:challenge header as managed-challenge evidence even without a title match', () => {
  const result = classifyBlockedResponse({ status: 403, headers: { server: 'cloudflare', 'cf-mitigated': 'challenge' }, markerText: '' });
  assert.equal(result, 'cloudflare_managed_challenge');
});

test('buildBlockedDiagnostic never includes markerText (raw page content) in its output, only the derived classification', () => {
  const diagnostic = buildBlockedDiagnostic({
    status: 403,
    headers: { server: 'cloudflare', 'set-cookie': 'leak=1' },
    markerText: 'Just a moment... <script>super secret body content nobody should persist</script>',
    at: '2026-11-13T00:00:00.000Z',
    workflowRunId: '12345',
  });
  assert.deepEqual(diagnostic, {
    at: '2026-11-13T00:00:00.000Z',
    status: 403,
    classification: 'cloudflare_managed_challenge',
    workflowRunId: '12345',
    headers: { server: 'cloudflare' },
  });
  assert.ok(!JSON.stringify(diagnostic).includes('secret body content'));
});

test('buildBlockedDiagnostic reads the workflow run ID from GITHUB_RUN_ID by default', () => {
  const prev = process.env.GITHUB_RUN_ID;
  process.env.GITHUB_RUN_ID = '999888';
  try {
    const diagnostic = buildBlockedDiagnostic({ status: 403, headers: {}, markerText: '' });
    assert.equal(diagnostic.workflowRunId, '999888');
  } finally {
    if (prev === undefined) delete process.env.GITHUB_RUN_ID;
    else process.env.GITHUB_RUN_ID = prev;
  }
});

test('buildBlockedDiagnostic defaults workflowRunId to null outside a workflow run', () => {
  const prev = process.env.GITHUB_RUN_ID;
  delete process.env.GITHUB_RUN_ID;
  try {
    const diagnostic = buildBlockedDiagnostic({ status: 403, headers: {}, markerText: '' });
    assert.equal(diagnostic.workflowRunId, null);
  } finally {
    if (prev !== undefined) process.env.GITHUB_RUN_ID = prev;
  }
});
