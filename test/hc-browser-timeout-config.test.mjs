import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scrape-hiringcafe.py', import.meta.url));

function py(code, { env } = {}) {
  const result = spawnSync('python3', ['-c', code], {
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

function loadHc() {
  return `
import importlib.util
spec = importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;
}

test('default nav/selector timeouts match the pre-existing hardcoded values', () => {
  const out = py(`
${loadHc()}
import json
print(json.dumps([m.DEFAULT_NAV_TIMEOUT_MS, m.DEFAULT_SELECTOR_TIMEOUT_MS]))
`);
  assert.deepEqual(out, [60000, 45000]);
});

test('HC_NAV_TIMEOUT_MS/HC_SELECTOR_TIMEOUT_MS override the defaults when no explicit value is given', () => {
  const out = py(
    `
${loadHc()}
import json
print(json.dumps([
    m._resolve_timeout_ms(None, 'HC_NAV_TIMEOUT_MS', m.DEFAULT_NAV_TIMEOUT_MS),
    m._resolve_timeout_ms(None, 'HC_SELECTOR_TIMEOUT_MS', m.DEFAULT_SELECTOR_TIMEOUT_MS),
]))
`,
    { env: { HC_NAV_TIMEOUT_MS: '12345', HC_SELECTOR_TIMEOUT_MS: '6789' } },
  );
  assert.deepEqual(out, [12345, 6789]);
});

test('an explicit argument wins over the environment variable', () => {
  const out = py(
    `
${loadHc()}
import json
print(json.dumps(m._resolve_timeout_ms(5000, 'HC_NAV_TIMEOUT_MS', m.DEFAULT_NAV_TIMEOUT_MS)))
`,
    { env: { HC_NAV_TIMEOUT_MS: '12345' } },
  );
  assert.equal(out, 5000);
});

test('timeouts are clamped to a sane range — zero, negative, and absurdly large values are rejected', () => {
  const out = py(`
${loadHc()}
import json
print(json.dumps([
    m._resolve_timeout_ms(0, 'HC_NAV_TIMEOUT_MS', 60000),
    m._resolve_timeout_ms(-500, 'HC_NAV_TIMEOUT_MS', 60000),
    m._resolve_timeout_ms(999999999, 'HC_NAV_TIMEOUT_MS', 60000),
    m.MIN_TIMEOUT_MS,
    m.MAX_TIMEOUT_MS,
]))
`);
  assert.deepEqual(out, [1000, 1000, 180000, 1000, 180000]);
});

test('a malformed HC_NAV_TIMEOUT_MS value falls back to the default rather than crashing', () => {
  const out = py(
    `
${loadHc()}
import json
print(json.dumps(m._resolve_timeout_ms(None, 'HC_NAV_TIMEOUT_MS', 60000)))
`,
    { env: { HC_NAV_TIMEOUT_MS: 'not-a-number' } },
  );
  assert.equal(out, 60000);
});

test("scrape()'s returned payload reports the resolved timeouts actually used", () => {
  const code = `
${loadHc()}
import browser_runtime as br, json

HTML = '<script id="__NEXT_DATA__">{"props":{"pageProps":{"ssrHits":[],"ssrTotalCount":0,"ssrIsLastPage":true}}}</script>'

class FakeSession(br.BrowserSession):
    def goto(self, url, timeout_ms): return 200
    def content(self): return HTML
    def title(self): return 'ok'
    def wait_for_selector(self, selector, timeout_ms): return None
    def close(self): return None

class FakeRuntime(br.BrowserRuntime):
    name = 'fake'
    def open(self, profile_dir): return FakeSession()
br.RUNTIME_REGISTRY['fake'] = FakeRuntime

payload = m.scrape(1, 2, 'q', 0.01, None, engine='fake', nav_timeout_ms=11111, selector_timeout_ms=22222)
print(json.dumps([payload['navTimeoutMs'], payload['selectorTimeoutMs']]))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').pop()), [11111, 22222]);
});

test('cloudflare_challenge and http_403 are diagnosed immediately after goto — wait_for_selector is never called', () => {
  // Locks in requirement 3/4: a fake session that would raise if
  // wait_for_selector were ever invoked proves the immediate-diagnosis path
  // short-circuits before the 45s-style selector wait, for both diagnoses.
  const code = `
${loadHc()}
import browser_runtime as br, json

class NeverWaitsSession(br.BrowserSession):
    def __init__(self, status, html, title):
        self._status, self._html, self._title = status, html, title
    def goto(self, url, timeout_ms): return self._status
    def content(self): return self._html
    def title(self): return self._title
    def wait_for_selector(self, selector, timeout_ms):
        raise AssertionError('wait_for_selector must not be called for an immediate diagnosis')
    def close(self): return None

results = {}
for name, status, html, title in [
    ('cloudflare_challenge', 403, '<div>Checking your browser</div>', 'Just a moment...'),
    ('http_403', 403, '<div>Forbidden</div>', 'Forbidden'),
]:
    class OneShotRuntime(br.BrowserRuntime):
        name = 'oneshot'
        def open(self, profile_dir):
            return NeverWaitsSession(status, html, title)
    br.RUNTIME_REGISTRY['oneshot'] = OneShotRuntime
    try:
        m.scrape(2, 2, 'q', 0.01, None, engine='oneshot')
        results[name] = 'no_error'
    except RuntimeError as e:
        results[name] = str(e).split(':')[0]
print(json.dumps(results))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').pop()), {
    cloudflare_challenge: 'cloudflare_challenge',
    http_403: 'http_403',
  });
});

test('missing_job_data and parser_failure stay distinct from navigation_error/cloudflare_challenge/http_403', () => {
  const code = `
${loadHc()}
import browser_runtime as br, json

class ScriptedSession(br.BrowserSession):
    def __init__(self, html): self._html = html
    def goto(self, url, timeout_ms): return 200
    def content(self): return self._html
    def title(self): return 'Jobs'
    def wait_for_selector(self, selector, timeout_ms):
        if '__NEXT_DATA__' not in self._html:
            raise TimeoutError('no selector')
    def close(self): return None

results = {}
cases = {
    'missing_job_data': '<html><body>no data</body></html>',
    'parser_failure': '<script id="__NEXT_DATA__">{not valid json</script>',
}
for name, html in cases.items():
    class ScriptedRuntime(br.BrowserRuntime):
        name = 'scripted'
        def open(self, profile_dir): return ScriptedSession(html)
    br.RUNTIME_REGISTRY['scripted'] = ScriptedRuntime
    try:
        m.scrape(1, 2, 'q', 0.01, None, engine='scripted')
        results[name] = 'no_error'
    except RuntimeError as e:
        results[name] = str(e).split(':')[0]
print(json.dumps(results))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').pop()), {
    missing_job_data: 'missing_job_data',
    parser_failure: 'parser_failure',
  });
});

