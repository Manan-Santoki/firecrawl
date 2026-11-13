import { buildRequestLogEntry } from "../request-log";
import { BatchWriter } from "../batch-writer";

const TEAM = "22222222-2222-4222-8222-222222222222";
const JOB = "3d478a29-6e59-403e-85c7-94aba81ffd2a";

describe("buildRequestLogEntry", () => {
  const base = {
    method: "POST",
    path: "/v2/scrape",
    statusCode: 200,
    durationMs: 1234.4,
    teamId: TEAM,
    apiKeyId: 7,
    now: new Date("2026-11-01T00:00:00Z"),
  };

  it("attributes a successful scrape to its team, key, target and job", () => {
    const entry = buildRequestLogEntry({
      ...base,
      requestBody: { url: "https://example.com", origin: "api" },
      captured: {
        endpoint: "/v2/scrape",
        body: { success: true, data: { metadata: { scrapeId: JOB } } },
      },
    });
    expect(entry).toMatchObject({
      teamId: TEAM,
      apiKeyId: 7,
      endpoint: "/v2/scrape",
      apiVersion: "v2",
      target: "https://example.com",
      statusCode: 200,
      durationMs: 1234,
      jobId: JOB,
      error: null,
      origin: "api",
      zeroDataRetention: false,
    });
  });

  it("records the async job id and the batch target summary", () => {
    const entry = buildRequestLogEntry({
      ...base,
      path: "/v2/batch/scrape",
      requestBody: {
        urls: ["https://a.test", "https://b.test", "https://c.test"],
      },
      captured: {
        endpoint: "/v2/batch/scrape",
        body: { success: true, id: JOB },
      },
    });
    expect(entry.jobId).toBe(JOB);
    expect(entry.target).toBe("https://a.test (+2 more)");
  });

  it("keeps the error of a refused request and drops non-uuid teams", () => {
    const entry = buildRequestLogEntry({
      ...base,
      statusCode: 402,
      teamId: "bypass",
      apiKeyId: 0,
      requestBody: { url: "https://example.com" },
      captured: {
        endpoint: null,
        body: { success: false, error: "Insufficient credits" },
      },
    });
    expect(entry.teamId).toBeNull();
    expect(entry.apiKeyId).toBeNull();
    expect(entry.error).toBe("Insufficient credits");
    expect(entry.endpoint).toBe("/v2/scrape");
  });

  it("never stores the target or error text of zero-data-retention requests", () => {
    const entry = buildRequestLogEntry({
      ...base,
      statusCode: 500,
      requestBody: { url: "https://secret.test", zeroDataRetention: true },
      captured: {
        endpoint: "/v2/scrape",
        body: { success: false, error: "boom https://secret.test" },
      },
    });
    expect(entry.target).toBeNull();
    expect(entry.error).toBe("HTTP 500");
    expect(entry.zeroDataRetention).toBe(true);
  });

  it("takes a status poll's job id from the path and normalizes the endpoint", () => {
    const entry = buildRequestLogEntry({
      ...base,
      method: "GET",
      path: `/v2/crawl/${JOB}`,
      requestBody: {},
      captured: { endpoint: null, body: undefined },
    });
    expect(entry.jobId).toBe(JOB);
    expect(entry.endpoint).toBe("/v2/crawl/:id");
    expect(entry.target).toBeNull();
  });

  it("truncates oversized targets", () => {
    const entry = buildRequestLogEntry({
      ...base,
      requestBody: { query: "q".repeat(5000) },
      captured: { endpoint: "/v2/search", body: { success: true } },
    });
    expect(entry.target!.length).toBeLessThanOrEqual(2048);
  });
});

describe("BatchWriter", () => {
  it("batches rows and never throws when the write fails", async () => {
    const written: number[][] = [];
    let fail = true;
    const writer = new BatchWriter<number>({
      name: "test",
      maxQueue: 3,
      flushSize: 100,
      flushIntervalMs: 60_000,
      write: async rows => {
        if (fail) throw new Error("db down");
        written.push(rows);
      },
    });
    writer.push(1);
    writer.push(2);
    await writer.flush();
    expect(writer.stats.dropped).toBe(2);

    fail = false;
    writer.push(3);
    writer.push(4);
    writer.push(5);
    writer.push(6); // over maxQueue: dropped, not thrown
    await writer.flush();
    expect(written).toEqual([[3, 4, 5]]);
    expect(writer.stats).toEqual({ queued: 0, dropped: 3 });
  });
});
