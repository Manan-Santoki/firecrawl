/**
 * Minimal built-in ad/tracker host list used when BLOCK_ADS is enabled. It is
 * intentionally small (high-volume ad and analytics hosts only) so that page
 * functionality is not affected; operators needing full filter-list blocking
 * should front the service with a filtering proxy.
 */
const AD_HOST_SUFFIXES = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "google-analytics.com",
  "googletagservices.com",
  "adservice.google.com",
  "amazon-adsystem.com",
  "adnxs.com",
  "adsrvr.org",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "scorecardresearch.com",
  "quantserve.com",
  "moatads.com",
  "pubmatic.com",
  "rubiconproject.com",
  "openx.net",
  "casalemedia.com",
  "advertising.com",
  "hotjar.com",
  "mixpanel.com",
  "segment.io",
  "facebook.net",
  "connect.facebook.net",
  "ads-twitter.com",
  "bat.bing.com",
  "clarity.ms",
];

export function isAdHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return AD_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}
