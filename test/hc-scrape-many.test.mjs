import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Follows the exact fake-runtime pattern test/hc-browser-lifecycle.test.mjs
// and test/hc-browser-timeout-config.test.mjs already use — importlib-load
// scrape-hiringcafe.py (skips main()), register a Fake BrowserRuntime, call
// scrape_many() directly. No real browser, no patchright dependency.

const script = fileURLToPath(new URL('../scrape-hiringcafe.py', import.meta.url));

function python(code) {
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const PREAMBLE = `
import importlib.util, json, browser_runtime as br
spec = importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
HTML = '<script id="__NEXT_DATA__">{"props":{"pageProps":{"ssrHits":[],"ssrTotalCount":0,"ssrIsLastPage":true}}}</script>'
`;

test('scrape_many opens and closes the browser session exactly ONCE regardless of query count — the whole point of this function', () => {
  const code = `${PREAMBLE}
opens = []
closes = []

class CountingSession(br.BrowserSession):
    def __init__(self):
        self.minimized = False
    def goto(self, url, timeout_ms): return 200
    def content(self): return HTML
    def title(self): return 'ok'
    def wait_for_selector(self, selector, timeout_ms): return None
    def minimize_window(self): self.minimized = True
    def close(self): closes.append(True)

class CountingRuntime(br.BrowserRuntime):
    name = 'counting'
    def open(self, profile_dir):
        opens.append(True)
        return CountingSession()
br.RUNTIME_REGISTRY['counting'] = CountingRuntime

payload = m.scrape_many(['a', 'b', 'c', 'd', 'e'], 1, 2, 0.01, None, engine='counting')
print(json.dumps([len(opens), len(closes), sorted(payload['results'].keys())]))
`;
  const out = python(code);
  assert.deepEqual(JSON.parse(out), [1, 1, ['a', 'b', 'c', 'd', 'e']]);
});

test('scrape_many minimizes the window once, before any query runs — not per query', () => {
  const code = `${PREAMBLE}
events = []

class OrderedSession(br.BrowserSession):
    def goto(self, url, timeout_ms):
        events.append('goto')
        return 200
    def content(self): return HTML
    def title(self): return 'ok'
    def wait_for_selector(self, selector, timeout_ms): return None
    def minimize_window(self): events.append('minimize')
    def close(self): events.append('close')

class OrderedRuntime(br.BrowserRuntime):
    name = 'ordered'
    def open(self, profile_dir): return OrderedSession()
br.RUNTIME_REGISTRY['ordered'] = OrderedRuntime

m.scrape_many(['a', 'b'], 1, 2, 0.01, None, engine='ordered')
print(json.dumps(events))
`;
  const out = python(code);
  // minimize happens exactly once, before either query's goto, and close
  // happens exactly once at the very end.
  assert.deepEqual(JSON.parse(out), ['minimize', 'goto', 'goto', 'close']);
});

test('scrape_many keeps going after one query fails — a blocked/erroring query does not abort the batch', () => {
  const code = `${PREAMBLE}
class FlakySession(br.BrowserSession):
    def goto(self, url, timeout_ms):
        if 'bad' in url:
            raise br.NavigationError('boom')
        return 200
    def content(self): return HTML
    def title(self): return 'ok'
    def wait_for_selector(self, selector, timeout_ms): return None
    def close(self): return None

class FlakyRuntime(br.BrowserRuntime):
    name = 'flaky'
    def open(self, profile_dir): return FlakySession()
br.RUNTIME_REGISTRY['flaky'] = FlakyRuntime

payload = m.scrape_many(['good one', 'bad one', 'good two'], 1, 2, 0.01, None, engine='flaky')
r = payload['results']
print(json.dumps([
    r['good one'].get('ok'),
    r['bad one'].get('ok'), r['bad one'].get('error', '').startswith('navigation_error:'),
    r['good two'].get('ok'),
]))
`;
  const out = python(code);
  assert.deepEqual(JSON.parse(out), [true, false, true, true]);
});

test('scrape_many still raises (fatal, no partial results) when the browser itself cannot be opened', () => {
  const code = `${PREAMBLE}
class BoomRuntime(br.BrowserRuntime):
    name = 'boom-batch-init'
    def open(self, profile_dir):
        raise br.BrowserInitError('could not launch')
br.RUNTIME_REGISTRY['boom-batch-init'] = BoomRuntime

try:
    m.scrape_many(['a', 'b'], 1, 2, 0.01, None, engine='boom-batch-init')
    print(json.dumps(['no_error']))
except RuntimeError as e:
    print(json.dumps(['raised', str(e).startswith('browser_init_failed:')]))
`;
  const out = python(code);
  assert.deepEqual(JSON.parse(out), ['raised', true]);
});

test('scrape_many still calls close() even when every single query fails', () => {
  const code = `${PREAMBLE}
closed = []

class AllFailSession(br.BrowserSession):
    def goto(self, url, timeout_ms):
        raise br.NavigationError('always fails')
    def content(self): return ''
    def title(self): return ''
    def wait_for_selector(self, selector, timeout_ms): return None
    def close(self): closed.append(True)

class AllFailRuntime(br.BrowserRuntime):
    name = 'all-fail'
    def open(self, profile_dir): return AllFailSession()
br.RUNTIME_REGISTRY['all-fail'] = AllFailRuntime

payload = m.scrape_many(['a', 'b', 'c'], 1, 2, 0.01, None, engine='all-fail')
ok_count = sum(1 for r in payload['results'].values() if r.get('ok'))
print(json.dumps([len(closed), ok_count, len(payload['results'])]))
`;
  const out = python(code);
  assert.deepEqual(JSON.parse(out), [1, 0, 3]);
});

test('scrape_many results carry the same pagesFetched/hits/totalCount shape scrape() returns per query', () => {
  const code = `${PREAMBLE}
HITS_HTML = '<script id="__NEXT_DATA__">{"props":{"pageProps":{"ssrHits":[{"apply_url":"https://x.test/1","job_information":{"title":"Engineer"}}],"ssrTotalCount":1,"ssrIsLastPage":true}}}</script>'

class OneHitSession(br.BrowserSession):
    def goto(self, url, timeout_ms): return 200
    def content(self): return HITS_HTML
    def title(self): return 'ok'
    def wait_for_selector(self, selector, timeout_ms): return None
    def close(self): return None

class OneHitRuntime(br.BrowserRuntime):
    name = 'one-hit'
    def open(self, profile_dir): return OneHitSession()
br.RUNTIME_REGISTRY['one-hit'] = OneHitRuntime

payload = m.scrape_many(['q1'], 5, 2, 0.01, None, engine='one-hit')
r = payload['results']['q1']
print(json.dumps([r['pagesFetched'], r['count'], r['totalCount'], r['truncated']]))
`;
  const out = python(code);
  assert.deepEqual(JSON.parse(out), [1, 1, 1, false]);
});

test('scrape() (single-query path) is unaffected by the refactor: still opens/closes exactly once for one query', () => {
  const code = `${PREAMBLE}
opens = []
closes = []

class CountingSession(br.BrowserSession):
    def goto(self, url, timeout_ms): return 200
    def content(self): return HTML
    def title(self): return 'ok'
    def wait_for_selector(self, selector, timeout_ms): return None
    def close(self): closes.append(True)

class CountingRuntime(br.BrowserRuntime):
    name = 'counting-single'
    def open(self, profile_dir):
        opens.append(True)
        return CountingSession()
br.RUNTIME_REGISTRY['counting-single'] = CountingRuntime

payload = m.scrape(1, 2, 'q', 0.01, None, engine='counting-single')
print(json.dumps([len(opens), len(closes), payload['query']]))
`;
  const out = python(code);
  assert.deepEqual(JSON.parse(out), [1, 1, 'q']);
});
