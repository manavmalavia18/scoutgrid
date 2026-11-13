#!/usr/bin/env python3
"""Loopback-only HTTP fixture for the real-browser Patchright smoke test.

Serves a page with the exact __NEXT_DATA__ shape scrape-hiringcafe.py's
props_from_html()/diagnose_page() expect, at / (page 0) and /?page=1 (last
page). Never touches hiringcafe.com or any production feed/scan-history
file — this is the ONLY target the smoke test is allowed to navigate to.
"""
from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PAGE0_HITS = [
    {"apply_url": "https://fixture.test/jobs/1", "is_expired": False, "title": "Fixture Engineer"},
    {"apply_url": "https://fixture.test/jobs/2", "is_expired": False, "title": "Fixture Data Engineer"},
]

# A synthetic "Just a moment..." managed-challenge page, with a Cloudflare-
# like Server/CF-RAY header AND a deliberately leaked Set-Cookie header —
# used to prove, against a REAL browser session (not mocked), that the
# diagnostic capture both classifies this correctly AND never lets the
# cookie through sanitization.
_CHALLENGE_BODY = (
    "<!doctype html><html><head><title>Just a moment...</title></head>"
    "<body>Checking your browser before accessing hiringcafe.test.</body></html>"
).encode()


def _page(hits, total, is_last):
    props = {"props": {"pageProps": {"ssrHits": hits, "ssrTotalCount": total, "ssrIsLastPage": is_last}}}
    return (
        "<!doctype html><html><head><title>Fixture Jobs</title></head><body>"
        f'<script id="__NEXT_DATA__">{json.dumps(props)}</script>'
        "</body></html>"
    )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # quiet
        pass

    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        page = int(q.get("page", ["0"])[0])
        if self.path.startswith("/slow"):
            # For interrupted-navigation tests: never respond at all, so a
            # caller's own goto timeout (session-level, or scrape()'s fixed
            # 60s) is what ends the wait, not this fixture answering late.
            threading.Event().wait()
            return
        elif self.path.startswith("/no-next-data"):
            body = b"<html><body>no job data here</body></html>"
        elif self.path.startswith("/blocked"):
            # send_response_only (not send_response) so BaseHTTPRequestHandler
            # doesn't inject its own default Server/Date headers ahead of
            # the Cloudflare-like ones below — a real Cloudflare edge sends
            # exactly one Server header, not two concatenated values.
            self.send_response_only(403)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(_CHALLENGE_BODY)))
            self.send_header("Server", "cloudflare")
            self.send_header("CF-RAY", "8a1b2c3d4e5f6789-SJC")
            # Deliberately leaked, to prove the diagnostic pipeline strips
            # it before anything is persisted — must never survive capture.
            self.send_header("Set-Cookie", "__cf_bm=leaked-challenge-token; Path=/; HttpOnly")
            self.end_headers()
            self.wfile.write(_CHALLENGE_BODY)
            return
        elif page == 0:
            body = _page(PAGE0_HITS, 2, False).encode()
        else:
            body = _page([], 2, True).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
