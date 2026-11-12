import test from 'node:test';
import assert from 'node:assert/strict';
import { makeComparison } from '../browser-lab/report.mjs';

const playwright = { result: { runtime: 'playwright', status: 200, classification: 'ok', count: 1,
  startupMs: 601.2, navigationMs: 25.1, domParseMs: 33.5 }, exitCode: 0 };

test('report compares the same local fixture and shows process exit codes', () => {
  const cloak = { result: { runtime: 'cloakbrowser', status: 200, classification: 'ok', count: 1,
    startupMs: 700, navigationMs: 30, domParseMs: 40 }, exitCode: 0 };
  const report = makeComparison({ playwright, cloak, cloakAvailable: true });
  assert.match(report, /Playwright.*200.*ok \(1 job\).*601\.2.*25\.1.*33\.5.*0/);
  assert.match(report, /CloakBrowser.*200.*ok \(1 job\).*700.*30.*40.*0/);
});

test('report never interprets a missing CloakBrowser license as a pass', () => {
  const report = makeComparison({ playwright, cloak: {}, cloakAvailable: false });
  assert.match(report, /CloakBrowser: SKIPPED — repository license secret is absent/);
  assert.match(report, /CloakBrowser.*SKIPPED.*—.*—.*—.*—.*—/);
  assert.doesNotMatch(report, /CloakBrowser.*200.*ok/);
});

test('report shows failure exit status even if the browser produced no JSON', () => {
  const report = makeComparison({ playwright, cloak: { exitCode: 17 }, cloakAvailable: true });
  assert.match(report, /CloakBrowser.*failed.*17/);
});
