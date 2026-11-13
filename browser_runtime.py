"""Reusable browser-runtime interface for Python ATS/aggregator scrapers.

This is the production-side counterpart to `browser-lab/adapter.mjs` (which
stays isolated and JS-only — see that file and the `browser-lab/README.md`).
`scrape-hiringcafe.py` is the only current caller; it talks to a
`BrowserSession` through this interface instead of calling `patchright`
directly, so browser initialization, page navigation, and cleanup are all
behind one contract.

Only `patchright` is registered here and used by the live HiringCafe
scanner. Adding a new engine means implementing `BrowserRuntime`/
`BrowserSession` below and adding one line to `RUNTIME_REGISTRY` — the
scraping/parsing/pagination logic in `scrape-hiringcafe.py` never changes.

`cloakbrowser` is intentionally NOT registered here. Its implementation
lives only in `browser-lab/adapter.mjs` against loopback fixtures, per the
project's standing rule against anti-detection/fingerprint-spoofing tooling
against any real, challenged target (see the `scoutgrid` skill). Requesting
engine "cloakbrowser" from this module raises `UnknownBrowserEngine` with a
message pointing at that boundary, not a working browser.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Optional


class BrowserInitError(RuntimeError):
    """Raised when launching the browser/context itself fails."""


class NavigationError(RuntimeError):
    """Raised when a page navigation fails for a reason unrelated to the
    site's own content (network error, crashed page, etc.) — distinct from
    the content-based diagnostics (`cloudflare_challenge`, `http_403`,
    `missing_job_data`) which are raised by `scrape-hiringcafe.py` itself
    after inspecting a successfully-loaded page."""


class CleanupError(RuntimeError):
    """Raised by `BrowserSession.close()` on failure. Callers should log
    this, never let it mask an earlier, more important exception from the
    scrape itself (see `scrape-hiringcafe.py`'s use of this)."""


class UnknownBrowserEngine(RuntimeError):
    """Raised by `get_runtime()` for any engine name not in
    `RUNTIME_REGISTRY` — including recognized-but-not-production-ready
    names like "cloakbrowser", which gets a specific, honest message
    instead of a generic KeyError."""


class BrowserSession(ABC):
    """One open browser page/context, independent of which engine backs it."""

    @abstractmethod
    def goto(self, url: str, timeout_ms: int) -> Optional[int]:
        """Navigate to `url`; return the HTTP status code if known, else
        None. Must raise `NavigationError` on a transport-level failure
        (timeout, DNS, crashed target) — NOT on a non-2xx status, which is
        content for the caller's own diagnostics to interpret."""

    @abstractmethod
    def content(self) -> str:
        """Current page HTML."""

    @abstractmethod
    def title(self) -> str:
        """Current page title."""

    @abstractmethod
    def wait_for_selector(self, selector: str, timeout_ms: int) -> None:
        """Block until `selector` is attached to the DOM. Implementations
        should let the underlying engine's own timeout exception propagate
        unchanged (callers match on it, e.g. patchright's
        `TimeoutError`) rather than wrapping it — `scrape-hiringcafe.py`
        treats that case as its own diagnostic, not a NavigationError."""

    def minimize_window(self) -> None:
        """Best-effort, non-fatal. Default no-op; engines that support it
        (patchright, via CDP) may override. Must never raise — a failure to
        minimize the headed window is cosmetic, not a scrape failure."""

    def last_response_headers(self) -> dict[str, str]:
        """Headers from the most recent `goto()`'s response, lowercase
        keys, best-effort. Default empty for engines that don't expose
        them; callers must not assume any particular header is present.
        Never includes cookies — only the underlying engine's raw header
        set, which calling code is responsible for sanitizing down to an
        allowlist before persisting anywhere (see the JS counterpart in
        lib/hc-blocked-diagnostics.mjs)."""
        return {}

    @abstractmethod
    def close(self) -> None:
        """Release the browser/context. Must raise `CleanupError` (not the
        underlying engine's own exception type) on failure, so callers can
        catch exactly one type regardless of engine."""


class BrowserRuntime(ABC):
    """Factory for `BrowserSession`s of one engine."""

    name: str = "unset"

    @abstractmethod
    def open(self, profile_dir: Path) -> BrowserSession:
        """Launch the browser/context rooted at `profile_dir` and return an
        open `BrowserSession`. Must raise `BrowserInitError` (not the
        underlying engine's own exception type) on failure."""


class PatchrightRuntime(BrowserRuntime):
    """Headed Chrome via `patchright` — the only runtime the live HiringCafe
    scanner actually launches. Persistent-context + headed-then-minimized
    behavior matches the pre-refactor inline implementation exactly."""

    name = "patchright"

    def open(self, profile_dir: Path) -> "PatchrightSession":
        try:
            from patchright.sync_api import sync_playwright
        except Exception as err:  # pragma: no cover - import failure path
            raise BrowserInitError(f"patchright import failed: {err}") from err

        profile_dir.mkdir(parents=True, exist_ok=True)
        playwright_cm = None
        try:
            playwright_cm = sync_playwright()
            playwright = playwright_cm.__enter__()
            ctx = playwright.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                channel="chrome",
                headless=False,
                no_viewport=True,
                args=[
                    "--window-position=-32000,-32000",
                    "--window-size=800,600",
                ],
            )
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
        except Exception as err:
            if playwright_cm is not None:
                try:
                    playwright_cm.__exit__(None, None, None)
                except Exception:
                    pass
            raise BrowserInitError(f"patchright launch failed: {err}") from err
        return PatchrightSession(playwright_cm=playwright_cm, ctx=ctx, page=page)


