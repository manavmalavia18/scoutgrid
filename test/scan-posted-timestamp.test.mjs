import test from 'node:test';
import assert from 'node:assert/strict';
import { formatScanHistoryRow } from '../scan.mjs';

test('scan history preserves an ATS publication timestamp rather than truncating it to midnight', () => {
  const at = '2026-11-12T19:23:41.000Z';
  const row = formatScanHistoryRow({ url: 'https://job-boards.greenhouse.io/acme/jobs/1', source: 'greenhouse-api',
    title: 'Data Engineer', company: 'Acme', location: 'New York', postedAt: Date.parse(at) }, '2026-11-12T19:25:00Z');
  const fields = row.split('\t');
  assert.equal(fields.length, 12);
  assert.equal(fields[8], at);
  assert.equal(fields[0], 'https://job-boards.greenhouse.io/acme/jobs/1');
});
