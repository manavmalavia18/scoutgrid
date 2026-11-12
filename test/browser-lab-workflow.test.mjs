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
  assert.match(source, /node browser-lab\/report\.mjs/);
  assert.match(source, /exit_code=\$status/);
  assert.match(source, /RUNNER_TEMP\/playwright\.json/);
  assert.match(source, /RUNNER_TEMP\/cloakbrowser\.json/);
  assert.match(source, /if: always\(\)/);
  assert.doesNotMatch(source, /hiringcafe|tailscale|searchState|CLOAKBROWSER_LICENSE_KEY:.*TAILSCALE/i);
});

test('the preflight step distinguishes license/binary/install/launch failures and never fails the job just for a missing license', () => {
  const source = readFileSync(new URL('.github/workflows/browser-lab.yml', root), 'utf8');
  assert.match(source, /node browser-lab\/preflight\.mjs/);
  // The secret only ever reaches the preflight/cloak steps' own env blocks —
  // never a command-line argument, never printed directly, never a
  // workflow_dispatch input.
  const preflightEnvBlocks = source.match(/env:\n\s+CLOAKBROWSER_LICENSE_KEY: \$\{\{ secrets\.CLOAKBROWSER_LICENSE_KEY \}\}/g) || [];
  assert.ok(preflightEnvBlocks.length >= 2, 'expected the secret wired into both the preflight and cloak steps');
  assert.doesNotMatch(source, /workflow_dispatch:\s*\n\s*inputs:/);
  // A missing license must not fail the job (license_missing is excluded
  // from the hard-fail condition) while every other non-ok status does.
  assert.match(source, /steps\.preflight\.outputs\.status != 'ok' && steps\.preflight\.outputs\.status != 'license_missing'/);
  assert.match(source, /steps\.preflight\.outputs\.status == 'ok'/);
});
