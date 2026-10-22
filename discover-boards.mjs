#!/usr/bin/env node
/**
 * Self-expanding official-board registry — turns aggregator leads
 * (HiringCafe, NextPlay, JobRight) into candidate ATS boards
 * (lib/official-board-registry.mjs, already unit tested) and promotes new,
 * not-yet-tracked candidates into portals.yml's tracked_companies list so
 * the tracked-boards scan starts hitting them directly.
 *
 * Verification stays lightweight here (pattern + presence in a real
 * aggregator feed) — the tracked-boards scan's own dead-board cooldown
 * (lib/scan-cooldown.mjs) is the next real check: a board that turns out to
 * be dead/misdetected gets throttled and eventually drops out on its own.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

import { extractOfficialBoardCandidate, buildOfficialBoardRegistry } from './lib/official-board-registry.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORTALS_PATH = process.env.SCOUTGRID_PORTALS_PATH || `${ROOT}/portals.yml`;
const DATA_DIR = process.env.SCOUTGRID_DATA_DIR || `${ROOT}/data`;
const REGISTRY_PATH = process.env.SCOUTGRID_BOARD_REGISTRY_PATH || `${DATA_DIR}/official-board-registry.json`;
const HEARTBEAT_PATH = process.env.SCOUTGRID_BOARD_HEARTBEAT_PATH || `${DATA_DIR}/scan-board-discovery-heartbeat.json`;

function loadJsonFeed(file, source) {
  const path = `${DATA_DIR}/${file}`;
  if (!existsSync(path)) return { source, fetchedAt: '', jobs: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const jobs = Array.isArray(raw.jobs) ? raw.jobs : (Array.isArray(raw.results) ? raw.results : []);
    return { source, fetchedAt: raw.fetchedAt || '', jobs };
  } catch {
    return { source, fetchedAt: '', jobs: [] };
  }
}

function loadPrevious() {
  if (!existsSync(REGISTRY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function trackedKeysFromPortals(doc) {
  const keys = new Set();
  for (const company of Array.isArray(doc.tracked_companies) ? doc.tracked_companies : []) {
    const candidate = extractOfficialBoardCandidate(company.careers_url);
    if (candidate) keys.add(candidate.key);
  }
  return keys;
}

function titleCaseSlug(slug) {
  return String(slug || '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function boardToTrackedCompanyYaml(board) {
  const bestClaim = (board.companyClaims || [])
    .slice()
    .sort((a, b) => b.length - a.length)[0];
  const name = bestClaim || titleCaseSlug(board.slug);
  const sourceList = (board.sources || []).map((s) => s.source).join(', ') || 'aggregator lead';
  return [
    `  - name: ${JSON.stringify(name)}`,
    `    careers_url: ${board.boardUrl}`,
    `    provider: ${board.ats}`,
    `    enabled: true`,
    `    notes: auto-discovered from ${sourceList}`,
  ].join('\n');
}

/**
 * Insert new tracked_companies YAML blocks right before the next top-level
 * key that follows `tracked_companies:` — portals.yml is NOT a file where
 * tracked_companies is the last key (job_boards: follows it), so appending
 * at EOF would silently attach new entries to the wrong list.
 */
function insertTrackedCompanies(portalsText, blocks) {
  if (!blocks.length) return portalsText;
  const block = `${blocks.join('\n')}\n`;
  const headerMatch = portalsText.match(/^tracked_companies:\s*$/m);
  if (!headerMatch) throw new Error('tracked_companies: key not found in portals.yml');
  const afterHeader = headerMatch.index + headerMatch[0].length;
  const nextKeyMatch = portalsText.slice(afterHeader).match(/\n[A-Za-z_][\w-]*:/);
  const insertAt = nextKeyMatch ? afterHeader + nextKeyMatch.index + 1 : portalsText.length;
  const before = portalsText.slice(0, insertAt);
  const after = portalsText.slice(insertAt);
  const sep = before.endsWith('\n') ? '' : '\n';
  return `${before}${sep}${block}${after}`;
}

function main() {
  const portalsText = readFileSync(PORTALS_PATH, 'utf8');
  const doc = yaml.load(portalsText);
  const trackedKeys = trackedKeysFromPortals(doc);

  const feeds = [
    loadJsonFeed('hiringcafe-feed.json', 'hiringcafe'),
    loadJsonFeed('nextplay-feed.json', 'nextplay'),
    loadJsonFeed('jr-board-fresh.json', 'jobright'),
    loadJsonFeed('wellfound-feed.json', 'wellfound'),
    loadJsonFeed('linkedin-feed.json', 'linkedin'),
  ];
  const totalLeads = feeds.reduce((sum, f) => sum + f.jobs.length, 0);

  const previous = loadPrevious();
  const registry = buildOfficialBoardRegistry({ feeds, previous, trackedKeys, now: new Date().toISOString() });

  const newlyAccepted = [];
  for (const board of registry.boards) {
    if (board.alreadyTracked || board.state === 'rejected') continue;
    // Auto-accept a candidate the moment it's seen in a real aggregator
    // feed — the tracked-boards scan's dead-board cooldown is the next,
    // continuous verification pass, so this does not need to block here.
    board.state = 'accepted';
    newlyAccepted.push(board);
  }

  if (newlyAccepted.length) {
    const blocks = newlyAccepted.map(boardToTrackedCompanyYaml);
    writeFileSync(PORTALS_PATH, insertTrackedCompanies(portalsText, blocks));
  }

  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));

  writeFileSync(HEARTBEAT_PATH, JSON.stringify({
    at: new Date().toISOString(),
    leadsScanned: totalLeads,
    totalBoardsKnown: registry.boardCount,
    alreadyTracked: registry.alreadyTrackedCount,
    newlyPromoted: newlyAccepted.length,
    newBoards: newlyAccepted.map((b) => ({ name: b.companyClaims?.[0] || b.slug, careers_url: b.boardUrl, provider: b.ats })),
  }, null, 2));

  console.log(`[${new Date().toISOString()}] board-discovery: scanned ${totalLeads} leads across ${feeds.length} sources, ${registry.boardCount} known boards, ${registry.alreadyTrackedCount} already tracked, promoted ${newlyAccepted.length} new`);
  for (const board of newlyAccepted) {
    console.log(`  + ${board.ats}: ${board.companyClaims?.[0] || board.slug} -> ${board.boardUrl}`);
  }
}

main();
