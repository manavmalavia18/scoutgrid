import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const value = (n) => typeof n === 'number' && Number.isFinite(n) ? String(n) : '—';
const display = ({ result, exitCode } = {}, skipped = false) => {
  if (skipped) return ['SKIPPED', '—', '—', '—', '—', '—'];
  const classification = result?.classification ? `${result.classification} (${result.count} job${result.count === 1 ? '' : 's'})` : 'failed';
  return [result?.status ?? '—', classification, value(result?.startupMs), value(result?.navigationMs),
    value(result?.domParseMs), exitCode ?? '—'];
};

export function makeComparison({ playwright = {}, cloak = {}, cloakAvailable = null, preflightStatus = null } = {}) {
  const row = (name, data, skipped) => `| ${name} | ${display(data, skipped).join(' | ')} |`;
  const unavailable = cloakAvailable === false;
  const PREFLIGHT_MESSAGES = {
    license_missing: 'CloakBrowser: SKIPPED — repository license secret is absent.',
    binary_missing: 'CloakBrowser: FAILED preflight (binary_missing) — license present but the Pro binary never appeared on disk after install.',
    install_failed: 'CloakBrowser: FAILED preflight (install_failed) — the binary install/download itself failed.',
    launch_failed: 'CloakBrowser: FAILED preflight (launch_failed) — the binary installed but the browser failed to launch.',
  };
  const statusLine = preflightStatus && PREFLIGHT_MESSAGES[preflightStatus]
    ? PREFLIGHT_MESSAGES[preflightStatus]
    : unavailable
      ? 'CloakBrowser: SKIPPED — repository license secret is absent.'
      : cloakAvailable === null
        ? 'CloakBrowser: NOT RUN — license detection did not complete.'
        : '';
  return [
    '### Local fixture browser comparison',
    'Both runtimes use the same loopback fixture; timings are milliseconds. Startup excludes local-server startup; DOM parsing includes title/content extraction and JSON classification.',
    '| Runtime | HTTP | DOM parsing | Startup ms | Navigation ms | DOM parse ms | Process exit code |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: |',
    row('Playwright', playwright, false),
    row('CloakBrowser', cloak, preflightStatus ? preflightStatus === 'license_missing' : unavailable),
    statusLine,
  ].filter(Boolean).join('\n') + '\n';
}

function readRun(directory, name) {
  let result;
  const json = join(directory, `${name}.json`);
  try { if (existsSync(json)) result = JSON.parse(readFileSync(json, 'utf8')); } catch { /* malformed output is not success */ }
  const exitFile = join(directory, `${name}.exit`);
  let exitCode;
  if (existsSync(exitFile)) {
    const text = readFileSync(exitFile, 'utf8').trim();
    if (/^\d+$/.test(text)) exitCode = Number(text);
  }
  return { result, exitCode };
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const dir = process.env.RUNNER_TEMP || process.cwd();
  const text = makeComparison({
    playwright: readRun(dir, 'playwright'), cloak: readRun(dir, 'cloakbrowser'),
    cloakAvailable: process.env.CLOAK_AVAILABLE === 'true' ? true : process.env.CLOAK_AVAILABLE === 'false' ? false : null,
    preflightStatus: process.env.CLOAK_PREFLIGHT_STATUS || null,
  });
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
