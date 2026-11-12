import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

test('tracked board workflow can backfill seven posted days manually without changing hourly one-day scans', () => {
  const text = readFileSync(new URL('../.github/workflows/tracked.yml', import.meta.url), 'utf8');
  const doc = yaml.load(text);
  const dispatch = doc.on?.workflow_dispatch || doc.true?.workflow_dispatch;
  assert.ok(dispatch?.inputs?.days);
  assert.equal(dispatch.inputs.days.default, '1');
  assert.equal(dispatch.inputs.days.type, 'choice');
  assert.ok(dispatch.inputs.days.options.includes('7'));
  const run = doc.jobs.scan.steps.find(x => x.name === 'Run tracked-boards scan');
  assert.match(run.env.TRACKED_SINCE, /inputs\.days/);
  assert.match(String(doc.jobs.scan['timeout-minutes']), /inputs\.days.*25.*13/);
});
