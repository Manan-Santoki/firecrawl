// Bundles the Firecrawl API's branding script exactly like
// apps/api/src/scraper/scrapeURL/engines/fire-engine/brandingScript.ts does,
// so the contract test can send the real script the API would send.
//
// usage: node build-branding.mjs <path/to/branding-script/index.ts> <out.js>
import { writeFileSync } from "node:fs";
import { buildSync } from "esbuild";

const [entry, out] = process.argv.slice(2);
if (!entry || !out) {
  console.error("usage: node build-branding.mjs <branding-script/index.ts> <out.js>");
  process.exit(2);
}
const result = buildSync({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: "iife",
  globalName: "__extractBrandDesign",
  target: ["es2020"],
  write: false,
});
// v2.11.739 calls extractBrandDesignWithLogoColors(); older API releases call
// extractBrandDesign(). Use whichever the bundled source exports.
const script = `(function __extractBrandDesign() {
${result.outputFiles[0].text}
return typeof __extractBrandDesign.extractBrandDesignWithLogoColors === "function"
  ? __extractBrandDesign.extractBrandDesignWithLogoColors()
  : __extractBrandDesign.extractBrandDesign();
})();`;
writeFileSync(out, script);
console.log(`wrote ${out} (${script.length} bytes)`);
