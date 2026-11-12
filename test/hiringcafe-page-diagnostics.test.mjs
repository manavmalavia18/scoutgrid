import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scrape-hiringcafe.py', import.meta.url));

function python(expr) {
  const code = `import importlib.util, json; spec=importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)}); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print(json.dumps(${expr}))`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('production page diagnostic distinguishes challenge, plain 403 and missing data', () => {
  const html = '<script id="__NEXT_DATA__">{"props":{"pageProps":{"ssrHits":[]}}}</script>';
  assert.deepEqual(python(`[m.diagnose_page(403, 'Just a moment...', '<div>Checking your browser</div>'), m.diagnose_page(403, 'Forbidden', ''), m.diagnose_page(200, 'Jobs', ''), m.diagnose_page(200, 'Jobs', ${JSON.stringify(html)})]`),
    ['cloudflare_challenge', 'http_403', 'missing_job_data', 'ok']);
});

test('production parser distinguishes malformed JSON from missing page data', () => {
  const code = `import importlib.util,json; spec=importlib.util.spec_from_file_location('hc', ${JSON.stringify(script)}); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); out=[]\nfor html in ('<p>empty</p>', '<script id="__NEXT_DATA__">{broken</script>'):\n try: m.props_from_html(html)\n except RuntimeError as e: out.append(str(e).split(':')[0])\nprint(json.dumps(out))`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['missing_job_data', 'parser_failure']);
});
