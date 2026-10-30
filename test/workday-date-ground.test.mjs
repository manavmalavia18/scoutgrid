import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWorkdayOffer, groundWorkdayPostedDates } from '../lib/workday-date-ground.mjs';

test('isWorkdayOffer detects via source=workday-api', () => {
  assert.equal(isWorkdayOffer({ source: 'workday-api', url: 'https://example.com/job/1' }), true);
});

test('isWorkdayOffer detects via myworkdayjobs.com hostname even without source set', () => {
  assert.equal(isWorkdayOffer({ url: 'https://zoom.wd5.myworkdayjobs.com/zoom/job/Remote--US/Software-Engineer_R19749-1' }), true);
});

test('isWorkdayOffer is false for non-Workday offers', () => {
  assert.equal(isWorkdayOffer({ source: 'greenhouse-api', url: 'https://job-boards.greenhouse.io/acme/jobs/1' }), false);
});

test('isWorkdayOffer handles malformed/missing url safely', () => {
  assert.equal(isWorkdayOffer({}), false);
  assert.equal(isWorkdayOffer(null), false);
  assert.equal(isWorkdayOffer({ url: 'not a url' }), false);
});

test('groundWorkdayPostedDates replaces postedAt with the real detail date for Workday offers', async () => {
  const offers = [
    { source: 'workday-api', url: 'https://zoom.wd5.myworkdayjobs.com/zoom/job/x', postedAt: undefined },
  ];
  const fakeFetch = async () => Date.parse('2026-10-15T00:00:00Z');
  const { offers: result, grounded, attempted } = await groundWorkdayPostedDates(offers, fakeFetch);
  assert.equal(attempted, 1);
  assert.equal(grounded, 1);
  assert.equal(result[0].postedAt, Date.parse('2026-10-15T00:00:00Z'));
});

test('groundWorkdayPostedDates leaves non-Workday offers completely untouched', async () => {
  const offers = [{ source: 'greenhouse-api', url: 'https://job-boards.greenhouse.io/acme/jobs/1', postedAt: 12345 }];
  const fakeFetch = async () => { throw new Error('should never be called for non-Workday offers'); };
  const { grounded, attempted } = await groundWorkdayPostedDates(offers, fakeFetch);
  assert.equal(attempted, 0);
  assert.equal(grounded, 0);
  assert.equal(offers[0].postedAt, 12345);
});

test('groundWorkdayPostedDates fails open: a failed detail fetch keeps the original postedAt', async () => {
  const offers = [{ source: 'workday-api', url: 'https://x.wd1.myworkdayjobs.com/x/job/y', postedAt: 999 }];
  const failingFetch = async () => { throw new Error('network error'); };
  const { grounded, attempted } = await groundWorkdayPostedDates(offers, failingFetch);
  assert.equal(attempted, 1);
  assert.equal(grounded, 0);
  assert.equal(offers[0].postedAt, 999, 'original list-level postedAt must survive a failed detail fetch');
});

test('groundWorkdayPostedDates fails open: a detail fetch returning undefined keeps the original postedAt', async () => {
  const offers = [{ source: 'workday-api', url: 'https://x.wd1.myworkdayjobs.com/x/job/y', postedAt: undefined }];
  const emptyFetch = async () => undefined;
  const { grounded } = await groundWorkdayPostedDates(offers, emptyFetch);
  assert.equal(grounded, 0);
  assert.equal(offers[0].postedAt, undefined, 'stays undefined, not coerced to some fake value');
});

test('groundWorkdayPostedDates processes a mixed batch of Workday and non-Workday offers correctly', async () => {
  const offers = [
    { source: 'workday-api', url: 'https://a.wd1.myworkdayjobs.com/a/job/1', postedAt: undefined },
    { source: 'greenhouse-api', url: 'https://job-boards.greenhouse.io/b/jobs/2', postedAt: 777 },
    { source: 'workday-api', url: 'https://c.wd2.myworkdayjobs.com/c/job/3', postedAt: undefined },
  ];
  const fakeFetch = async (url) => (url.includes('/a/') ? 1000 : 2000);
  const { grounded, attempted } = await groundWorkdayPostedDates(offers, fakeFetch);
  assert.equal(attempted, 2);
  assert.equal(grounded, 2);
  assert.equal(offers[0].postedAt, 1000);
  assert.equal(offers[1].postedAt, 777, 'non-Workday offer untouched');
  assert.equal(offers[2].postedAt, 2000);
});

test('groundWorkdayPostedDates handles an empty offers list without error', async () => {
  const { grounded, attempted, offers } = await groundWorkdayPostedDates([], async () => 1);
  assert.equal(grounded, 0);
  assert.equal(attempted, 0);
  assert.deepEqual(offers, []);
});

test('groundWorkdayPostedDates respects a concurrency cap without dropping any offers', async () => {
  const offers = Array.from({ length: 12 }, (_, i) => ({
    source: 'workday-api',
    url: `https://x.wd1.myworkdayjobs.com/x/job/${i}`,
    postedAt: undefined,
  }));
  let maxConcurrent = 0;
  let current = 0;
  const trackedFetch = async () => {
    current += 1;
    maxConcurrent = Math.max(maxConcurrent, current);
    await new Promise((r) => setTimeout(r, 5));
    current -= 1;
    return 5000;
  };
  const { grounded, attempted } = await groundWorkdayPostedDates(offers, trackedFetch, { concurrency: 3 });
  assert.equal(attempted, 12);
  assert.equal(grounded, 12);
  assert.ok(maxConcurrent <= 3, `concurrency cap violated: saw ${maxConcurrent} in flight`);
  assert.ok(offers.every((o) => o.postedAt === 5000));
});
