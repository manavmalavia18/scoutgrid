#!/usr/bin/env python3
"""Scrape Hiring Cafe SSR search via patchright (headed Chrome).

Cloudflare blocks node fetch and Playwright headless after ~1 page.
Patchright headed paginates the same __NEXT_DATA__ the HTTP path used to read.

  .venv-scrapling/bin/python scripts/scrape-hiringcafe.py --pages 50 --days 2 --out data/hc-hits.tmp.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
from pathlib import Path

from browser_runtime import (
    BrowserInitError,
    CleanupError,
    NavigationError,
    UnknownBrowserEngine,
    get_runtime,
)

ROOT = Path(__file__).resolve().parent
DEFAULT_PROFILE = ROOT / "data" / "hiringcafe-profile"
DEFAULT_OUT = ROOT / "data" / "hc-hits.tmp.json"
ORIGIN = "https://hiringcafe.com"
DEFAULT_ENGINE = "patchright"

# Navigation (page.goto) and job-data-selector (#__NEXT_DATA__) timeouts.
# Configurable via HC_NAV_TIMEOUT_MS/HC_SELECTOR_TIMEOUT_MS (or --nav-timeout-ms/
# --selector-timeout-ms) for ops tuning, but the defaults below are the exact
# pre-existing hardcoded values — nothing about default behavior changes.
#
# Evidence on the 45s selector default (investigated before touching it, per
# the "do not shorten without evidence" instruction): walking every historical
# data/scan-hc-heartbeat.json commit, the healthiest fully-successful real-
# browser run on record (2026-11-02T18:33:26Z, queriesSkipped=0, all 16
# queries ok) fetched 18 pages across 16 queries in 99s total — roughly 5.5s
# per page. That's the only clean (zero-failed-query) patchright sample in
# the last 353 heartbeat commits; every other low-skip sample is in the
# hundreds of seconds for the full multi-query cycle, consistent with ~5-10s
# legitimate per-page hydration plus network/queue variance, not anywhere
# close to 45s. This means the 45s default has roughly an order of magnitude
# of headroom over observed legitimate hydration time — but GitHub's shared
# runners can have materially more network/CPU variance than this one data
# point, and HC's own Cloudflare-challenge behavior (see hc.yml) has been
# actively hostile recently, so the default stays at 45_000 rather than being
# tightened on a single historical sample. An operator with stronger evidence
# can lower it via HC_SELECTOR_TIMEOUT_MS without a code change.
DEFAULT_NAV_TIMEOUT_MS = 60_000
DEFAULT_SELECTOR_TIMEOUT_MS = 45_000
# Keep both inside a sane range: too low risks false navigation_error/
# missing_job_data on legitimate slow pages; too high risks exceeding
# fetch-hiringcafe-feed.mjs's own 60s outer spawnSync timeout per query (see
# its comment next to `timeout: 60_000`), which would kill the whole python
# subprocess with no diagnostic from this module at all.
MIN_TIMEOUT_MS = 1_000
MAX_TIMEOUT_MS = 180_000

NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>',
    re.S,
)


def _resolve_timeout_ms(explicit: int | None, env_name: str, default: int) -> int:
    """Resolve a timeout: an explicit argument wins (used by direct callers/
    tests), else HC_NAV_TIMEOUT_MS/HC_SELECTOR_TIMEOUT_MS from the
    environment, else `default`. Always clamped to [MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS] so a malformed/extreme env value can't produce a timeout
    of 0 or an effectively-infinite wait."""
    if explicit is not None:
        value = explicit
    else:
        raw = os.environ.get(env_name)
        if raw is None or not raw.strip():
            value = default
        else:
            try:
                value = int(raw)
            except ValueError:
                value = default
    return max(MIN_TIMEOUT_MS, min(MAX_TIMEOUT_MS, value))


_PROFILE_LOCK_MARKERS = (
    "already in use",
    "existing browser session",
    "singletonlock",
    "profile appears to be in use",
)


def _looks_like_profile_lock(message: str) -> bool:
    """True when a BrowserInitError's text matches the real patchright/Chrome
    wording for 'another instance already has this user_data_dir open' —
    confirmed against the actual message a live lock produces (see
    test/hc-real-browser-smoke.test.mjs's profile-lock test)."""
    lowered = (message or "").lower()
    return any(marker in lowered for marker in _PROFILE_LOCK_MARKERS)


def search_state(query: str, days: int) -> dict:
    return {
        "locations": [{
            "formatted_address": "United States",
            "types": ["country"],
            "geometry": {"location": {"lat": 33.7485, "lon": -84.3871}},
            "id": "user_country",
            "address_components": [{
                "long_name": "United States",
                "short_name": "US",
                "types": ["country"],
            }],
            "options": {
                "flexible_regions": ["anywhere_in_continent", "anywhere_in_world"],
            },
        }],
        "searchQuery": query,
        "dateFetchedPastNDays": days,
        "hideJobTypes": ["Applied"],
        "departments": ["Software Development", "Engineering", "Information Technology"],
        "roleTypes": ["Individual Contributor"],
        "seniorityLevel": ["Entry Level", "Mid Level", "No Prior Experience Required"],
        "securityClearances": ["None"],
        "sortBy": "date",
    }


def url_for(state: dict, page: int) -> str:
    qs = {"searchState": json.dumps(state, separators=(",", ":"))}
    if page > 0:
        qs["page"] = str(page)
    return ORIGIN + "/?" + urllib.parse.urlencode(qs)


def diagnose_page(status: int | None, title: str, html: str) -> str:
    """Report the observed failure; never attempt to handle a challenge."""
    evidence = f"{title} {html}"
    if re.search(r"just a moment|cf-chl|challenge-platform|checking your browser", evidence, re.I):
        return "cloudflare_challenge"
    if status == 403:
        return "http_403"
    if not NEXT_DATA_RE.search(html or ""):
        return "missing_job_data"
    return "ok"


def props_from_html(html: str):
    m = NEXT_DATA_RE.search(html or "")
    if not m:
        raise RuntimeError("missing_job_data: __NEXT_DATA__ absent")
    try:
        page_props = json.loads(m.group(1))["props"]["pageProps"]
        if not isinstance(page_props, dict):
            raise ValueError("pageProps is not an object")
        return page_props
    except (ValueError, TypeError, KeyError) as err:
        raise RuntimeError(f"parser_failure: invalid __NEXT_DATA__ ({err})") from err


def scrape(
    pages: int,
    days: int,
    query: str,
    sleep_s: float,
    profile: Path,
    engine: str = DEFAULT_ENGINE,
    nav_timeout_ms: int | None = None,
    selector_timeout_ms: int | None = None,
) -> dict:
    """Pagination/dedup/parsing logic is unchanged from the pre-refactor
    inline-patchright version. The only change is that browser init,
    navigation, and cleanup now go through `browser_runtime.BrowserSession`
    instead of calling `patchright` directly, so a future authorized engine
    only needs a new `BrowserRuntime` implementation, not a scrape rewrite.

    `nav_timeout_ms`/`selector_timeout_ms` override HC_NAV_TIMEOUT_MS/
    HC_SELECTOR_TIMEOUT_MS (which in turn override the 60s/45s defaults) —
    pass them explicitly for a direct/test call, or leave None to resolve
    from the environment the way `main()` does."""
    nav_timeout_ms = _resolve_timeout_ms(nav_timeout_ms, "HC_NAV_TIMEOUT_MS", DEFAULT_NAV_TIMEOUT_MS)
    selector_timeout_ms = _resolve_timeout_ms(selector_timeout_ms, "HC_SELECTOR_TIMEOUT_MS", DEFAULT_SELECTOR_TIMEOUT_MS)

    try:
        runtime = get_runtime(engine)
    except UnknownBrowserEngine as err:
        raise RuntimeError(f"browser_engine_unavailable: {err}") from err

    state = search_state(query, days)
    hits: list = []
    seen: set[str] = set()
    total = None
    pages_fetched = 0
    truncated = False

    try:
        session = runtime.open(profile)
    except BrowserInitError as err:
        if _looks_like_profile_lock(str(err)):
            raise RuntimeError(
                f"browser_profile_locked: {profile} is already in use by another "
                f"browser instance — concurrent HC workers must each use a distinct "
                f"--profile/HC_PROFILE directory, not share one: {err}"
            ) from err
        raise RuntimeError(f"browser_init_failed: {err}") from err

    try:
        for i in range(pages):
            t0 = time.time()
            try:
                status = session.goto(url_for(state, i), timeout_ms=nav_timeout_ms)
            except NavigationError as err:
                raise RuntimeError(f"navigation_error: {err} on page {i}") from err
            if i == 0:
                session.minimize_window()
            immediate = diagnose_page(status, session.title(), session.content())
            if immediate in ("cloudflare_challenge", "http_403"):
                raise RuntimeError(f"{immediate}: HTTP {status} on page {i}")
            try:
                session.wait_for_selector("#__NEXT_DATA__", timeout_ms=selector_timeout_ms)
            except NavigationError as err:
                raise RuntimeError(f"navigation_error: {err} on page {i}") from err
            except Exception as err:
                # The underlying engine's own timeout type (e.g. patchright's
                # TimeoutError) propagates unchanged — see
                # BrowserSession.wait_for_selector's contract — and is
                # treated the same way the inline version always did: as
                # its own content-based diagnostic, not a navigation error.
                observed = diagnose_page(status, session.title(), session.content())
                raise RuntimeError(f"{observed}: HTTP {status} on page {i}") from err
            pp = props_from_html(session.content())
            if total is None:
                raw_total = pp.get("ssrTotalCount")
                if isinstance(raw_total, (int, float)) and raw_total == raw_total:
                    total = int(raw_total)
            batch = pp.get("ssrHits") or []
            added = 0
            for h in batch:
                if not isinstance(h, dict) or h.get("is_expired"):
                    continue
                url = (h.get("apply_url") or "").strip().lower()
                if not url or url in seen:
                    continue
                seen.add(url)
                hits.append(h)
                added += 1
            pages_fetched = i + 1
            print(
                f"HC [{query}] page {pages_fetched}/{pages} "
                f"hits={len(batch)} new={added} kept={len(seen)}"
                + (f"/{total}" if total is not None else "")
                + f" {int((time.time() - t0) * 1000)}ms",
                file=sys.stderr,
                flush=True,
            )
            is_last = (
                len(batch) == 0
                or added == 0
                or (total is not None and len(seen) >= total)
            )
            if is_last:
                truncated = False
                break
            if i + 1 >= pages:
                truncated = True
                break
            time.sleep(sleep_s)
        else:
            truncated = total is None or len(seen) < total
    finally:
        try:
            session.close()
        except CleanupError as err:
            # Never let a cleanup failure mask whatever happened above (a
            # real scrape error, or nothing at all) — just surface it.
            print(f"HC [{query}] browser cleanup failed: {err}", file=sys.stderr, flush=True)

    return {
        "ok": True,
        "query": query,
        "days": days,
        "engine": engine,
        "navTimeoutMs": nav_timeout_ms,
        "selectorTimeoutMs": selector_timeout_ms,
        "pagesFetched": pages_fetched,
        "truncated": truncated,
        "totalCount": total,
        "count": len(hits),
        "hits": hits,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=int, default=50)
    ap.add_argument("--days", type=int, default=2)
    ap.add_argument("--query", default="software engineer")
    ap.add_argument("--sleep", type=float, default=1.5)
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--profile", default=str(DEFAULT_PROFILE))
    # BROWSER_ENGINE/--engine selects which registered BrowserRuntime to use.
    # Only "patchright" is registered for this production scanner — see
    # browser_runtime.py's module docstring for why "cloakbrowser" stays
    # out of this list.
    ap.add_argument("--engine", default=os.environ.get("BROWSER_ENGINE", DEFAULT_ENGINE))
    # No default here (None) — scrape() resolves HC_NAV_TIMEOUT_MS/
    # HC_SELECTOR_TIMEOUT_MS itself when the CLI doesn't pass one, so there's
    # exactly one place (`_resolve_timeout_ms`) that implements the
    # env-overrides-default / explicit-overrides-env precedence.
    ap.add_argument("--nav-timeout-ms", type=int, default=None)
    ap.add_argument("--selector-timeout-ms", type=int, default=None)
    args = ap.parse_args()
    pages = max(1, min(80, args.pages))
    days = max(1, min(7, args.days))
    try:
        payload = scrape(
            pages, days, args.query, max(0.4, args.sleep), Path(args.profile),
            engine=args.engine,
            nav_timeout_ms=args.nav_timeout_ms,
            selector_timeout_ms=args.selector_timeout_ms,
        )
    except Exception as err:
        print(f"HC scrape failed: {err}", file=sys.stderr)
        return 1
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "count": payload["count"],
        "pagesFetched": payload["pagesFetched"],
        "truncated": payload["truncated"],
        "totalCount": payload["totalCount"],
        "engine": payload["engine"],
        "navTimeoutMs": payload["navTimeoutMs"],
        "selectorTimeoutMs": payload["selectorTimeoutMs"],
        "out": str(out),
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
