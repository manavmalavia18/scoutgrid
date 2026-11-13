#!/usr/bin/env node
// Prints the Data track's live HC_QUERIES (pipe-joined), computed as
// DEFAULT_DATA_QUERIES minus whatever queries are provably equivalent to
// (and therefore reused from) the Software track's own list. Single
// source of truth shared with hc-data.yml's intent — if the default query
// lists change later, this always reflects the CURRENT correct reduction
// rather than a hand-maintained duplicate string going stale.
import { DEFAULT_DATA_QUERIES } from '../lib/data-query.mjs';
import { DEFAULT_HIRINGCAFE_QUERIES } from '../lib/hiringcafe-query.mjs';
import { findSharedQueries } from '../lib/hc-reuse-feed.mjs';

const shared = new Set(findSharedQueries(DEFAULT_DATA_QUERIES, DEFAULT_HIRINGCAFE_QUERIES).map((q) => q.toLowerCase()));
const reduced = DEFAULT_DATA_QUERIES.filter((q) => !shared.has(q.toLowerCase()));
process.stdout.write(reduced.join('|'));
