#!/usr/bin/env node
/**
 * For companies LinkedIn names but whose own job url never resolves to a
 * known ATS board (data/linkedin-unresolved-companies.json, written by
 * fetch-linkedin-feed.py — previously a dead-end file nobody read), try a
 * small set of mechanically-derived slug candidates against Greenhouse/
 * Ashby/Lever's real public APIs. See lib/company-board-probe.mjs for the
 * full rationale and the pure, unit-tested logic; this file is just I/O
 * orchestration (live fetches, rate limiting, file writes).
 *
 *   node probe-company-boards.mjs
 *   node probe-company-boards.mjs --limit 10
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import {
  slugCandidates, companyKeyOf, shouldProbe, jobCountFromAtsBody,
  atsCandidateUrls, boardToTrackedCompanyYaml, insertTrackedCompanies,
} from './lib/company-board-probe.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = process.env.SCOUTGRID_PORTALS_PATH || `${ROOT}/portals.yml`;
const DATA_DIR = process.env.SCOUTGRID_DATA_DIR || `${ROOT}/data`;
const UNRESOLVED_PATH = process.env.SCOUTGRID_UNRESOLVED_PATH || `${DATA_DIR}/linkedin-unresolved-companies.json`;
const STATE_PATH = process.env.SCOUTGRID_PROBE_STATE_PATH || `${DATA_DIR}/company-board-probe-state.json`;
const HEARTBEAT_PATH = process.env.SCOUTGRID_PROBE_HEARTBEAT_PATH || `${DATA_DIR}/scan-board-probe-heartbeat.json`;

function argNum(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]) || fallback;
  return fallback;
}
const BATCH_LIMIT = argNum('--limit', 25);
const PROBE_DELAY_MS = 350; // courtesy delay between live ATS API requests

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function loadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

async function probeOneSlug(slug) {
  for (const candidate of atsCandidateUrls(slug)) {
    try {
      const res = await fetch(candidate.apiUrl, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        const jobCount = jobCountFromAtsBody(body);
        if (jobCount > 0) return { ...candidate, slug, jobCount };
      }
    } catch {
      // one bad candidate (network hiccup, non-JSON response) must not
      // kill the whole probe run
    }
    await sleep(PROBE_DELAY_MS);
  }
  return null;
}

async function main() {
  const portalsText = readFileSync(PORTALS_PATH, 'utf8');
  const doc = yaml.load(portalsText) || {};
  const trackedNames = new Set(
    (Array.isArray(doc.tracked_companies) ? doc.tracked_companies : []).map((c) => companyKeyOf(c.name)),
  );

  const unresolved = loadJson(UNRESOLVED_PATH, { companies: [] });
  const state = loadJson(STATE_PATH, {});
  const now = Date.now();

  const candidates = (unresolved.companies || [])
    .filter((c) => shouldProbe(c.company, { trackedNames, state, now }))
    .slice(0, BATCH_LIMIT);

  let resolved = 0;
  let exhausted = 0;
  const newBlocks = [];

  for (const c of candidates) {
    const key = companyKeyOf(c.company);
    let match = null;
    for (const slug of slugCandidates(c.company)) {
      match = await probeOneSlug(slug);
      if (match) break;
    }
    const probedAt = new Date(now).toISOString();
    if (match) {
      newBlocks.push(boardToTrackedCompanyYaml(c.company, match));
      state[key] = { status: 'resolved', ats: match.ats, slug: match.slug, probedAt };
      resolved += 1;
      console.log(`[company-board-probe] resolved: ${c.company} -> ${match.ats}:${match.slug} (${match.jobCount} jobs)`);
    } else {
      state[key] = { status: 'exhausted', probedAt };
      exhausted += 1;
    }
  }

  if (newBlocks.length) {
    writeFileSync(PORTALS_PATH, insertTrackedCompanies(portalsText, newBlocks));
  }
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  writeFileSync(HEARTBEAT_PATH, JSON.stringify({
    at: new Date(now).toISOString(),
    candidatesConsidered: candidates.length,
    resolved,
    exhausted,
  }, null, 2));

  console.log(`[${new Date(now).toISOString()}] company-board-probe: ${candidates.length} candidates -> ${resolved} resolved, ${exhausted} exhausted`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
