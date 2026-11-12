import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import greenhouse from '../providers/greenhouse.mjs';
import ashby from '../providers/ashby.mjs';
import lever from '../providers/lever.mjs';

const verified = [
  ['Zenni Optical', 'https://job-boards.greenhouse.io/zennioptical', 'greenhouse', 'https://boards-api.greenhouse.io/v1/boards/zennioptical/jobs'],
  ['Fanatics Collectibles', 'https://job-boards.greenhouse.io/fanaticscollectibles', 'greenhouse', 'https://boards-api.greenhouse.io/v1/boards/fanaticscollectibles/jobs'],
  ['Torc Robotics', 'https://job-boards.greenhouse.io/torcrobotics', 'greenhouse', 'https://boards-api.greenhouse.io/v1/boards/torcrobotics/jobs'],
  ['Runway ML', 'https://jobs.ashbyhq.com/runway-ml', 'ashby', 'https://api.ashbyhq.com/posting-api/job-board/runway-ml?includeCompensation=true'],
  ['Laminar', 'https://jobs.lever.co/runlaminar', 'lever', 'https://api.lever.co/v0/postings/runlaminar'],
];

test('similarly named Ashby boards retain distinct employer identities', () => {
  const doc = yaml.load(readFileSync(new URL('../portals.yml', import.meta.url), 'utf8'));
  const existing = doc.tracked_companies.find(c => c.careers_url === 'https://jobs.ashbyhq.com/Runway');
  const discovered = doc.tracked_companies.find(c => c.careers_url === 'https://jobs.ashbyhq.com/runway-ml');
  assert.equal(existing.name, 'cfo.ai');
  assert.equal(discovered.name, 'Runway ML');
  assert.notEqual(existing.name, discovered.name);
});

test('historical HiringCafe leads are promoted only as verified official board URLs, not historical jobs', () => {
  const doc = yaml.load(readFileSync(new URL('../portals.yml', import.meta.url), 'utf8'));
  const providers = { greenhouse, ashby, lever };
  for (const [name, url, provider, api] of verified) {
    const matches = doc.tracked_companies.filter(c => c.careers_url === url);
    assert.equal(matches.length, 1, url);
    assert.equal(matches[0].name, name);
    assert.equal(matches[0].provider, provider);
    assert.equal(matches[0].enabled, true);
    assert.equal(providers[provider].detect(matches[0])?.url, api);
  }
});
