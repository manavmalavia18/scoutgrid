# Browser runtime lab (isolated)

This is a **manual, loopback-only comparison** of ordinary Playwright Chromium and CloakBrowser. It is not imported by any production scraper, has no Tailscale exit-node route, and makes no requests to HiringCafe or other third-party job sites. CloakBrowser's own binary has source-level fingerprint changes; this lab does not implement CAPTCHA solving, cookie transfer, proxies, or challenge handling.

## Run

1. Obtain a CloakBrowser license through the vendor's official process. Add it **directly in GitHub** at the Scoutgrid repository's Settings → Secrets and variables → Actions → New repository secret. Name it `CLOAKBROWSER_LICENSE_KEY`. Do not paste the key into a chat, commit, issue, or workflow input.
2. Dispatch the **Browser runtime lab (local fixture only)** workflow manually. `CLOAKBROWSER_LICENSE_KEY` is read from repository secrets only in the license-detection and CloakBrowser steps. Ordinary Playwright runs without that secret.
3. Review the two smoke-step logs. Each prints the response status, DOM classification, parsed fixture-job count, browser-startup time (`startupMs`), navigation time (`navigationMs`), DOM parse time (`domParseMs`), and process `exit_code`. The GitHub job summary states each runtime's outcome. Both visit the identical page served at a randomized `127.0.0.1` port by `browser-lab/smoke.mjs`.
4. Without the secret, the CloakBrowser step and its measurements are **SKIPPED**, not passed. The job summary and log say so explicitly. A successful Playwright step cannot validate CloakBrowser.

Local ordinary-browser check after `npm ci --prefix browser-lab --ignore-scripts`: `browser-lab/node_modules/.bin/playwright-core install chromium`, then `BROWSER_LAB_RUNTIME=playwright node browser-lab/smoke.mjs`. For a licensed local-only comparison, install the vendor's binary with `browser-lab/node_modules/.bin/cloakbrowser install` and run the same smoke script with `BROWSER_LAB_RUNTIME=cloakbrowser`; supply the key via your own environment or vendor's secure login flow, not as a command-line argument.

## If a future target permits the intended automation

Obtain and document the target's permission/access terms first. Run a separate approved-site test, compare reliability and job-data integrity, and review the vendor binary/dependency and license implications. Only then propose a **separate, reviewed change** that explicitly selects a runtime for that permitted target. The present adapter has no production import or `BROWSER_LAB_RUNTIME` wiring in `scrape-hiringcafe.py`, `fetch-hiringcafe-feed.mjs`, or their workflows. Browser compatibility on loopback does not imply HiringCafe accessibility or authorize its search-path crawling.
