/**
 * Anti-bot block-page detection.
 *
 * Ported from Crawl4AI `crawl4ai/antibot_detector.py`
 * (https://github.com/unclecode/crawl4ai, commit
 * cae74b203a33994f7e13b9052c3b0d5c93daa0e6), Copyright the Crawl4AI authors,
 * licensed under the Apache License 2.0 (see third_party/crawl4ai/LICENSE).
 *
 * Modifications: re-implemented in TypeScript; only the tier 1 (structural
 * vendor markers), tier 2 (short-page phrases) and status-code rules are
 * ported. Crawl4AI's tier 3 "structural integrity" heuristic and its
 * near-empty-200 rule are intentionally omitted: here a positive result
 * triggers a full stealth re-render, and those rules fire on legitimately
 * tiny pages. Added: the two Cloudflare interstitial phrases are also checked
 * on short HTTP 200 pages, because Cloudflare managed challenges can answer
 * 200.
 */

const TIER1_PATTERNS: Array<[RegExp, string]> = [
  [/Reference\s*#\s*[\d]+\.[0-9a-f]+\.\d+\.[0-9a-f]+/i, "Akamai block (Reference #)"],
  [/Pardon\s+Our\s+Interruption/i, "Akamai challenge (Pardon Our Interruption)"],
  [/challenge-form[\s\S]*?__cf_chl_f_tk=/i, "Cloudflare challenge form"],
  [/<span\s+class="cf-error-code">\d{4}<\/span>/i, "Cloudflare firewall block"],
  [/\/cdn-cgi\/challenge-platform\/\S+orchestrate/i, "Cloudflare JS challenge"],
  [/window\._pxAppId\s*=/i, "PerimeterX block"],
  [/captcha\.px-cdn\.net/i, "PerimeterX captcha"],
  [/captcha-delivery\.com/i, "DataDome captcha"],
  [/_Incapsula_Resource/i, "Imperva/Incapsula block"],
  [/Incapsula\s+incident\s+ID/i, "Imperva/Incapsula incident"],
  [/Sucuri\s+WebSite\s+Firewall/i, "Sucuri firewall block"],
  [/KPSDK\.scriptStart\s*=\s*KPSDK\.now\(\)/i, "Kasada challenge"],
  [/blocked\s+by\s+network\s+security/i, "Network security block"],
];

const TIER2_PATTERNS: Array<[RegExp, string]> = [
  [/Access\s+Denied/i, "Access Denied on short page"],
  [/Checking\s+your\s+browser/i, "Cloudflare browser check"],
  [/<title>\s*Just\s+a\s+moment/i, "Cloudflare interstitial"],
  [/class=["']g-recaptcha["']/i, "reCAPTCHA on block page"],
  [/class=["']h-captcha["']/i, "hCaptcha on block page"],
  [/Access\s+to\s+This\s+Page\s+Has\s+Been\s+Blocked/i, "PerimeterX block page"],
  [/blocked\s+by\s+security/i, "Blocked by security"],
  [/Request\s+unsuccessful/i, "Request unsuccessful (Imperva)"],
];

const TIER2_MAX_SIZE = 10_000;
const EMPTY_CONTENT_THRESHOLD = 100;
const SCRIPT_BLOCK_RE = /<script\b[\s\S]*?<\/script>/gi;
const STYLE_BLOCK_RE = /<style\b[\s\S]*?<\/style>/gi;

function looksLikeData(html: string): boolean {
  const stripped = html.trim();
  if (!stripped) return false;
  const first = stripped[0];
  if (first === "{" || first === "[") return true;
  const head = stripped.slice(0, 10).toLowerCase();
  if (head.startsWith("<html") || head.startsWith("<!")) {
    return /<body[^>]*>\s*<pre[^>]*>\s*[{[]/i.test(stripped.slice(0, 500));
  }
  return first === "<";
}

function stripScriptsAndStyles(html: string): string {
  return html.slice(0, 500_000).replace(SCRIPT_BLOCK_RE, "").replace(STYLE_BLOCK_RE, "");
}

export interface BlockVerdict {
  blocked: boolean;
  reason: string;
}

export function detectBlock(statusCode: number | undefined, html: string | undefined): BlockVerdict {
  const body = html ?? "";
  const length = body.length;

  if (statusCode === 429) return { blocked: true, reason: "HTTP 429 Too Many Requests" };

  const snippet = body.slice(0, 15_000);
  for (const [pattern, reason] of TIER1_PATTERNS) {
    if (pattern.test(snippet)) return { blocked: true, reason };
  }
  if (length > 15_000) {
    const deep = stripScriptsAndStyles(body).slice(0, 30_000);
    for (const [pattern, reason] of TIER1_PATTERNS) {
      if (pattern.test(deep)) return { blocked: true, reason };
    }
  }

  if ((statusCode === 403 || statusCode === 503) && !looksLikeData(body)) {
    if (length < EMPTY_CONTENT_THRESHOLD) {
      return { blocked: true, reason: `HTTP ${statusCode} with near-empty response (${length} bytes)` };
    }
    const check = length > TIER2_MAX_SIZE ? stripScriptsAndStyles(body).slice(0, 30_000) : snippet;
    for (const [pattern, reason] of TIER2_PATTERNS) {
      if (pattern.test(check)) return { blocked: true, reason: `${reason} (HTTP ${statusCode}, ${length} bytes)` };
    }
    return { blocked: true, reason: `HTTP ${statusCode} with HTML content (${length} bytes)` };
  }

  if (statusCode !== undefined && statusCode >= 400 && length < TIER2_MAX_SIZE) {
    for (const [pattern, reason] of TIER2_PATTERNS) {
      if (pattern.test(snippet)) return { blocked: true, reason: `${reason} (HTTP ${statusCode}, ${length} bytes)` };
    }
  }

  // Challenge interstitials are often served with HTTP 200 on tiny pages.
  if (length < TIER2_MAX_SIZE) {
    for (const [pattern, reason] of TIER2_PATTERNS.slice(1, 3)) {
      if (pattern.test(snippet)) return { blocked: true, reason };
    }
  }

  return { blocked: false, reason: "" };
}
