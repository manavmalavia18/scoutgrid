import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Exercises browser_runtime.py's own contract directly — no real browser,
// no patchright import triggered (PatchrightRuntime only imports patchright
// lazily inside open()). Run from repo root like the rest of the suite so
// `from browser_runtime import ...` resolves.
function python(code) {
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('only patchright is registered for production use', () => {
  const out = python(`
import json, browser_runtime as br
print(json.dumps(sorted(br.RUNTIME_REGISTRY.keys())))
`);
  assert.deepEqual(JSON.parse(out), ['patchright']);
});

test('get_runtime("patchright") returns a BrowserRuntime instance named "patchright"', () => {
  const out = python(`
import json, browser_runtime as br
rt = br.get_runtime('patchright')
print(json.dumps([isinstance(rt, br.BrowserRuntime), rt.name]))
`);
  assert.deepEqual(JSON.parse(out), [true, 'patchright']);
});

test('cloakbrowser is a recognized-but-unregistered engine with an explicit boundary message', () => {
  const out = python(`
import json, browser_runtime as br
try:
    br.get_runtime('cloakbrowser')
    print(json.dumps(['no_error']))
except br.UnknownBrowserEngine as e:
    print(json.dumps(['raised', 'browser-lab' in str(e), 'cloakbrowser' not in br.RUNTIME_REGISTRY]))
`);
  assert.deepEqual(JSON.parse(out), ['raised', true, true]);
});

test('an unrecognized engine name raises UnknownBrowserEngine listing what is available', () => {
  const out = python(`
import json, browser_runtime as br
try:
    br.get_runtime('totally-made-up')
    print(json.dumps(['no_error']))
except br.UnknownBrowserEngine as e:
    print(json.dumps(['raised', 'patchright' in str(e)]))
`);
  assert.deepEqual(JSON.parse(out), ['raised', true]);
});

test('engine name lookup is case/whitespace insensitive', () => {
  const out = python(`
import json, browser_runtime as br
rt = br.get_runtime('  PatchRight  ')
print(json.dumps(rt.name))
`);
  assert.equal(JSON.parse(out), 'patchright');
});

test('PatchrightRuntime/PatchrightSession satisfy the abstract interface contracts', () => {
  const out = python(`
import json, browser_runtime as br
print(json.dumps([
    issubclass(br.PatchrightRuntime, br.BrowserRuntime),
    issubclass(br.PatchrightSession, br.BrowserSession),
    hasattr(br.PatchrightSession, 'minimize_window'),
]))
`);
  assert.deepEqual(JSON.parse(out), [true, true, true]);
});

test('BrowserRuntime/BrowserSession cannot be instantiated directly (abstract contract enforced)', () => {
  const out = python(`
import json, browser_runtime as br
results = []
for cls, kwargs in ((br.BrowserRuntime, {}), (br.BrowserSession, {})):
    try:
        cls()
        results.append('instantiated')
    except TypeError:
        results.append('blocked')
print(json.dumps(results))
`);
  assert.deepEqual(JSON.parse(out), ['blocked', 'blocked']);
});

test('a custom BrowserRuntime can be registered without touching scrape-hiringcafe.py', () => {
  // Demonstrates the "future authorized engine doesn't require a scraper
  // rewrite" contract: a fake runtime implementing the interface can be
  // dropped into the registry and resolved through the same get_runtime()
  // call scrape-hiringcafe.py itself uses.
  const out = python(`
import json, browser_runtime as br

class FakeSession(br.BrowserSession):
    def goto(self, url, timeout_ms): return 200
    def content(self): return '<script id="__NEXT_DATA__">{"props":{"pageProps":{"ssrHits":[]}}}</script>'
    def title(self): return 'ok'
    def wait_for_selector(self, selector, timeout_ms): return None
    def close(self): return None

class FakeRuntime(br.BrowserRuntime):
    name = 'fake-future-engine'
    def open(self, profile_dir): return FakeSession()

br.RUNTIME_REGISTRY['fake-future-engine'] = FakeRuntime
rt = br.get_runtime('fake-future-engine')
session = rt.open(None)
print(json.dumps([rt.name, session.goto('http://x', 1000), session.title()]))
`);
  assert.deepEqual(JSON.parse(out), ['fake-future-engine', 200, 'ok']);
});
