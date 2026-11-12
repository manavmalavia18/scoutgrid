/**
 * Strict CloakBrowser preflight — distinguishes the four ways the isolated
 * lab's licensed path can be unavailable, instead of collapsing them all
 * into one "SKIPPED" bucket:
 *
 *   license_missing  — no CLOAKBROWSER_LICENSE_KEY at all (the existing,
 *                       expected, non-failing case without the secret).
 *   binary_missing    — license present, but the Pro Chromium binary isn't
 *                       on disk even after an install attempt.
 *   install_failed    — the install/download step itself threw (network,
 *                       signature verification, disk, etc.).
 *   launch_failed     — binary is installed, but actually starting the
 *                       browser failed (crash, bad license denial at
 *                       launch time, etc.).
 *   ok                — license present, binary installed, browser
 *                       launched and closed cleanly.
 *
 * Deliberately separate from browser-lab/adapter.mjs's launchBrowser(),
 * which only cares about "can I get a Browser object" for the smoke test —
 * this module's job is diagnosing WHY the licensed path isn't usable, with
 * no production import, no Tailscale/HiringCafe access, and no challenge-
 * solving or evasion of any kind (it only installs and starts the vendor's
 * own documented binary against nothing — this file never navigates
 * anywhere).
 */

export async function runPreflight({
  licenseKey = process.env.CLOAKBROWSER_LICENSE_KEY || '',
  cloakBrowser,
  playwrightCore,
} = {}) {
  const result = {
    licensePresent: Boolean(licenseKey),
    binaryPresentBefore: null,
    installAttempted: false,
    installOk: null,
    installError: null,
    binaryPresentAfter: null,
    launchAttempted: false,
    launchOk: null,
    launchError: null,
    status: null,
  };

  if (!result.licensePresent) {
    result.status = 'license_missing';
    return result;
  }

  const { ensureBinary, binaryInfo, buildLaunchOptions } = cloakBrowser || await import('cloakbrowser');
  const { chromium } = playwrightCore || await import('playwright-core');

  try {
    result.binaryPresentBefore = Boolean(binaryInfo()?.version);
  } catch {
    result.binaryPresentBefore = false;
  }

  result.installAttempted = true;
  try {
    await ensureBinary(licenseKey);
    result.installOk = true;
  } catch (err) {
    result.installOk = false;
    result.installError = String(err?.message || err);
    result.status = 'install_failed';
    return result;
  }

  try {
    result.binaryPresentAfter = Boolean(binaryInfo()?.version);
  } catch {
    result.binaryPresentAfter = false;
  }
  if (!result.binaryPresentAfter) {
    result.status = 'binary_missing';
    return result;
  }

  result.launchAttempted = true;
  let browser;
  try {
    const launchOptions = await buildLaunchOptions({ headless: true, licenseKey });
    browser = await chromium.launch(launchOptions);
    result.launchOk = true;
  } catch (err) {
    result.launchOk = false;
    result.launchError = String(err?.message || err);
    result.status = 'launch_failed';
    return result;
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* best-effort cleanup only */ }
    }
  }

  result.status = 'ok';
  return result;
}

/** True for statuses that represent an actual problem once a license key is
 * present — license_missing is the expected no-secret case, never a
 * failure, so it's excluded here. */
export function isPreflightFailure(status) {
  return status === 'binary_missing' || status === 'install_failed' || status === 'launch_failed';
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { appendFileSync } = await import('node:fs');
  const result = await runPreflight();
  console.log(JSON.stringify(result, null, 2));

  const outputsPath = process.env.GITHUB_OUTPUT;
  if (outputsPath) {
    appendFileSync(outputsPath, `available=${result.status === 'ok'}\n`);
    appendFileSync(outputsPath, `status=${result.status}\n`);
  }

  // license_missing is the documented, expected, non-failing outcome
  // without the secret — exit 0 so the workflow step reads it as "skip",
  // not "crashed". Every other non-ok status is a real preflight failure.
  process.exitCode = result.status === 'ok' || result.status === 'license_missing' ? 0 : 1;
}
