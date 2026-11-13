const { readApiJobAccess, mockConfig } = vi.hoisted(() => ({
  readApiJobAccess: vi.fn(),
  mockConfig: {} as Record<string, string | undefined>,
}));

vi.mock("../config", () => ({ config: mockConfig }));
vi.mock("./job-access-store", () => ({ readApiJobAccess }));
vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  getAgentJobAccess,
  getCrawlJobAccess,
  getExtractJobAccess,
  getScrapeJobAccess,
} from "./operational-job-access";

const JOB_ID = "019e6f45-7778-727d-adf0-0abe9d5062b6";

describe("operational job access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the typed Bigtable record", async () => {
    const access = {
      teamId: "team-id",
      kind: "agent",
      clientOrigin: "python-sdk@4.37.1",
      expiresAtMs: Date.now() + 60_000,
    };
    readApiJobAccess.mockResolvedValue(access);

    await expect(getAgentJobAccess(JOB_ID)).resolves.toBe(access);
  });

  it("extract access accepts extract and agent records and rejects a scrape", async () => {
    const base = { teamId: "team-id", expiresAtMs: Date.now() + 60_000 };
    readApiJobAccess.mockResolvedValueOnce({ ...base, kind: "extract" });
    await expect(getExtractJobAccess(JOB_ID)).resolves.toMatchObject({
      kind: "extract",
    });
    readApiJobAccess.mockResolvedValueOnce({ ...base, kind: "agent" });
    await expect(getExtractJobAccess(JOB_ID)).resolves.toMatchObject({
      kind: "agent",
    });
    readApiJobAccess.mockResolvedValueOnce({ ...base, kind: "scrape" });
    await expect(getExtractJobAccess(JOB_ID)).resolves.toBeNull();
  });

  it("returns an expired record so the caller can answer 404 with its expiry", async () => {
    const access = {
      teamId: "team-id",
      kind: "scrape",
      expiresAtMs: Date.now() - 1,
    };
    readApiJobAccess.mockResolvedValue(access);

    await expect(getScrapeJobAccess(JOB_ID)).resolves.toBe(access);
  });

  it("returns null for a different job kind", async () => {
    readApiJobAccess.mockResolvedValue({
      teamId: "team-id",
      kind: "crawl",
      expiresAtMs: Date.now() + 60_000,
    });

    await expect(getScrapeJobAccess(JOB_ID)).resolves.toBeNull();
    await expect(getCrawlJobAccess(JOB_ID)).resolves.toMatchObject({
      kind: "crawl",
    });
  });

  it("crawl access accepts crawl and batch_scrape records and rejects a scrape", async () => {
    const base = { teamId: "team-id", expiresAtMs: Date.now() + 60_000 };
    readApiJobAccess.mockResolvedValueOnce({ ...base, kind: "crawl" });
    await expect(getCrawlJobAccess(JOB_ID)).resolves.toMatchObject({
      kind: "crawl",
    });
    readApiJobAccess.mockResolvedValueOnce({ ...base, kind: "batch_scrape" });
    await expect(getCrawlJobAccess(JOB_ID)).resolves.toMatchObject({
      kind: "batch_scrape",
    });
    readApiJobAccess.mockResolvedValueOnce({ ...base, kind: "scrape" });
    await expect(getCrawlJobAccess(JOB_ID)).resolves.toBeNull();
  });

  it("returns null when Bigtable has no row", async () => {
    readApiJobAccess.mockResolvedValue(null);
    await expect(getScrapeJobAccess(JOB_ID)).resolves.toBeNull();
  });

  it("answers not found for an id that is not a UUIDv7, without reading", async () => {
    await expect(
      getScrapeJobAccess("817f931c-89b5-472d-977c-b7061ac3ce1c"),
    ).resolves.toBeNull();
    await expect(getCrawlJobAccess("not-a-uuid")).resolves.toBeNull();
    expect(readApiJobAccess).not.toHaveBeenCalled();
  });

  it("rethrows a failed Bigtable read instead of reporting a missing job", async () => {
    readApiJobAccess.mockRejectedValue(new Error("Bigtable unavailable"));
    await expect(getScrapeJobAccess(JOB_ID)).rejects.toThrow(
      "Bigtable unavailable",
    );
  });
});

describe("agent job access without Bigtable (community self-host)", () => {
  const fetchMock = vi.fn();
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    mockConfig.EXTRACT_V3_BETA_URL = "http://agent-community:3010/";
    mockConfig.AGENT_INTEROP_SECRET = "interop-secret";
    delete mockConfig.BIGTABLE_JOB_ACCESS_TABLE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete mockConfig.EXTRACT_V3_BETA_URL;
    delete mockConfig.AGENT_INTEROP_SECRET;
    delete mockConfig.BIGTABLE_JOB_ACCESS_TABLE;
  });

  it("derives owner and a 24h expiry from the agent service status", async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        success: true,
        id: JOB_ID,
        status: "processing",
        teamId: "team-a",
        createdAt: "2026-11-13T10:00:00.000Z",
      }),
    );

    await expect(getAgentJobAccess(JOB_ID)).resolves.toEqual({
      teamId: "team-a",
      kind: "agent",
      expiresAtMs: Date.parse("2026-11-13T10:00:00.000Z") + 86_400_000,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `http://agent-community:3010/internal/extracts/${JOB_ID}`,
      expect.objectContaining({
        headers: { Authorization: "Bearer interop-secret" },
      }),
    );
    expect(readApiJobAccess).not.toHaveBeenCalled();
  });

  it("carries a zero data retention window reported by the service", async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        teamId: "team-a",
        createdAt: "2026-11-13T10:00:00.000Z",
        zeroDataRetentionMinutes: 30,
      }),
    );
    await expect(getAgentJobAccess(JOB_ID)).resolves.toMatchObject({
      zeroDataRetentionMinutes: 30,
    });
  });

  it("treats 404, 410 and a status without ownership fields as not found", async () => {
    fetchMock.mockResolvedValueOnce(reply(404, { success: false }));
    await expect(getAgentJobAccess(JOB_ID)).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(reply(410, { code: "zdr_expired" }));
    await expect(getAgentJobAccess(JOB_ID)).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(reply(200, { status: "processing" }));
    await expect(getAgentJobAccess(JOB_ID)).resolves.toBeNull();
  });

  it("rethrows an agent service outage", async () => {
    fetchMock.mockResolvedValueOnce(reply(503, { error: "down" }));
    await expect(getAgentJobAccess(JOB_ID)).rejects.toThrow(
      "Agent service returned 503",
    );
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(getAgentJobAccess(JOB_ID)).rejects.toThrow("ECONNREFUSED");
  });

  it("does not call the service for an id that is not a UUIDv7", async () => {
    await expect(
      getAgentJobAccess("817f931c-89b5-472d-977c-b7061ac3ce1c"),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the Bigtable path when the job access table is configured", async () => {
    mockConfig.BIGTABLE_JOB_ACCESS_TABLE = "job-access";
    const access = {
      teamId: "team-a",
      kind: "agent",
      expiresAtMs: Date.now() + 60_000,
    };
    readApiJobAccess.mockResolvedValue(access);
    await expect(getAgentJobAccess(JOB_ID)).resolves.toBe(access);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves non-agent lookups on the Bigtable path", async () => {
    readApiJobAccess.mockResolvedValue(null);
    await expect(getScrapeJobAccess(JOB_ID)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
