/** Classify observed response; never attempt to solve or retry a challenge. */
export function classifyBrowserPage({ status, title = '', html = '', dataPresent = false, dataValid = true, parseError = null }) {
  const evidence = `${title} ${html}`;
  if (/just a moment|cf-chl|challenge-platform|checking your browser/i.test(evidence)) return 'cloudflare_challenge';
  if (status === 403) return 'http_403';
  if (parseError) return 'parser_failure';
  if (!dataPresent || !dataValid) return 'missing_job_data';
  return 'ok';
}
