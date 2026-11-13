# Third-party notices

This service is distributed under the repository's AGPL-3.0 license. It
includes code derived from the following Apache-2.0 project.

## Crawl4AI

- Project: https://github.com/unclecode/crawl4ai
- Commit: `cae74b203a33994f7e13b9052c3b0d5c93daa0e6`
- License: Apache License 2.0 — full text in [`third_party/crawl4ai/LICENSE`](third_party/crawl4ai/LICENSE).
  Crawl4AI ships no NOTICE file at that commit.

| Crawl4AI file | Used in | What was taken | Modifications |
| --- | --- | --- | --- |
| `crawl4ai/antibot_detector.py` | `src/antibot.ts` | Tier 1 vendor block markers, tier 2 short-page phrases, 403/503/429 rules, data-response exemption | Rewritten in TypeScript; tier 3 structural heuristic and the near-empty-200 rule omitted; Cloudflare interstitial phrases also checked on short HTTP 200 pages |
| `crawl4ai/js_snippet/navigator_overrider.js` | `src/stealth.ts` (`navigatorOverrider`) | Permissions query fix, `navigator.webdriver`, `window.chrome.runtime`, `navigator.languages`, `document.hidden`/`visibilityState` overrides | Each override only applies when the value actually leaks automation; `navigator.plugins` is no longer replaced by a plain array; languages come from the request locale |
| `crawl4ai/browser_manager.py` (`build_browser_flags`) | `src/stealth.ts` (`*_LAUNCH_ARGS`) | Chromium launch flags, including keeping WebGL (SwiftShader) enabled for stealth while basic mode disables the GPU | Subset of flags; `--enable-unsafe-swiftshader`/`--use-angle=swiftshader` added for GPU-less containers |
| `crawl4ai/async_crawler_strategy.py` (`simulate_user`/`magic`) | `src/stealth.ts` (`simulateUser`) | Two randomized mouse moves plus a wheel scroll after load, no keyboard input or clicks | Mouse moves use Playwright `steps` for smoother paths |
| `crawl4ai/user_agent_generator.py` (`UAGen.generate_client_hints`) | `src/stealth.ts` (`clientHints`) | Sec-CH-UA brand list derived from the UA string | Adds `sec-ch-ua-mobile` and `sec-ch-ua-platform`; the UA itself is derived from the running Chromium version instead of Crawl4AI's random generator |
| `crawl4ai/browser_adapter.py` (`UndetectedAdapter`) | `src/actions.ts` | Running internal page evaluations in patchright's isolated world in stealth mode | User `executeJavascript` always runs in the main world |
| `crawl4ai/async_webcrawler.py` (anti-bot retry loop) | `src/scrape-service.ts` | Detect a block after a fetch and retry with a different browser/proxy configuration | Single stealth retry within the original time budget |
