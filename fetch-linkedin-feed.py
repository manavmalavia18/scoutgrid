#!/usr/bin/env python3
"""LinkedIn lead feed — guest-mode search via python-jobspy (no login, no
browser automation, no personal-account risk; hits LinkedIn's own public
jobs-guest endpoint directly).

Produces LEADS only, in the same {fetchedAt, jobs:[{title,company,url,
location,postedAt}]} shape discover-boards.mjs already consumes from every
other source (hiringcafe/nextplay/jobright/wellfound) — see
lib/official-board-registry.mjs's extractOfficialBoardCandidate(). A posting
whose `url` isn't a recognized ATS host (Greenhouse/Ashby/Lever/Workday) is
silently skipped there, same as it would be from any other feed; nothing from
LinkedIn ever reaches the Jobs UI directly.

Also writes data/linkedin-unresolved-companies.json: every unique company
name seen that did NOT resolve to one of those four ATS hosts. This is the
visibility layer discover-boards.mjs itself doesn't give you — the list of
companies someone (a human, or a future enrichment step) still has to
manually research a real career-board URL for, same bucket a manual LinkedIn
sweep produces.

Usage:
  python3 fetch-linkedin-feed.py
  python3 fetch-linkedin-feed.py --queries "software engineer|backend engineer" --location "United States" --hours 24 --results 25
"""
import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data" / "linkedin-feed.json"
UNRESOLVED_OUT = ROOT / "data" / "linkedin-unresolved-companies.json"
HEARTBEAT = ROOT / "data" / "scan-linkedin-heartbeat.json"

# Mirrors lib/hiringcafe-query.mjs's DEFAULT_HIRINGCAFE_QUERIES — same title
# universe scoutgrid already searches elsewhere, kept short here because
# LinkedIn's guest endpoint throttles the hardest of any board jobspy hits
# (see jobfeed/README.md "Notes on reliability / blocking").
DEFAULT_QUERIES = [
    "software engineer",
    "backend engineer",
    "frontend engineer",
    "full stack engineer",
    "devops engineer",
    "data engineer",
]

# Mirrors lib/official-board-registry.mjs's GH_HOSTS/ASHBY_HOSTS/LEVER_HOSTS
# and the *.myworkdayjobs.com check — a job only "resolves" here if
# discover-boards.mjs would actually recognize its url as a real board.
RESOLVED_HOSTS = {
    "job-boards.greenhouse.io",
    "job-boards.eu.greenhouse.io",
    "boards.greenhouse.io",
    "jobs.ashbyhq.com",
    "jobs.lever.co",
    "jobs.eu.lever.co",
}


def resolves_to_known_ats(url):
    try:
        host = urlparse(str(url or "")).hostname or ""
    except Exception:
        return False
    host = host.lower()
    return host in RESOLVED_HOSTS or host.endswith(".myworkdayjobs.com")


