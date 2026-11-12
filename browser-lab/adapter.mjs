/** Browser-only lab adapter. Never imported by production scrapers. */
export async function launchBrowser({
  runtime = process.env.BROWSER_LAB_RUNTIME || 'playwright',
  licenseKey = process.env.CLOAKBROWSER_LICENSE_KEY || '',
  playwrightCore,
  cloakBrowser,
} = {}) {
  if (!['playwright', 'cloakbrowser'].includes(runtime)) {
    throw new Error(`Unsupported browser runtime: ${runtime}`);
  }
  if (runtime === 'cloakbrowser' && !licenseKey) {
    throw new Error('CLOAKBROWSER_LICENSE_KEY is required for the isolated browser lab');
  }
  const { chromium } = playwrightCore || await import('playwright-core');
  if (runtime === 'playwright') return chromium.launch({ headless: true });
  const { buildLaunchOptions } = cloakBrowser || await import('cloakbrowser');
  // Keep the complete vendor-provided options. Do not add evasion flags,
  // humanization, proxies, cookies, or a production scraper integration.
  const options = await buildLaunchOptions({ headless: true, licenseKey });
  return chromium.launch(options);
}
