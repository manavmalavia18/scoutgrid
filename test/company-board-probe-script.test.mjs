import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const ROOT = new URL('..', import.meta.url).pathname;

// Stands in for Greenhouse/Ashby/Lever's real APIs so the test suite never
// makes a live network call: probe-company-boards.mjs's thin orchestration
// layer (the fetch() calls) is deliberately not unit tested directly — see
// lib/company-board-probe.mjs for the actually-tested pure logic (slug
// generation, cooldown decisions, response parsing). This test instead
// verifies the FILE-LEVEL contract: given a pre-seeded probe state (as if
// probes already ran), the script correctly skips already-resolved/
// tracked/cooldown-blocked companies and leaves portals.yml untouched when
// there is nothing new to probe — all reachable without a single live
// HTTP request.
function runProbeAgainst(tmpDir, extraEnv = {}) {
  return execFileSync(process.execPath, [join(ROOT, 'probe-company-boards.mjs'), '--limit', '5'], {
    cwd: tmpDir,
    env: {
      ...process.env,
      SCOUTGRID_PORTALS_PATH: join(tmpDir, 'portals.yml'),
      SCOUTGRID_DATA_DIR: join(tmpDir, 'data'),
      SCOUTGRID_UNRESOLVED_PATH: join(tmpDir, 'data', 'linkedin-unresolved-companies.json'),
      SCOUTGRID_PROBE_STATE_PATH: join(tmpDir, 'data', 'probe-state.json'),
      SCOUTGRID_PROBE_HEARTBEAT_PATH: join(tmpDir, 'data', 'probe-heartbeat.json'),
      ...extraEnv,
    },
    timeout: 20000,
  });
}

function seedPortals(dir, text) {
  writeFileSync(join(dir, 'portals.yml'), text);
  mkdirSync(join(dir, 'data'), { recursive: true });
}

test('a company already tracked by name is skipped and never re-probed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scoutgrid-board-probe-'));
  try {
    seedPortals(dir, [
      'tracked_companies:',
      '  - name: Existing Co',
      '    careers_url: https://job-boards.greenhouse.io/existingco',
      '    provider: greenhouse',
      '    enabled: true',
      '    notes: seed',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'data/linkedin-unresolved-companies.json'), JSON.stringify({
      fetchedAt: new Date().toISOString(),
      companies: [{ company: 'Existing Co', sampleLinkedInUrl: 'https://www.linkedin.com/jobs/view/1', sampleTitle: 'SWE' }],
    }));

    runProbeAgainst(dir);

    const doc = yaml.load(readFileSync(join(dir, 'portals.yml'), 'utf8'));
    assert.equal(doc.tracked_companies.length, 1, 'already-tracked company must not be duplicated or re-probed');

    const heartbeat = JSON.parse(readFileSync(join(dir, 'data/probe-heartbeat.json'), 'utf8'));
    assert.equal(heartbeat.candidatesConsidered, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a company already resolved by a prior run is skipped on the next run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scoutgrid-board-probe-resolved-'));
  try {
    seedPortals(dir, 'tracked_companies:\n');
    writeFileSync(join(dir, 'data/linkedin-unresolved-companies.json'), JSON.stringify({
      fetchedAt: new Date().toISOString(),
      companies: [{ company: 'ClickHouse', sampleLinkedInUrl: 'https://www.linkedin.com/jobs/view/2', sampleTitle: 'SWE' }],
    }));
    writeFileSync(join(dir, 'data/probe-state.json'), JSON.stringify({
      clickhouse: { status: 'resolved', ats: 'ashby', slug: 'clickhouse', probedAt: new Date().toISOString() },
    }));

    runProbeAgainst(dir);

    const heartbeat = JSON.parse(readFileSync(join(dir, 'data/probe-heartbeat.json'), 'utf8'));
    assert.equal(heartbeat.candidatesConsidered, 0, 'a company resolved in a prior run must not be re-probed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty unresolved-companies file produces a clean zero-candidate run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scoutgrid-board-probe-empty-'));
  try {
    seedPortals(dir, 'tracked_companies:\n');
    writeFileSync(join(dir, 'data/linkedin-unresolved-companies.json'), JSON.stringify({ fetchedAt: '', companies: [] }));

    runProbeAgainst(dir);

    const doc = yaml.load(readFileSync(join(dir, 'portals.yml'), 'utf8'));
    assert.equal(Array.isArray(doc.tracked_companies) ? doc.tracked_companies.length : 0, 0);
    const heartbeat = JSON.parse(readFileSync(join(dir, 'data/probe-heartbeat.json'), 'utf8'));
    assert.equal(heartbeat.candidatesConsidered, 0);
    assert.equal(heartbeat.resolved, 0);
    assert.equal(heartbeat.exhausted, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing unresolved-companies file does not crash the script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scoutgrid-board-probe-missing-'));
  try {
    seedPortals(dir, 'tracked_companies:\n');
    // deliberately do not write data/linkedin-unresolved-companies.json
    runProbeAgainst(dir);
    const heartbeat = JSON.parse(readFileSync(join(dir, 'data/probe-heartbeat.json'), 'utf8'));
    assert.equal(heartbeat.candidatesConsidered, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
