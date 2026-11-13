import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnCdpBridgeProcess, terminateCdpBridgeProcess, CdpProcessError } from '../browser-lab/cdp-process.mjs';

/** A fake child_process.ChildProcess-shaped EventEmitter, controllable
 * from the test without spawning anything real. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    child.killed = true;
  };
  return child;
}

function emitExit(child, code, signal) {
  child.exitCode = code ?? null;
  child.signalCode = signal ?? null;
  child.emit('exit', code, signal);
}

test('spawnCdpBridgeProcess resolves with the reported port on a clean ready line', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = spawnCdpBridgeProcess({ spawnImpl, readyTimeoutMs: 2000 });
  child.stdout.emit('data', Buffer.from('{"ok":true,"port":54321}\n'));
  const result = await promise;
  assert.equal(result.port, 54321);
  assert.equal(result.child, child);
});

test('spawnCdpBridgeProcess rejects (and kills the child) on a reported startup failure', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = spawnCdpBridgeProcess({ spawnImpl, readyTimeoutMs: 2000 });
  child.stdout.emit('data', Buffer.from('{"ok":false,"error":"CLOAKBROWSER_LICENSE_KEY is required for the CDP bridge experiment"}\n'));
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof CdpProcessError);
    assert.match(err.message, /bridge reported startup failure/);
    return true;
  });
  assert.deepEqual(child.killCalls, ['SIGKILL']);
});

test('spawnCdpBridgeProcess rejects if the child exits before becoming ready, with stderr context', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = spawnCdpBridgeProcess({ spawnImpl, readyTimeoutMs: 2000 });
  child.stderr.emit('data', Buffer.from('Error: something crashed on launch\n'));
  emitExit(child, 1, null);
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof CdpProcessError);
    assert.match(err.message, /exited unexpectedly before becoming ready/);
    assert.match(err.message, /something crashed on launch/);
    return true;
  });
});

test('spawnCdpBridgeProcess rejects if the underlying spawn() itself errors (e.g. ENOENT)', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = spawnCdpBridgeProcess({ spawnImpl, readyTimeoutMs: 2000 });
  child.emit('error', new Error('spawn node ENOENT'));
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof CdpProcessError);
    assert.match(err.message, /failed to spawn bridge process/);
    return true;
  });
});

test('spawnCdpBridgeProcess kills the child and rejects if it never reports readiness (orphan prevention)', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = spawnCdpBridgeProcess({ spawnImpl, readyTimeoutMs: 20 });
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof CdpProcessError);
    assert.match(err.message, /did not become ready within 20ms/);
    return true;
  });
  assert.deepEqual(child.killCalls, ['SIGKILL']);
});

test('spawnCdpBridgeProcess ignores stdout noise before the real ready/failure line', async () => {
  const child = fakeChild();
  const spawnImpl = () => child;
  const promise = spawnCdpBridgeProcess({ spawnImpl, readyTimeoutMs: 2000 });
  child.stdout.emit('data', Buffer.from('[cloakbrowser] Downloading Pro Chromium...\n'));
  child.stdout.emit('data', Buffer.from('{"ok":true,"port":9999}\n'));
  const result = await promise;
  assert.equal(result.port, 9999);
});

test('terminateCdpBridgeProcess sends SIGTERM and does not escalate when the process exits promptly', async () => {
  const child = fakeChild();
  const promise = terminateCdpBridgeProcess(child, { gracefulTimeoutMs: 2000 });
  // Simulate the child reacting to SIGTERM by exiting on its own.
  setTimeout(() => emitExit(child, 0, null), 10);
  await promise;
  assert.deepEqual(child.killCalls, ['SIGTERM']);
});

test('terminateCdpBridgeProcess escalates to SIGKILL when the process ignores SIGTERM', async () => {
  const child = fakeChild();
  // Never exits on its own in this test — only the forced kill "exits" it.
  const originalKill = child.kill;
  child.kill = (signal) => {
    originalKill(signal);
    if (signal === 'SIGKILL') setTimeout(() => emitExit(child, null, 'SIGKILL'), 5);
  };
  await terminateCdpBridgeProcess(child, { gracefulTimeoutMs: 20 });
  assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);
});

test('terminateCdpBridgeProcess is a no-op on an already-exited process', async () => {
  const child = fakeChild();
  emitExit(child, 0, null);
  await terminateCdpBridgeProcess(child, { gracefulTimeoutMs: 2000 });
  assert.deepEqual(child.killCalls, []);
});

test('terminateCdpBridgeProcess signals the whole process group (-pid), not just the Node process, so a Chromium grandchild is reaped too', async () => {
  const child = fakeChild();
  child.pid = 424242;
  const groupSignals = [];
  const signalImpl = (pid, signal) => { groupSignals.push([pid, signal]); };
  const promise = terminateCdpBridgeProcess(child, { gracefulTimeoutMs: 2000, signalImpl });
  setTimeout(() => emitExit(child, 0, null), 10);
  await promise;
  assert.deepEqual(groupSignals, [[-424242, 'SIGTERM']]);
  assert.deepEqual(child.killCalls, [], 'the group signal succeeded, so the single-process fallback must never fire');
});

test('terminateCdpBridgeProcess escalates group signals from SIGTERM to SIGKILL, falling back to child.kill() only if the group signal itself fails', async () => {
  const child = fakeChild();
  child.pid = 424243;
  const originalKill = child.kill;
  child.kill = (signal) => { originalKill(signal); if (signal === 'SIGKILL') setTimeout(() => emitExit(child, null, 'SIGKILL'), 5); };
  const groupSignals = [];
  const signalImpl = (pid, signal) => {
    groupSignals.push([pid, signal]);
    if (signal === 'SIGKILL') throw new Error('ESRCH: no such process group'); // group already reaped
  };
  await terminateCdpBridgeProcess(child, { gracefulTimeoutMs: 20, signalImpl });
  assert.deepEqual(groupSignals, [[-424243, 'SIGTERM'], [-424243, 'SIGKILL']]);
  // Group SIGKILL failed (ESRCH), so the fallback single-process kill must still run.
  assert.deepEqual(child.killCalls, ['SIGKILL']);
});

test('spawnCdpBridgeProcess signals the whole process group on a readiness timeout, not just the Node process', async () => {
  const child = fakeChild();
  child.pid = 424244;
  const groupSignals = [];
  const signalImpl = (pid, signal) => { groupSignals.push([pid, signal]); };
  const spawnImpl = () => child;
  await assert.rejects(
    spawnCdpBridgeProcess({ spawnImpl, signalImpl, readyTimeoutMs: 20 }),
    CdpProcessError,
  );
  assert.deepEqual(groupSignals, [[-424244, 'SIGKILL']]);
  assert.deepEqual(child.killCalls, [], 'the group signal succeeded, so no single-process fallback should fire');
});
