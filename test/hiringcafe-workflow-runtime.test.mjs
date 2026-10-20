import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflows = [
  '.github/workflows/hc.yml',
  '.github/workflows/hc-data.yml',
];

for (const path of workflows) {
  test(`${path} pins a Patchright-compatible runner`, () => {
    const yaml = readFileSync(path, 'utf8');
    assert.match(yaml, /runs-on:\s*ubuntu-24\.04/);
  });

  test(`${path} allows enough time for a full HiringCafe scrape`, () => {
    const yaml = readFileSync(path, 'utf8');
    const timeout = Number(yaml.match(/timeout-minutes:\s*(\d+)/)?.[1] || 0);
    assert.ok(timeout >= 25, `expected timeout >= 25 minutes, got ${timeout}`);
  });
}
