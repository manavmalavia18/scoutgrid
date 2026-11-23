import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// hc.yml/hc-data.yml moved to a self-hosted Mac runner on 2026-11-16 (no
// more Tailscale exit node — this machine's own residential IP is the
// network path now) — see hc.yml's own comments for the full rationale.
// jobright.yml is unchanged and still runs on a GitHub-hosted runner via
// the Tailscale exit node, so it keeps the original assertions below.
const selfHostedWorkflows = [
  '.github/workflows/hc.yml',
  '.github/workflows/hc-data.yml',
];
const tailscaleWorkflows = [
  '.github/workflows/jobright.yml',
];

for (const path of selfHostedWorkflows) {
  test(`${path} runs on the self-hosted Mac runner, not a GitHub-hosted one`, () => {
    const yaml = readFileSync(path, 'utf8');
    assert.match(yaml, /runs-on:\s*\[self-hosted,\s*macOS\]/);
  });

  test(`${path} has no Tailscale exit-node step (self-hosted runner uses its own network path)`, () => {
    const yaml = readFileSync(path, 'utf8');
    // Comments mentioning Tailscale (explaining WHY it was removed) are
    // fine and expected — only an actual step (the action, or the
    // disconnect command) must be absent.
    assert.equal(yaml.indexOf('uses: tailscale/github-action'), -1, 'self-hosted workflow should not connect to Tailscale');
    assert.equal(yaml.indexOf('tailscale down'), -1, 'self-hosted workflow should not disconnect Tailscale (never connected)');
  });

  test(`${path} allows enough time for a full scrape`, () => {
    const yaml = readFileSync(path, 'utf8');
    const timeout = Number(yaml.match(/timeout-minutes:\s*(\d+)/)?.[1] || 0);
    assert.ok(timeout >= 20, `expected timeout >= 20 minutes, got ${timeout}`);
  });
}

for (const path of tailscaleWorkflows) {
  test(`${path} pins a Patchright-compatible runner`, () => {
    const yaml = readFileSync(path, 'utf8');
    assert.match(yaml, /runs-on:\s*ubuntu-24\.04/);
  });

  test(`${path} disconnects the exit node before publishing to GitHub`, () => {
    const yaml = readFileSync(path, 'utf8');
    const disconnectAt = yaml.indexOf('name: Disconnect from Tailscale exit node');
    const commitAt = yaml.indexOf('name: Commit results');
    assert.ok(disconnectAt >= 0, 'missing Tailscale disconnect step');
    assert.ok(commitAt > disconnectAt, 'Tailscale must disconnect before git pull/push');
    assert.match(yaml.slice(disconnectAt, commitAt), /tailscale down/);
  });

  test(`${path} allows enough time for a full scrape`, () => {
    const yaml = readFileSync(path, 'utf8');
    const timeout = Number(yaml.match(/timeout-minutes:\s*(\d+)/)?.[1] || 0);
    assert.ok(timeout >= 20, `expected timeout >= 20 minutes, got ${timeout}`);
  });
}

test('jobright.yml pins scrapling below the version that removed capture_xhr', () => {
  // scrapling 0.5 (2026-10-27) removed the capture_xhr fetch param that
  // scrape-jobright.py depends on, raising "capture_xhr was removed; use
  // record_requests=True and session.network." on every fetch and stalling
  // the whole JobRight feed. An unbounded `>=0.4.13` install floats to
  // whatever is newest on PyPI at install time, so this must stay pinned
  // below 0.5 until scrape-jobright.py is migrated to the new
  // NetworkRecorder API.
  const yaml = readFileSync('.github/workflows/jobright.yml', 'utf8');
  const m = yaml.match(/pip install 'scrapling\[fetchers\]([^']*)'/);
  assert.ok(m, 'could not find the scrapling pip install line in jobright.yml');
  assert.match(m[1], /<\s*0\.5/, `scrapling install spec "${m[1]}" has no upper bound below 0.5`);
});