def iso(dt_value):
    if dt_value is None:
        return None
    try:
        # pandas/jobspy may hand back a date, Timestamp, or NaT-ish value.
        if hasattr(dt_value, "isoformat"):
            return dt_value.isoformat()
        return str(dt_value)
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queries", default="|".join(DEFAULT_QUERIES), help="pipe-separated search terms")
    ap.add_argument("--location", default="United States")
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--results", type=int, default=25, help="target results per query")
    ap.add_argument("--sleep", type=float, default=5.0, help="seconds between queries (rate-limit courtesy)")
    args = ap.parse_args()

    queries = [q.strip() for q in args.queries.split("|") if q.strip()]

    try:
        from jobspy import scrape_jobs
    except ImportError as exc:
        print(f"::error::python-jobspy not installed: {exc}", file=sys.stderr)
        sys.exit(1)

    started = time.time()
    all_jobs = []
    errors = []
    for i, query in enumerate(queries):
        if i > 0:
            time.sleep(args.sleep)
        try:
            df = scrape_jobs(
                site_name=["linkedin"],
                search_term=query,
                location=args.location,
                results_wanted=args.results,
                hours_old=args.hours,
                # Costs one extra request PER JOB (jobspy has to load the
                # full detail page, not just the search-results card) to get
                # job_url_direct — the employer's own apply link. Without
                # this, "url" is always a linkedin.com/jobs/view/... page,
                # which can never match RESOLVED_HOSTS below no matter what
                # the posting actually is — confirmed live 2026-10-28:
                # resolvedToKnownAts was 0 on every run since this script
                # existed. --results is kept modest (see linkedin.yml) to
                # offset the added per-job request volume against LinkedIn's
                # already-aggressive guest-endpoint rate limiting.
                fetch_description=True,
            )
        except Exception as exc:  # noqa: BLE001 - one bad query must not kill the whole run
            errors.append(f"{query}: {exc}")
            print(f"[linkedin] query '{query}' failed: {exc}", file=sys.stderr)
            continue
        if df is None or df.empty:
            continue
        for _, row in df.iterrows():
            job_url = str(row.get("job_url") or "").strip()
            job_url_direct = str(row.get("job_url_direct") or "").strip()
            # Prefer the employer's own direct-apply link when jobspy found
            # one AND it's a board discover-boards.mjs actually recognizes —
            # falling back to LinkedIn's own page otherwise (same as before;
            # still a usable lead, just one that needs manual board
            # research rather than auto-verification).
            url = job_url_direct if resolves_to_known_ats(job_url_direct) else job_url
            all_jobs.append({
                "title": str(row.get("title") or "").strip(),
                "company": str(row.get("company") or "").strip(),
                "url": url,
                "location": str(row.get("location") or "").strip(),
                "postedAt": iso(row.get("date_posted")),
            })
        print(f"[linkedin] '{query}': {len(df)} rows", file=sys.stderr)

    # De-dupe on job url.
    seen = set()
    deduped = []
    for job in all_jobs:
        if not job["url"] or job["url"] in seen:
            continue
        seen.add(job["url"])
        deduped.append(job)

    resolved = [j for j in deduped if resolves_to_known_ats(j["url"])]
    unresolved_companies = {}
    for j in deduped:
        if resolves_to_known_ats(j["url"]) or not j["company"]:
            continue
        key = j["company"].strip().lower()
        if key not in unresolved_companies:
            unresolved_companies[key] = {
                "company": j["company"],
                "sampleLinkedInUrl": j["url"],
                "sampleTitle": j["title"],
                "firstSeenAt": datetime.now(timezone.utc).isoformat(),
            }

    now_iso = datetime.now(timezone.utc).isoformat()

    # A throttled/blocked run must NOT silently overwrite yesterday's good
    # feed with zero leads — that would look identical to "nothing new on
    # LinkedIn today" instead of "this run failed", and the CI job would
    # still exit 0. Originally this only triggered on an explicit error or
    # an empty query list, which missed the real failure mode seen live
    # 2026-10-28: all 6 queries completed cleanly (errors == []) but every
    # single one came back with zero rows — a soft block/rate-limit that
    # jobspy doesn't surface as an exception, just an empty result set.
    # Historically every run finds 75+ leads across these 6 broad national
    # queries, so "zero leads, however it happened" is itself the signal —
    # check unconditionally rather than requiring errors to be non-empty.
    if not deduped:
        HEARTBEAT.parent.mkdir(parents=True, exist_ok=True)
        HEARTBEAT.write_text(json.dumps({
            "at": now_iso,
            "queriesRun": len(queries),
            "rawLeads": 0,
            "uniqueLeads": 0,
            "errors": errors,
            "elapsedSec": round(time.time() - started, 1),
            "skippedWrite": True,
            "reason": "zero leads across all queries (soft-block or real failure, no errors required) — preserving last-known-good linkedin-feed.json instead of overwriting",
        }, indent=2))
        print(
            f"::error::linkedin: 0 leads across {len(queries)} quer{'y' if len(queries) == 1 else 'ies'} "
            f"({len(errors)} errored) — leaving existing linkedin-feed.json untouched",
            file=sys.stderr,
        )
        sys.exit(1)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"fetchedAt": now_iso, "jobs": deduped}, indent=2))

    unresolved_list = sorted(unresolved_companies.values(), key=lambda r: r["company"].lower())
    UNRESOLVED_OUT.write_text(json.dumps({"fetchedAt": now_iso, "companies": unresolved_list}, indent=2))

    HEARTBEAT.write_text(json.dumps({
        "at": now_iso,
        "queriesRun": len(queries),
        "rawLeads": len(all_jobs),
        "uniqueLeads": len(deduped),
        "resolvedToKnownAts": len(resolved),
        "unresolvedCompanies": len(unresolved_list),
        "errors": errors,
        "elapsedSec": round(time.time() - started, 1),
    }, indent=2))

    print(
        f"[{now_iso}] linkedin: {len(all_jobs)} raw leads -> {len(deduped)} unique, "
        f"{len(resolved)} resolve to a known ATS host, {len(unresolved_list)} companies need manual board research"
    )


if __name__ == "__main__":
    main()
