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

function runDiscoverAgainst(tmpDir) {
  execFileSync(process.execPath, [join(ROOT, 'discover-boards.mjs')], {
    cwd: tmpDir,
    env: {
      ...process.env,
      SCOUTGRID_PORTALS_PATH: join(tmpDir, 'portals.yml'),
      SCOUTGRID_DATA_DIR: join(tmpDir, 'data'),
      SCOUTGRID_BOARD_REGISTRY_PATH: join(tmpDir, 'data', 'official-board-registry.json'),
      SCOUTGRID_BOARD_HEARTBEAT_PATH: join(tmpDir, 'data', 'heartbeat.json'),
    },
  });
}

function seedPortals(dir, text) {
  writeFileSync(join(dir, 'portals.yml'), text);
  mkdirSync(join(dir, 'data'), { recursive: true });
}

test('new tracked_companies entries land before the next top-level key, not at EOF', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scoutgrid-board-registry-'));
  try {
    seedPortals(dir, [
      'title_filter:',
      '  positive: []',
      'tracked_companies:',
      '  - name: Existing Co',
      '    careers_url: https://job-boards.greenhouse.io/existingco',
      '    provider: greenhouse',
      '    enabled: true',
      '    notes: seed',
      'job_boards:',
      '  - name: Some Aggregator',
      '    provider: hiringcafe',
      '    enabled: false',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'data/hiringcafe-feed.json'), JSON.stringify({
      fetchedAt: new Date().toISOString(),
      jobs: [
        { url: 'https://job-boards.greenhouse.io/newco/jobs/1', company: 'New Co' },
      ],
    }));
    writeFileSync(join(dir, 'data/nextplay-feed.json'), JSON.stringify({ fetchedAt: '', jobs: [] }));

    runDiscoverAgainst(dir);

    const doc = yaml.load(readFileSync(join(dir, 'portals.yml'), 'utf8'));

    assert.equal(doc.tracked_companies.length, 2, 'new board must join tracked_companies, not job_boards');
    assert.equal(doc.job_boards.length, 1, 'job_boards must be untouched');
    assert.ok(doc.tracked_companies.some((c) => c.careers_url === 'https://job-boards.greenhouse.io/newco'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appending when tracked_companies is already the last key still works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scoutgrid-board-registry-last-'));
  try {
    seedPortals(dir, [
      'title_filter:',
      '  positive: []',
      'tracked_companies:',
      '  - name: Existing Co',
      '    careers_url: https://job-boards.greenhouse.io/existingco',
      '    provider: greenhouse',
      '    enabled: true',
      '    notes: seed',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'data/hiringcafe-feed.json'), JSON.stringify({
      fetchedAt: new Date().toISOString(),
      jobs: [{ url: 'https://jobs.lever.co/newco2/job-1', company: 'New Co Two' }],
    }));
    writeFileSync(join(dir, 'data/nextplay-feed.json'), JSON.stringify({ fetchedAt: '', jobs: [] }));

    runDiscoverAgainst(dir);

    const doc = yaml.load(readFileSync(join(dir, 'portals.yml'), 'utf8'));
    assert.equal(doc.tracked_companies.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a board already tracked is never re-added even if seen again in a lead', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scoutgrid-board-registry-dup-'));
  try {
    seedPortals(dir, [
      'tracked_companies:',
      '  - name: Suno',
      '    careers_url: https://jobs.ashbyhq.com/suno',
      '    provider: ashby',
      '    enabled: true',
      '    notes: seed',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'data/hiringcafe-feed.json'), JSON.stringify({
      fetchedAt: new Date().toISOString(),
      jobs: [{ url: 'https://jobs.ashbyhq.com/suno/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', company: 'Suno' }],
    }));
    writeFileSync(join(dir, 'data/nextplay-feed.json'), JSON.stringify({ fetchedAt: '', jobs: [] }));

    runDiscoverAgainst(dir);

    const doc = yaml.load(readFileSync(join(dir, 'portals.yml'), 'utf8'));
    assert.equal(doc.tracked_companies.length, 1);

    const heartbeat = JSON.parse(readFileSync(join(dir, 'data/heartbeat.json'), 'utf8'));
    assert.equal(heartbeat.newlyPromoted, 0);
    assert.equal(heartbeat.alreadyTracked, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('registry state persists across runs so re-discovery does not duplicate promotions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scoutgrid-board-registry-persist-'));
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
    writeFileSync(join(dir, 'data/hiringcafe-feed.json'), JSON.stringify({
      fetchedAt: new Date().toISOString(),
      jobs: [{ url: 'https://jobs.ashbyhq.com/persisted/job-1', company: 'Persisted Co' }],
    }));
    writeFileSync(join(dir, 'data/nextplay-feed.json'), JSON.stringify({ fetchedAt: '', jobs: [] }));

    runDiscoverAgainst(dir);
    const afterFirst = yaml.load(readFileSync(join(dir, 'portals.yml'), 'utf8'));
    assert.equal(afterFirst.tracked_companies.length, 2);

    // Second run against the same (now-updated) portals.yml and registry
    // state must not duplicate the entry it just promoted.
    runDiscoverAgainst(dir);
    const afterSecond = yaml.load(readFileSync(join(dir, 'portals.yml'), 'utf8'));
    assert.equal(afterSecond.tracked_companies.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('linkedin-feed.json is read as a source and only ATS-hosted urls promote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scoutgrid-board-registry-linkedin-'));
  try {
    seedPortals(dir, [
      'title_filter:',
      '  positive: []',
      'tracked_companies:',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'data/hiringcafe-feed.json'), JSON.stringify({ fetchedAt: '', jobs: [] }));
    writeFileSync(join(dir, 'data/nextplay-feed.json'), JSON.stringify({ fetchedAt: '', jobs: [] }));
    writeFileSync(join(dir, 'data/linkedin-feed.json'), JSON.stringify({
      fetchedAt: new Date().toISOString(),
      jobs: [
        // Most LinkedIn guest-search rows are bare linkedin.com links — must
        // be scanned (no crash) but never promoted, same as any other feed.
        { url: 'https://www.linkedin.com/jobs/view/4455911528', company: 'Amazon Web Services', title: 'SWE' },
        // The rare row that DOES carry a direct ATS-hosted url must promote
        // exactly like a HiringCafe/Wellfound lead would.
        { url: 'https://jobs.ashbyhq.com/linkedinfound/job-1', company: 'LinkedinFound Co', title: 'SWE' },
      ],
    }));

    runDiscoverAgainst(dir);

    const doc = yaml.load(readFileSync(join(dir, 'portals.yml'), 'utf8'));
    assert.equal(doc.tracked_companies.length, 1, 'only the ATS-hosted LinkedIn lead should promote');
    assert.equal(doc.tracked_companies[0].careers_url, 'https://jobs.ashbyhq.com/linkedinfound');

    const heartbeat = JSON.parse(readFileSync(join(dir, 'data/heartbeat.json'), 'utf8'));
    assert.equal(heartbeat.leadsScanned, 2, 'the bare linkedin.com lead must still count as scanned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a16z-feed.json is read as a source and promotes direct ATS leads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scoutgrid-board-registry-a16z-'));
  try {
    seedPortals(dir, [
      'title_filter:',
      '  positive: []',
      'tracked_companies:',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'data/hiringcafe-feed.json'), JSON.stringify({ fetchedAt: '', jobs: [] }));
    writeFileSync(join(dir, 'data/nextplay-feed.json'), JSON.stringify({ fetchedAt: '', jobs: [] }));
    writeFileSync(join(dir, 'data/linkedin-feed.json'), JSON.stringify({ fetchedAt: '', jobs: [] }));
    writeFileSync(join(dir, 'data/a16z-feed.json'), JSON.stringify({
      fetchedAt: new Date().toISOString(),
      jobs: [
        { url: 'https://jobs.ashbyhq.com/a16zfound/job-1/application', company: 'A16zFound Co', title: '' },
        { url: 'https://jobs.ashbyhq.com/a16zfound/job-2/application', company: 'A16zFound Co', title: '' },
      ],
    }));

    runDiscoverAgainst(dir);

    const doc = yaml.load(readFileSync(join(dir, 'portals.yml'), 'utf8'));
    assert.equal(doc.tracked_companies.length, 1, 'two leads for the same company must collapse to one board');
    assert.equal(doc.tracked_companies[0].careers_url, 'https://jobs.ashbyhq.com/a16zfound');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
