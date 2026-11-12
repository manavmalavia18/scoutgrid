import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scrape-hiringcafe.py', import.meta.url));

// Loads scrape-hiringcafe.py the same way hiringcafe-page-diagnostics.test.mjs
// does (importlib, no main()), after registering a fake BrowserRuntime in
// browser_runtime's shared registry so scrape()'s own get_runtime() call
// resolves it — this exercises scrape()'s lifecycle wrapping (init error ->
// browser_init_failed, navigation error -> navigation_error, cleanup error
// logged but not masking the real result/exception) with no real browser
// and no patchright dependency.

test('browser init failure -> RuntimeError("browser_init_failed: ...")', () => {
  const code = `
import importlib.util, json, browser_runtime as br

class BoomRuntime(br.BrowserRuntime):
    name = 'boom-init'
    def open(self, profile_dir):
        raise br.BrowserInitError('could not launch')
br.RUNTIME_REGISTRY['boom-init'] = BoomRuntime

spec = importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

try:
    m.scrape(1, 2, 'q', 0.01, None, engine='boom-init')
    print(json.dumps(['no_error']))
except RuntimeError as e:
    print(json.dumps(['raised', str(e).startswith('browser_init_failed:')]))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['raised', true]);
});

test('navigation failure -> RuntimeError("navigation_error: ...") and session.close() is still called', () => {
  const code = `
import importlib.util, json, browser_runtime as br

closed = []

class BoomSession(br.BrowserSession):
    def goto(self, url, timeout_ms):
        raise br.NavigationError('dns failure')
    def content(self): return ''
    def title(self): return ''
    def wait_for_selector(self, selector, timeout_ms): return None
    def close(self): closed.append(True)

class BoomRuntime(br.BrowserRuntime):
    name = 'boom-nav'
    def open(self, profile_dir): return BoomSession()
br.RUNTIME_REGISTRY['boom-nav'] = BoomRuntime

spec = importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

try:
    m.scrape(1, 2, 'q', 0.01, None, engine='boom-nav')
    print(json.dumps(['no_error', closed]))
except RuntimeError as e:
    print(json.dumps(['raised', str(e).startswith('navigation_error:'), closed]))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['raised', true, [true]]);
});

test('cleanup failure is logged but does not mask a successful scrape result', () => {
  const code = `
import importlib.util, json, browser_runtime as br

HITS_HTML = '<script id="__NEXT_DATA__">{"props":{"pageProps":{"ssrHits":[],"ssrTotalCount":0,"ssrIsLastPage":true}}}</script>'

class LeakySession(br.BrowserSession):
    def goto(self, url, timeout_ms): return 200
    def content(self): return HITS_HTML
    def title(self): return 'Jobs'
    def wait_for_selector(self, selector, timeout_ms): return None
    def close(self): raise br.CleanupError('context already closed')

class LeakyRuntime(br.BrowserRuntime):
    name = 'leaky-cleanup'
    def open(self, profile_dir): return LeakySession()
br.RUNTIME_REGISTRY['leaky-cleanup'] = LeakyRuntime

spec = importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

payload = m.scrape(1, 2, 'q', 0.01, None, engine='leaky-cleanup')
print(json.dumps(['ok', payload['ok'], payload['engine'], payload['count']]))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['ok', true, 'leaky-cleanup', 0]);
});

test('cleanup failure is logged but does not swallow an earlier real scrape error', () => {
  const code = `
import importlib.util, json, browser_runtime as br

class DoublyBoomSession(br.BrowserSession):
    def goto(self, url, timeout_ms): return 403
    def content(self): return '<div>Just a moment... checking your browser</div>'
    def title(self): return 'Just a moment...'
    def wait_for_selector(self, selector, timeout_ms): return None
    def close(self): raise br.CleanupError('context already closed')

class DoublyBoomRuntime(br.BrowserRuntime):
    name = 'doubly-boom'
    def open(self, profile_dir): return DoublyBoomSession()
br.RUNTIME_REGISTRY['doubly-boom'] = DoublyBoomRuntime

spec = importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

try:
    m.scrape(1, 2, 'q', 0.01, None, engine='doubly-boom')
    print(json.dumps(['no_error']))
except RuntimeError as e:
    # The original cloudflare_challenge diagnostic must survive — a failed
    # cleanup must never replace it with a CleanupError.
    print(json.dumps(['raised', str(e).startswith('cloudflare_challenge:')]))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['raised', true]);
});

test('an unknown BROWSER_ENGINE is rejected before any browser is opened', () => {
  const code = `
import importlib.util, json, browser_runtime as br

opened = []
class TrackingRuntime(br.BrowserRuntime):
    name = 'tracking'
    def open(self, profile_dir):
        opened.append(True)
        raise br.BrowserInitError('should never be reached')
br.RUNTIME_REGISTRY['tracking'] = TrackingRuntime

spec = importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

try:
    m.scrape(1, 2, 'q', 0.01, None, engine='cloakbrowser')
    print(json.dumps(['no_error', opened]))
except RuntimeError as e:
    print(json.dumps(['raised', str(e).startswith('browser_engine_unavailable:'), opened]))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['raised', true, []]);
});

test('default engine (no --engine, no BROWSER_ENGINE) resolves to patchright', () => {
  const code = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
print(json.dumps(m.DEFAULT_ENGINE))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env, BROWSER_ENGINE: undefined } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout), 'patchright');
});

test('a successful scrape through a fake engine still goes through the real parsing/pagination path unchanged', () => {
  const code = `
import importlib.util, json, browser_runtime as br

PAGE0 = '<script id="__NEXT_DATA__">{"props":{"pageProps":{"ssrHits":[{"apply_url":"https://x.test/a","is_expired":false},{"apply_url":"https://x.test/a","is_expired":false}],"ssrTotalCount":1,"ssrIsLastPage":true}}}</script>'

class TwoHitsSameUrlSession(br.BrowserSession):
    def goto(self, url, timeout_ms): return 200
    def content(self): return PAGE0
    def title(self): return 'Jobs'
    def wait_for_selector(self, selector, timeout_ms): return None
    def close(self): return None

class TwoHitsRuntime(br.BrowserRuntime):
    name = 'two-hits'
    def open(self, profile_dir): return TwoHitsSameUrlSession()
br.RUNTIME_REGISTRY['two-hits'] = TwoHitsRuntime

spec = importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

payload = m.scrape(5, 2, 'q', 0.01, None, engine='two-hits')
# Dedup-by-apply_url still happens inside scrape() exactly as before the
# refactor — only the browser plumbing changed.
print(json.dumps([payload['count'], payload['pagesFetched'], payload['truncated']]))
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [1, 1, false]);
});
