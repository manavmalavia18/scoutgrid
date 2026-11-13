/**
 * Node child-process lifecycle management for the CDP bridge experiment —
 * isolated to browser-lab/. Spawns `cdp-bridge.mjs` as a subprocess (the
 * shape a real caller/test harness uses), detects startup failure/timeout,
 * and provides a graceful-then-forced termination sequence so a spawned
 * bridge (and the real Chromium it launched) can never be left running
 * after a test/caller is done with it or gets interrupted.
 *
 * Orphan prevention detail: the bridge is spawned `detached: true`, which
 * on POSIX makes its pid also its own process-group id. Termination
 * signals the whole group (`process.kill(-pid, signal)`) first, not just
 * the single Node process — because Playwright's Chromium child inherits
 * that same group, a forced SIGKILL of just the Node wrapper would NOT
 * reliably kill Chromium too (SIGKILL cannot be intercepted by anyone,
 * including Playwright's own cleanup, so the single-process kill alone is
 * a real orphan risk this group-kill closes). Falls back to killing just
 * the one process if the group signal fails (already-reaped group, or a
 * fake/non-POSIX child in tests).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class CdpProcessError extends Error {}

const DEFAULT_SCRIPT = fileURLToPath(new URL('./cdp-bridge.mjs', import.meta.url));

function signalProcessGroup(child, signal, signalImpl) {
  if (child.pid) {
    try {
      signalImpl(-child.pid, signal);
      return;
    } catch {
      // Group already gone, no permission, or (in unit tests) a fake pid
      // with no real OS process group — fall back below.
    }
  }
  child.kill(signal);
}

/**
 * Spawn `cdp-bridge.mjs` and wait for it to report readiness
 * (`{"ok":true,"port":N}` on stdout) or fail. Every failure path kills the
 * child's whole process group before rejecting, so a startup failure or
 * timeout never leaves an orphaned bridge or Chromium process running
 * unattended — the single purpose of this function beyond a bare
 * `child_process.spawn` call.
 */
export function spawnCdpBridgeProcess({
  scriptPath = DEFAULT_SCRIPT,
  env = process.env,
  spawnImpl = spawn,
  signalImpl = process.kill,
  readyTimeoutMs = 30000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('node', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'], env, detached: true });
    let stderr = '';
    let buf = '';
    let settled = false;
    let timer;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      fn();
    };

    const onStdout = (chunk) => {
      buf += chunk.toString();
      const okMatch = buf.match(/\{"ok":true,"port":(\d+)\}/);
      if (okMatch) {
        finish(() => resolve({ port: Number(okMatch[1]), child }));
        return;
      }
      const failMatch = buf.match(/\{"ok":false,"error":"([^"]*)"\}/);
      if (failMatch) {
        finish(() => {
          signalProcessGroup(child, 'SIGKILL', signalImpl);
          reject(new CdpProcessError(`bridge reported startup failure: ${failMatch[1]}`));
        });
      }
    };

    child.stdout.on('data', onStdout);
    child.stderr.on('data', (c) => { stderr += c.toString(); });

    child.once('error', (err) => {
      finish(() => reject(new CdpProcessError(`failed to spawn bridge process: ${err.message}`)));
    });

    child.once('exit', (code, signal) => {
      finish(() => reject(new CdpProcessError(
        `bridge process exited unexpectedly before becoming ready (code=${code} signal=${signal}): ${stderr.slice(-500)}`,
      )));
    });

    timer = setTimeout(() => {
      finish(() => {
        // Orphan prevention: a bridge that never reports readiness might
        // still have a browser launched underneath it (e.g. stuck in
        // waitForReady) — kill the whole process group rather than
        // leaving it running after we give up on it.
        signalProcessGroup(child, 'SIGKILL', signalImpl);
        reject(new CdpProcessError(`bridge process did not become ready within ${readyTimeoutMs}ms`));
      });
    }, readyTimeoutMs);
  });
}

/**
 * Terminate a previously-spawned bridge child process: SIGTERM first (lets
 * cdp-bridge.mjs's own close() run, which cleans up the browser and its
 * temp profile dir), then SIGKILL the whole process group if it hasn't
 * exited within `gracefulTimeoutMs`. Idempotent — a no-op if the process
 * has already exited. Resolves only once the process has genuinely
 * exited.
 */
export async function terminateCdpBridgeProcess(child, { gracefulTimeoutMs = 5000, signalImpl = process.kill } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
  });

  signalProcessGroup(child, 'SIGTERM', signalImpl);

  let timedOut = false;
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(); }, gracefulTimeoutMs)),
  ]);

  if (timedOut && child.exitCode === null && child.signalCode === null) {
    // SIGTERM alone didn't work — escalate to the whole group so the
    // real Chromium grandchild (which cannot clean itself up under a
    // SIGKILL of its parent) is reaped too, not just the Node wrapper.
    signalProcessGroup(child, 'SIGKILL', signalImpl);
    await exited;
  }
}
