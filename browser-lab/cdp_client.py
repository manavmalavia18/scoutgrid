"""Generic Node-to-Python CDP interop experiment — Python side.

Connects Python's own `playwright` package (deliberately NOT `patchright` —
this is a protocol-compatibility experiment, independent of the production
scraper's `browser_runtime.py`/`PatchrightRuntime`) to a CloakBrowser
instance already launched and owned by `browser-lab/cdp-bridge.mjs`, over a
loopback-only Chrome DevTools Protocol endpoint.

This module never launches, installs, or owns a browser process itself —
only `cdp-bridge.mjs` does that. `probe()` connects, drives one page against
a test fixture, and disconnects; it never kills the remote browser (that is
Playwright's own documented `connect_over_cdp()` semantics: closing a
CDP-attached `Browser` handle disconnects the client, it does not terminate
a process Playwright did not launch).

Never used against hiringcafe.com or any other real target — callers must
only ever pass a local fixture URL (see test/fixtures/hc_local_server.py).
"""

from __future__ import annotations

import json
import re

NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>',
    re.S,
)


class CdpClientError(RuntimeError):
    """Raised for both a failed connect_over_cdp() and any failure while
    driving the page through it — scrape-hiringcafe.py style callers
    outside this experiment are not expected; this is a plain, single
    error type for an isolated interop test."""


def probe(cdp_url: str, fixture_url: str, *, playwright_module=None) -> dict:
    """Connect over CDP, navigate `fixture_url`, wait for #__NEXT_DATA__,
    read the title/content, extract its ssrHits, then disconnect. Returns a
    plain JSON-serializable dict; never raises for a successful probe."""
    from playwright.sync_api import sync_playwright as _default_sync_playwright

    sync_playwright = playwright_module or _default_sync_playwright

    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(cdp_url)
        except Exception as err:
            raise CdpClientError(f"connect_over_cdp failed: {err}") from err

        try:
            ctx = browser.contexts[0] if browser.contexts else browser.new_context()
            page = ctx.new_page()
            try:
                try:
                    response = page.goto(fixture_url, wait_until="domcontentloaded", timeout=15_000)
                except Exception as err:
                    raise CdpClientError(f"navigation failed: {err}") from err
                status = response.status if response else None
                try:
                    page.wait_for_selector("#__NEXT_DATA__", state="attached", timeout=10_000)
                except Exception as err:
                    raise CdpClientError(f"wait_for_selector failed: {err}") from err
                title = page.title()
                html = page.content()
                m = NEXT_DATA_RE.search(html)
                hit_count = None
                if m:
                    try:
                        parsed = json.loads(m.group(1))
                        hit_count = len(parsed["props"]["pageProps"]["ssrHits"])
                    except Exception as err:
                        raise CdpClientError(f"__NEXT_DATA__ parse failed: {err}") from err
                return {
                    "ok": True,
                    "status": status,
                    "title": title,
                    "hitCount": hit_count,
                }
            finally:
                page.close()
        finally:
            # Disconnects the CDP client only — does not kill the browser
            # process. cdp-bridge.mjs (Node) owns that lifecycle.
            browser.close()


def is_browser_reachable(cdp_url: str, *, playwright_module=None, timeout_ms: int = 2_000) -> bool:
    """Best-effort check that something is answering CDP at `cdp_url`,
    without driving any page — used to confirm a browser is still alive
    (or confirm it has genuinely gone away after Node's own shutdown)."""
    from playwright.sync_api import sync_playwright as _default_sync_playwright

    sync_playwright = playwright_module or _default_sync_playwright
    try:
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(cdp_url, timeout=timeout_ms)
            browser.close()
            return True
    except Exception:
        return False