class PatchrightSession(BrowserSession):
    def __init__(self, playwright_cm: Any, ctx: Any, page: Any):
        self._playwright_cm = playwright_cm
        self._ctx = ctx
        self._page = page
        self._last_response: Any = None

    def goto(self, url: str, timeout_ms: int) -> Optional[int]:
        try:
            response = self._page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        except Exception as err:
            # Only transport-level failures land here — a page.goto() that
            # successfully loads a non-2xx response (e.g. Cloudflare's 403
            # interstitial) returns a Response object, it doesn't raise.
            raise NavigationError(f"navigation failed for {url}: {err}") from err
        self._last_response = response
        return response.status if response else None

    def content(self) -> str:
        return self._page.content()

    def title(self) -> str:
        return self._page.title()

    def wait_for_selector(self, selector: str, timeout_ms: int) -> None:
        self._page.wait_for_selector(selector, state="attached", timeout=timeout_ms)

    def last_response_headers(self) -> dict[str, str]:
        if self._last_response is None:
            return {}
        try:
            return {str(k).lower(): str(v) for k, v in dict(self._last_response.headers).items()}
        except Exception:
            return {}

    def minimize_window(self) -> None:
        try:
            cdp = self._page.context.new_cdp_session(self._page)
            info = cdp.send("Browser.getWindowForTarget")
            cdp.send(
                "Browser.setWindowBounds",
                {"windowId": info["windowId"], "bounds": {"windowState": "minimized"}},
            )
        except Exception:
            pass

    def close(self) -> None:
        errors = []
        try:
            self._ctx.close()
        except Exception as err:
            errors.append(str(err))
        try:
            self._playwright_cm.__exit__(None, None, None)
        except Exception as err:
            errors.append(str(err))
        if errors:
            raise CleanupError(f"patchright cleanup failed: {'; '.join(errors)}")


RUNTIME_REGISTRY: dict[str, type[BrowserRuntime]] = {
    "patchright": PatchrightRuntime,
}

# Recognized but deliberately unregistered — see module docstring.
_KNOWN_UNREGISTERED = {
    "cloakbrowser": (
        "cloakbrowser is intentionally not registered for production use. "
        "Its implementation is isolated to browser-lab/adapter.mjs against "
        "loopback fixtures; see the scoutgrid skill's standing rule against "
        "anti-detection tooling against real, challenged targets."
    ),
}


def get_runtime(name: str) -> BrowserRuntime:
    """Return a fresh `BrowserRuntime` for `name`. Raises
    `UnknownBrowserEngine` for anything not in `RUNTIME_REGISTRY`, with a
    specific message for recognized-but-unregistered names."""
    key = (name or "").strip().lower()
    cls = RUNTIME_REGISTRY.get(key)
    if cls is not None:
        return cls()
    if key in _KNOWN_UNREGISTERED:
        raise UnknownBrowserEngine(_KNOWN_UNREGISTERED[key])
    available = ", ".join(sorted(RUNTIME_REGISTRY)) or "(none)"
    raise UnknownBrowserEngine(f"Unknown browser engine {name!r}; available: {available}")
