import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBrowserPage } from '../browser-lab/diagnostics.mjs';

test('distinguishes plain 403 from a Cloudflare challenge', () => {
  assert.equal(classifyBrowserPage({ status: 403, title: 'Forbidden', html: '<p>Denied</p>', dataPresent: false }), 'http_403');
  assert.equal(classifyBrowserPage({ status: 403, title: 'Just a moment...', html: '<p>Checking</p>', dataPresent: false }), 'cloudflare_challenge');
  assert.equal(classifyBrowserPage({ status: 200, title: 'Just a moment...', html: '<p>Checking</p>', dataPresent: false }), 'cloudflare_challenge');
});

test('distinguishes missing job data from a parser failure', () => {
  assert.equal(classifyBrowserPage({ status: 200, title: 'Jobs', html: '<p>No payload</p>', dataPresent: false }), 'missing_job_data');
  assert.equal(classifyBrowserPage({ status: 200, title: 'Jobs', html: '<div id="job-data">{broken</div>', dataPresent: true, parseError: new SyntaxError('bad json') }), 'parser_failure');
});

test('returns ok only for parsed job data with the expected shape', () => {
  assert.equal(classifyBrowserPage({ status: 200, title: 'Jobs', html: '<div id="job-data">{}</div>', dataPresent: true, dataValid: false }), 'missing_job_data');
  assert.equal(classifyBrowserPage({ status: 200, title: 'Jobs', html: '<div id="job-data">{"jobs":[]}</div>', dataPresent: true, dataValid: true }), 'ok');
});
