#!/usr/bin/env node
/**
 * Self-healing staleness watchdog — checks every Tailscale-exit-node-
 * dependent feed (see lib/feed-staleness.mjs's WATCHED_FEEDS) and
 * automatically retriggers any workflow whose output has gone stale.
 *
 * Built 2026-10-30 after a recurring pattern: the Mac's battery-power
 * sleep timer (fixed separately via `pmset -b sleep 0`) killed the
 * Tailscale exit-node connection mid-run, so hc.yml/linkedin.yml/etc.
 * would hang until their own timeout-minutes killed them (reported as
 * "cancelled", not "failure" — easy to miss). Previously this required a
 * human noticing a stale feed and manually running `gh workflow run`.
 * This runs on GitHub's own infra (no Tailscale needed for the CHECK
 * itself, only for the actual scrape it may retrigger), every 20 minutes,
 * reading each feed JSON straight from the checked-out repo — not
 * raw.githubusercontent.com, whose CDN lags a few minutes behind pushes
 * (confirmed live 2026-10-30) and would make this watchdog see stale data
 * even right after a fresh push.
 *
 *   node check-feed-staleness.mjs            # check + retrigger stale ones
 *   node check-feed-staleness.mjs --dry-run  # report only, trigger nothing
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import { isStale, ageMinutesOf, fetchedAtFromFeedJson, WATCHED_FEEDS } from './lib/feed-staleness.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

const OWNER = process.env.GITHUB_REPOSITORY_OWNER || 'manavmalavia18';
const REPO = (process.env.GITHUB_REPOSITORY || 'manavmalavia18/scoutgrid').split('/')[1];
const TOKEN = process.env.GITHUB_TOKEN;
const API = 'https://api.github.com';

function loadFeedJson(relPath) {
  const full = resolve(ROOT, relPath);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

async function ghApi(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  return res;
}

/** True if the given workflow already has a run in progress/queued — avoids piling up duplicate retries. */
async function hasActiveRun(workflowFile) {
  const res = await ghApi(`/repos/${OWNER}/${REPO}/actions/workflows/${workflowFile}/runs?status=in_progress&per_page=1`);
  if (res.ok) {
    const body = await res.json();
    if ((body.total_count || 0) > 0) return true;
  }
  const res2 = await ghApi(`/repos/${OWNER}/${REPO}/actions/workflows/${workflowFile}/runs?status=queued&per_page=1`);
  if (res2.ok) {
    const body2 = await res2.json();
    if ((body2.total_count || 0) > 0) return true;
  }
  return false;
}

async function triggerWorkflow(workflowFile) {
  const res = await ghApi(`/repos/${OWNER}/${REPO}/actions/workflows/${workflowFile}/dispatches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main' }),
  });
  return res.status === 204;
}

async function main() {
  const report = [];
  for (const feed of WATCHED_FEEDS) {
    const parsed = loadFeedJson(feed.file);
    const fetchedAt = fetchedAtFromFeedJson(parsed);
    const ageMinutes = ageMinutesOf(fetchedAt);
    const stale = isStale(fetchedAt, feed.thresholdMinutes);

    let action = 'ok';
    if (stale) {
      if (DRY_RUN) {
        action = 'would-retrigger';
      } else {
        const active = await hasActiveRun(feed.workflow);
        if (active) {
          action = 'already-running';
        } else {
          const ok = await triggerWorkflow(feed.workflow);
          action = ok ? 'retriggered' : 'retrigger-failed';
        }
      }
    }
    report.push({ file: feed.file, workflow: feed.workflow, ageMinutes, thresholdMinutes: feed.thresholdMinutes, stale, action });
    console.log(`[feed-staleness] ${feed.file.padEnd(32)} age=${String(ageMinutes).padStart(5)}min threshold=${feed.thresholdMinutes}min -> ${action}`);
  }

  const staleCount = report.filter((r) => r.stale).length;
  const retriggeredCount = report.filter((r) => r.action === 'retriggered').length;
  console.log(`[feed-staleness] ${staleCount} stale, ${retriggeredCount} retriggered, ${report.length} total checked`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
