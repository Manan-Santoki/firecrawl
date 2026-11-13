/**
 * Unit test for audio/video engine routing on self-hosted deployments
 * (no fire-engine). The audio and video formats are produced by the
 * AVGRAB_SERVICE_URL transformers after a plain page fetch, so the
 * self-hosted engines must qualify instead of leaving an empty fallback list.
 */

describe("Audio/video format engine routing without fire-engine", () => {
  let buildFallbackList: typeof import("../../../scraper/scrapeURL/engines/index.js").buildFallbackList;

  const originalFireEngineUrl = process.env.FIRE_ENGINE_BETA_URL;
  const originalPlaywrightUrl = process.env.PLAYWRIGHT_MICROSERVICE_URL;
  const originalIndexUrl = process.env.INDEX_DATABASE_URL;

  beforeAll(async () => {
    delete process.env.FIRE_ENGINE_BETA_URL;
    delete process.env.INDEX_DATABASE_URL;
    process.env.PLAYWRIGHT_MICROSERVICE_URL = "http://test-playwright/scrape";

    vi.resetModules();
    ({ buildFallbackList } = await import(
      "../../../scraper/scrapeURL/engines/index.js"
    ));
  });

  afterAll(() => {
    for (const [key, value] of [
      ["FIRE_ENGINE_BETA_URL", originalFireEngineUrl],
      ["PLAYWRIGHT_MICROSERVICE_URL", originalPlaywrightUrl],
      ["INDEX_DATABASE_URL", originalIndexUrl],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  const buildStubMeta = (featureFlags: string[]) =>
    ({
      id: "test",
      url: "https://www.youtube.com/watch?v=abc",
      options: {
        formats: [],
        maxAge: 3600000,
      },
      internalOptions: { teamId: "test" },
      featureFlags: new Set(featureFlags),
      mock: null,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    }) as any;

  it.each(["audio", "video"])(
    "routes %s format through the self-hosted engines",
    async flag => {
      const fallback = await buildFallbackList(buildStubMeta([flag]));

      expect(fallback.map(f => f.engine)).toEqual(
        expect.arrayContaining(["playwright", "fetch"]),
      );
      for (const entry of fallback) {
        expect(entry.unsupportedFeatures.has(flag as any)).toBe(false);
      }
    },
  );
});
