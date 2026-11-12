import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import workable from '../providers/workable.mjs';

test('Bask Health official Workable board is tracked exactly once for direct scans', () => {
  const portals = yaml.load(readFileSync(new URL('../portals.yml', import.meta.url), 'utf8'));
  const entries = portals.tracked_companies.filter((entry) => entry.careers_url === 'https://apply.workable.com/bask-health-1/');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Bask Health');
  assert.equal(entries[0].provider, 'workable');
  assert.equal(entries[0].enabled, true);
  assert.deepEqual(workable.detect(entries[0]), {
    url: 'https://apply.workable.com/api/v1/widget/accounts/bask-health-1?details=true',
  });
});