test('a profile-lock BrowserInitError is diagnosed as browser_profile_locked, distinct from a generic browser_init_failed', () => {
  const code = `
${loadHc()}
import browser_runtime as br, json

class LockedRuntime(br.BrowserRuntime):
    name = 'locked'
    def open(self, profile_dir):
        raise br.BrowserInitError(
            'BrowserType.launch_persistent_context: Opening in existing browser session. '
            'This usually means that the profile is already in use by another instance.'
        )
br.RUNTIME_REGISTRY['locked'] = LockedRuntime

class OtherFailureRuntime(br.BrowserRuntime):
    name = 'other-failure'
    def open(self, profile_dir):
        raise br.BrowserInitError('could not find Chrome executable')
br.RUNTIME_REGISTRY['other-failure'] = OtherFailureRuntime

results = {}
for engine in ('locked', 'other-failure'):
    try:
        m.scrape(1, 2, 'q', 0.01, '/tmp/some-profile', engine=engine)
        results[engine] = 'no_error'
    except RuntimeError as e:
        results[engine] = str(e).split(':')[0]
print(json.dumps(results))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').pop()), {
    locked: 'browser_profile_locked',
    'other-failure': 'browser_init_failed',
  });
});

test('_looks_like_profile_lock matches real patchright/Chrome lock wording and rejects unrelated errors', () => {
  const out = py(`
${loadHc()}
import json
print(json.dumps([
    m._looks_like_profile_lock('Opening in existing browser session. This usually means that the profile is already in use by another instance of Chromium.'),
    m._looks_like_profile_lock('SingletonLock: could not create'),
    m._looks_like_profile_lock('net::ERR_CONNECTION_REFUSED'),
    m._looks_like_profile_lock(''),
    m._looks_like_profile_lock(None),
]))
`);
  assert.deepEqual(out, [true, true, false, false, false]);
});

test('fetch-hiringcafe-feed.mjs passes --profile to the python scraper so independent tracks never share a default', () => {
  const src = readFileSync(new URL('../fetch-hiringcafe-feed.mjs', import.meta.url), 'utf8');
  assert.match(src, /HC_PROFILE/, 'must read an HC_PROFILE override, matching the HC_OUT/HC_HEARTBEAT/HC_LOCK pattern');
  assert.match(src, /'--profile',\s*PROFILE/, 'must forward the resolved profile to scrape-hiringcafe.py');
});
