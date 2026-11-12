import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

test('snapshot publisher preserves concurrent unrelated changes and only commits owned files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scoutgrid-push-'));
  try {
    const remote = join(dir, 'remote.git'), a = join(dir, 'a'), b = join(dir, 'b');
    git(dir, 'init', '--bare', remote);
    git(dir, 'clone', remote, a);
    git(a, 'config', 'user.name', 'test');
    git(a, 'config', 'user.email', 'test@example.com');
    mkdirSync(join(a, 'data'));
    writeFileSync(join(a, 'data/owned.json'), 'old');
    writeFileSync(join(a, 'data/other.json'), 'old');
    git(a, 'add', '.'); git(a, 'commit', '-m', 'initial'); git(a, 'push', 'origin', 'HEAD:main');
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(dir, 'clone', remote, b);
    git(b, 'config', 'user.name', 'test');
    git(b, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(a, 'data/owned.json'), 'new-owned');
    writeFileSync(join(a, 'data/other.json'), 'stale-unrelated');
    git(a, 'add', 'data');
    mkdirSync(join(b, '.github/workflows'), { recursive: true });
    writeFileSync(join(b, '.github/workflows/new.yml'), 'important workflow');
    writeFileSync(join(b, 'data/other.json'), 'new-unrelated');
    git(b, 'add', '.'); git(b, 'commit', '-m', 'concurrent work'); git(b, 'push');
    const script = new URL('../scripts/push-owned-snapshot.sh', import.meta.url).pathname;
    const r = spawnSync('bash', [script, 'hc', 'data/owned.json'], { cwd: a, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    git(b, 'pull', '--ff-only');
    assert.equal(readFileSync(join(b, 'data/owned.json'), 'utf8'), 'new-owned');
    assert.equal(readFileSync(join(b, 'data/other.json'), 'utf8'), 'new-unrelated');
    assert.equal(existsSync(join(b, '.github/workflows/new.yml')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
