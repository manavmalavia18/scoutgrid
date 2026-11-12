import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
test('browser lab has an isolated pinned dependency set', () => {
  const config = JSON.parse(readFileSync(new URL('browser-lab/package.json', root), 'utf8'));
  assert.equal(config.dependencies['cloakbrowser'], '0.7.2');
  assert.equal(config.dependencies['playwright-core'], '1.64.0');
});

test('manual GitHub workflow runs only a loopback fixture and isolates the license secret', () => {
  const source = readFileSync(new URL('.github/workflows/browser-lab.yml', root), 'utf8');
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /contents: read/);
  assert.match(source, /BROWSER_LAB_RUNTIME=playwright/);
  assert.match(source, /BROWSER_LAB_RUNTIME=cloakbrowser/);
  assert.match(source, /secrets\.CLOAKBROWSER_LICENSE_KEY/);
  assert.doesNotMatch(source, /hiringcafe|tailscale|searchState|CLOAKBROWSER_LICENSE_KEY:.*TAILSCALE/i);
});
