import { describe, expect, it } from "vitest";
import { isPublicSignUpAttempt } from "@/lib/server/auth";
import {
  assertAdmin,
  assertCanManageTeam,
  ForbiddenError,
  resolveScope,
  scopeClause,
  type Viewer,
} from "@/lib/server/authz";
import { csvLine } from "@/lib/server/request-log";
import { formatApiKey, hashToken, maskApiKey, safeEqual } from "@/lib/server/tokens";
import { pivotDaily } from "@/lib/server/usage";
import { crawlStatus } from "@/lib/server/jobs";

const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const member: Viewer = { userId: "u1", email: "a@x", name: "A", role: "member", teamId: TEAM_A, twoFactorEnabled: false };
const admin: Viewer = { ...member, userId: "u0", role: "admin", teamId: TEAM_B };

describe("resolveScope", () => {
  it("limits a member to their own team", () => {
    expect(resolveScope(member)).toEqual({ kind: "teams", teamIds: [TEAM_A] });
    expect(resolveScope(member, TEAM_A)).toEqual({ kind: "teams", teamIds: [TEAM_A] });
  });

  it("refuses a member asking for another user's team", () => {
    expect(() => resolveScope(member, TEAM_B)).toThrow(ForbiddenError);
  });

  it("gives a member without a team nothing, never everything", () => {
    const params: unknown[] = [];
    expect(scopeClause(resolveScope({ ...member, teamId: null }), "t", params)).toBe("FALSE");
  });

  it("lets admins read everything or filter to one team", () => {
    expect(resolveScope(admin)).toEqual({ kind: "all" });
    expect(resolveScope(admin, TEAM_A)).toEqual({ kind: "teams", teamIds: [TEAM_A] });
  });

  it("binds team ids as a parameter", () => {
    const params: unknown[] = ["x"];
    expect(scopeClause({ kind: "teams", teamIds: [TEAM_A] }, "r.team_id", params)).toBe("r.team_id::text = ANY($2::text[])");
    expect(params[1]).toEqual([TEAM_A]);
  });
});

describe("management checks", () => {
  it("lets a member manage only their own team", () => {
    expect(() => assertCanManageTeam(member, TEAM_A)).not.toThrow();
    expect(() => assertCanManageTeam(member, TEAM_B)).toThrow(ForbiddenError);
    expect(() => assertCanManageTeam(member, null)).toThrow(ForbiddenError);
  });

  it("lets admins manage any team but requires the admin role", () => {
    expect(() => assertCanManageTeam(admin, TEAM_A)).not.toThrow();
    expect(() => assertAdmin(member)).toThrow(ForbiddenError);
    expect(() => assertAdmin(admin)).not.toThrow();
  });

  it("refuses sign-up over HTTP but allows the server-side bootstrap/invite call", () => {
    expect(isPublicSignUpAttempt("/sign-up/email", true)).toBe(true);
    expect(isPublicSignUpAttempt("/sign-up/email", false)).toBe(false);
    expect(isPublicSignUpAttempt("/sign-in/email", true)).toBe(false);
  });
});

describe("tokens and keys", () => {
  it("formats keys like the API expects and masks them for display", () => {
    const uuid = "3d478a29-6e59-403e-85c7-94aba81ffd2a";
    expect(formatApiKey(uuid)).toBe("fc-3d478a296e59403e85c794aba81ffd2a");
    expect(maskApiKey(uuid)).toBe("fc-3d47…fd2a");
    expect(maskApiKey(uuid)).not.toContain("6e59403e");
  });

  it("compares secrets in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(hashToken("x")).toHaveLength(64);
  });
});

describe("CSV export", () => {
  it("quotes fields and neutralizes spreadsheet formulas", () => {
    const line = csvLine({
      id: 1,
      createdAt: "2026-11-01T00:00:00.000Z",
      teamId: TEAM_A,
      userEmail: "a@x",
      apiKeyId: 2,
      apiKeyName: 'key, "one"',
      method: "POST",
      endpoint: "/v2/scrape",
      path: "/v2/scrape",
      target: "=HYPERLINK(\"http://evil\")",
      statusCode: 200,
      durationMs: 10,
      jobId: null,
      error: null,
      origin: null,
      zeroDataRetention: false,
      credits: 1,
    });
    expect(line).toContain('"key, ""one"""');
    expect(line).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

describe("usage pivot", () => {
  it("fills missing days with zeros and folds extra series into other", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ day: "2026-11-13", key: `k${i}`, value: 10 - i }));
    const series = pivotDaily(rows, 3, new Date("2026-11-13T12:00:00Z"));
    expect(series.points.map((point) => point.day)).toEqual(["2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(series.keys).toHaveLength(9);
    expect(series.keys.at(-1)).toBe("other");
    expect(series.points[2].other).toBe(2 + 1);
    expect(series.points[0].k0).toBe(0);
  });
});

describe("crawl status", () => {
  const base = { exists: true, cancelled: false, total: 10, done: 4, succeeded: 3, kickoffFinished: true, error: null };
  it("derives progress and failures from the crawl bookkeeping", () => {
    expect(crawlStatus(base)).toEqual({ status: "scraping", total: 10, completed: 3, failed: 1 });
    expect(crawlStatus({ ...base, done: 10, succeeded: 9 }).status).toBe("completed");
    expect(crawlStatus({ ...base, cancelled: true }).status).toBe("cancelled");
    expect(crawlStatus({ ...base, exists: false }).status).toBe("expired");
    expect(crawlStatus(null).status).toBe("unknown");
  });
});
