import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCombinedTitleFilter } from '../lib/track-title-filter.mjs';
import { buildTitleFilter } from '../lib/title-filter.mjs';
import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';

const software = title => /software engineer/i.test(title);

test('tracked-board scan accepts data engineering roles alongside software without including senior roles', () => {
  const match = buildCombinedTitleFilter(software, { includeData: true });
  assert.equal(match('Software Engineer'), true);
  assert.equal(match('Data Engineer'), true);
  assert.equal(match('Analytics Engineer'), true);
  assert.equal(match('Database Administrator'), true);
  assert.equal(match('Senior Data Engineer'), false);
  assert.equal(match('Civil Engineer'), false);
});

test('data-title extension still applies the real portals.yml negative exclusions', () => {
  const { title_filter: config } = yaml.load(readFileSync(new URL('../portals.yml', import.meta.url), 'utf8'));
  const match = buildCombinedTitleFilter(buildTitleFilter(config), {
    includeData: true, negativeFilter: buildTitleFilter({ negative: config.negative }),
  });
  assert.equal(match('Data Engineer'), true);
  for (const title of ['Data Engineer Intern', 'Data Engineer - TS/SCI', 'Data Engineer .NET']) {
    assert.equal(match(title), false, title);
  }
});

test('other scanner modes retain the existing software-only filter', () => {
  const match = buildCombinedTitleFilter(software, { includeData: false });
  assert.equal(match('Software Engineer'), true);
  assert.equal(match('Data Engineer'), false);
});

test('tracked runner enables the data collector; scanner applies it without changing the HiringCafe path', () => {
  const runner = readFileSync(new URL('../run-tracked.mjs', import.meta.url), 'utf8');
  const scanner = readFileSync(new URL('../scan.mjs', import.meta.url), 'utf8');
  assert.match(runner, /CAREER_OPS_INCLUDE_DATA: '1'/);
  assert.match(scanner, /buildCombinedTitleFilter\(buildTitleFilter\(config\.title_filter\),\s*\{\s*includeData: process\.env\.CAREER_OPS_INCLUDE_DATA === '1',\s*negativeFilter: buildTitleFilter\(\{ negative: config\.title_filter\?\.negative \}\)/);
  assert.doesNotMatch(runner, /browser-lab|cloakbrowser|hiringcafe-feed/);
});
