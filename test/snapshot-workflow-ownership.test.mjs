import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const owned = {
  hc: ['data/hiringcafe-feed.json', 'data/scan-hc-heartbeat.json'],
  'hc-data': ['data/hiringcafe-feed-data.json', 'data/scan-hc-heartbeat-data.json'],
  nextplay: ['data/nextplay-feed.json', 'data/scan-nextplay-heartbeat.json'],
  jobright: ['data/jr-board-fresh.json', 'data/jr-companies.json', 'data/scan-jr-heartbeat.json'],
  linkedin: ['data/linkedin-feed.json', 'data/linkedin-unresolved-companies.json', 'data/scan-linkedin-heartbeat.json'],
  wellfound: ['data/wellfound-feed.json', 'data/scan-wellfound-heartbeat.json'],
  workday: ['data/cache/scan-dead-boards-workday.json', 'data/pipeline-workday.md', 'data/scan-history-workday.tsv', 'data/scan-workday-heartbeat.json'],
};

for (const [workflow, paths] of Object.entries(owned)) {
  test(`${workflow} only publishes its owned outputs`, () => {
    const source = readFileSync(new URL(`../.github/workflows/${workflow}.yml`, import.meta.url), 'utf8');
    const step = source.split('      - name: Commit results')[1];
    assert.ok(step, 'missing commit step');
    assert.ok(step.includes(`bash scripts/push-owned-snapshot.sh ${workflow} ${paths.join(' ')}`), 'missing scoped publisher invocation');
    assert.doesNotMatch(step, /git reset --soft|git add data\/|git add data\/ portals\.yml/);
  });
}
