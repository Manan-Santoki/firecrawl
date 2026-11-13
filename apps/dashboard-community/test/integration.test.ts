/**
 * Authorization, invites, key lifecycle and limits against a real PostgreSQL.
 * Set DASHBOARD_TEST_DATABASE_URL to a throwaway database migrated with
 * community/migrations and seeded with 090-seed.sql; otherwise skipped.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Viewer } from "@/lib/server/authz";
import { ForbiddenError } from "@/lib/server/authz";

const enabled = Boolean(process.env.DASHBOARD_TEST_DATABASE_URL);

describe.skipIf(!enabled)("dashboard data layer (PostgreSQL)", async () => {
  const { query, pools } = await import("@/lib/server/db");
  const accounts = await import("@/lib/server/accounts");
  const keys = await import("@/lib/server/api-keys");
  const logs = await import("@/lib/server/request-log");
  const usage = await import("@/lib/server/usage");
  const jobs = await import("@/lib/server/jobs");
  const users = await import("@/lib/server/users");

  let alice: Viewer;
  let bob: Viewer;
  let admin: Viewer;
  const suffix = randomUUID().slice(0, 8);

  async function makeUser(name: string, role: "admin" | "member"): Promise<Viewer> {
    const teamId = await accounts.provisionTeam(null, `${name}-${suffix}`);
    const rows = await query<{ id: string }>(
      `INSERT INTO dashboard."user" (name, email, "emailVerified", role, "teamId")
       VALUES ($1, $2, false, $3, $4::uuid) RETURNING id`,
      [name, `${name}-${suffix}@example.test`, role, teamId],
    );
    return { userId: rows[0].id, email: `${name}-${suffix}@example.test`, name, role, teamId, twoFactorEnabled: false };
  }

  async function logRequest(viewer: Viewer, apiKeyId: number | null, opts: { status?: number; endpoint?: string; jobId?: string } = {}) {
    await query(
      `INSERT INTO community.request_log (team_id, api_key_id, method, endpoint, path, target, status_code, duration_ms, job_id)
       VALUES ($1::uuid, $2, 'POST', $3, $3, 'https://example.com', $4, 120, $5)`,
      [viewer.teamId, apiKeyId, opts.endpoint ?? "/v2/scrape", opts.status ?? 200, opts.jobId ?? null],
    );
  }

  beforeAll(async () => {
    alice = await makeUser("alice", "member");
    bob = await makeUser("bob", "member");
    admin = await makeUser("root", "admin");
  });

  afterAll(async () => {
    await pools().app.end();
  });

  it("creates a usable Firecrawl team: auth_chunk_2 resolves a new key to it", async () => {
    const created = await keys.createApiKey(alice, { name: "laptop" });
    expect(created.key).toMatch(/^fc-[0-9a-f]{32}$/);
    const uuid = created.key.slice(3).replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
    const rows = await query<{ team_id: string; is_banned: boolean; org_id: string }>(
      `SELECT team_id, is_banned, org_id FROM public.auth_chunk_2($1)`,
      [uuid],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].team_id).toBe(alice.teamId);
    expect(rows[0].is_banned).toBe(false);
    expect(rows[0].org_id).toBeTruthy();
  });

  it("never lists another user's keys to a member, but lists all to admins", async () => {
    await keys.createApiKey(bob, { name: "bob-key" });
    const aliceKeys = await keys.listApiKeys(alice);
    expect(aliceKeys.every((key) => key.teamId === alice.teamId)).toBe(true);
    expect(aliceKeys.some((key) => key.name === "bob-key")).toBe(false);
    await expect(keys.listApiKeys(alice, bob.teamId)).rejects.toBeInstanceOf(ForbiddenError);
    const all = await keys.listApiKeys(admin);
    expect(all.some((key) => key.name === "bob-key")).toBe(true);
    expect(all.some((key) => key.name === "laptop")).toBe(true);
    // The full key never appears in listings.
    expect(JSON.stringify(all)).not.toMatch(/fc-[0-9a-f]{32}/);
  });

  it("refuses cross-user key mutations and allows the owner and admins", async () => {
    const bobKey = (await keys.listApiKeys(bob))[0];
    await expect(keys.revokeApiKey(alice, bobKey.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      keys.setApiKeyLimits(alice, bobKey.id, { creditLimit: 1, creditLimitInterval: "day", concurrency: null }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(keys.createApiKey(alice, { name: "sneaky", teamId: bob.teamId })).rejects.toBeInstanceOf(ForbiddenError);

    await keys.setApiKeyLimits(admin, bobKey.id, { creditLimit: 50, creditLimitInterval: "week", concurrency: 2 });
    const updated = (await keys.listApiKeys(bob)).find((key) => key.id === bobKey.id)!;
    expect(updated).toMatchObject({ creditLimit: 50, creditLimitInterval: "week", concurrency: 2 });

    await keys.revokeApiKey(bob, bobKey.id);
    expect((await keys.listApiKeys(bob)).some((key) => key.id === bobKey.id)).toBe(false);
  });

  it("scopes the request log, usage, overview and CSV export per user", async () => {
    const aliceKey = (await keys.listApiKeys(alice))[0];
    await logRequest(alice, aliceKey.id);
    await logRequest(alice, aliceKey.id, { status: 402 });
    await logRequest(bob, null, { status: 500 });
    await query(`INSERT INTO community.credit_usage (team_id, api_key_id, endpoint, credits) VALUES ($1::uuid, $2, 'scrape', 3)`, [
      alice.teamId,
      aliceKey.id,
    ]);

    const filters = logs.parseLogFilters({});
    const aliceView = await logs.searchLogs(alice, filters);
    expect(aliceView.total).toBe(2);
    expect(aliceView.rows.every((row) => row.teamId === alice.teamId)).toBe(true);

    // A member cannot pull someone else's log through the user filter, by URL or CSV.
    await expect(logs.searchLogs(alice, logs.parseLogFilters({ user: bob.teamId! }))).rejects.toBeInstanceOf(ForbiddenError);
    const exported = [];
    for await (const row of logs.exportLogs(alice, filters)) exported.push(row);
    expect(exported.every((row) => row.teamId === alice.teamId)).toBe(true);
    await expect(logs.exportLogs(alice, logs.parseLogFilters({ user: bob.teamId! })).next()).rejects.toBeInstanceOf(ForbiddenError);

    const adminView = await logs.searchLogs(admin, filters);
    expect(adminView.rows.some((row) => row.teamId === bob.teamId)).toBe(true);
    const errorsOnly = await logs.searchLogs(alice, logs.parseLogFilters({ status: "errors" }));
    expect(errorsOnly.rows.map((row) => row.statusCode)).toEqual([402]);

    const stats = await usage.overviewStats(alice);
    expect(stats.requestsToday).toBe(2);
    expect(stats.credits7d).toBe(3);
    expect(stats.successRate7d).toBeCloseTo(0.5);
    await expect(usage.overviewStats(alice, bob.teamId)).rejects.toBeInstanceOf(ForbiddenError);

    const credits = await usage.creditSeries(bob, "endpoint", 7);
    expect(credits.keys).toEqual([]);
    const adminCredits = await usage.creditSeries(admin, "user", 7);
    expect(adminCredits.keys).toContain(alice.email);
  });

  it("hides another user's jobs and refuses to cancel them", async () => {
    const jobId = randomUUID();
    await logRequest(bob, null, { endpoint: "/v2/crawl", jobId });
    expect((await jobs.listJobs(alice)).some((job) => job.id === jobId)).toBe(false);
    expect((await jobs.listJobs(bob)).some((job) => job.id === jobId)).toBe(true);
    expect(await jobs.findJob(alice, jobId)).toBeNull();
    await expect(jobs.cancelJob(alice, jobId)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await jobs.findJob(admin, jobId)).toMatchObject({ teamId: bob.teamId, kind: "crawl" });
  });

  it("disables and re-enables a user's Firecrawl team", async () => {
    await expect(users.setUserDisabled(alice, bob.userId, true)).rejects.toBeInstanceOf(ForbiddenError);
    await users.setUserDisabled(admin, bob.userId, true);
    const banned = await query<{ banned: boolean }>(`SELECT banned FROM public.teams WHERE id = $1::uuid`, [bob.teamId]);
    expect(banned[0].banned).toBe(true);
    const listed = (await users.listUsers(admin)).find((user) => user.id === bob.userId)!;
    expect(listed.disabled).toBe(true);
    await users.setUserDisabled(admin, bob.userId, false);
    const unbanned = await query<{ banned: boolean }>(`SELECT banned FROM public.teams WHERE id = $1::uuid`, [bob.teamId]);
    expect(unbanned[0].banned).toBe(false);
    await expect(users.setUserDisabled(admin, admin.userId, true)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("stores team limits the API gate reads", async () => {
    await expect(
      users.setTeamLimits(alice, alice.userId, { creditLimit: 5, creditLimitInterval: "day", concurrencyLimit: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await users.setTeamLimits(admin, alice.userId, { creditLimit: 5, creditLimitInterval: "day", concurrencyLimit: 1 });
    const gate = await query<{ team_limit: number; team_used: string }>(
      `SELECT team_limit, team_used FROM community.credit_gate_state($1::uuid, NULL)`,
      [alice.teamId],
    );
    expect(gate[0].team_limit).toBe(5);
    expect(Number(gate[0].team_used)).toBe(3);
  });

  it("issues single-use, expiring invites that only admins can create", async () => {
    await expect(accounts.createInvite(alice, { role: "member" })).rejects.toBeInstanceOf(ForbiddenError);

    const invite = await accounts.createInvite(admin, { role: "member", email: `carol-${suffix}@example.test` });
    const token = invite.url.split("/invite/")[1];
    expect(await accounts.findUsableInvite(token)).not.toBeNull();

    await expect(
      accounts.acceptInvite(token, { name: "Mallory", email: `mallory-${suffix}@example.test`, password: "correct-horse-battery" }),
    ).rejects.toThrow(/different email/);
    // The failed attempt released the claim, so the right person can still use it.
    await accounts.acceptInvite(token, { name: "Carol", email: `carol-${suffix}@example.test`, password: "correct-horse-battery" });
    const carol = await query<{ role: string; teamId: string }>(
      `SELECT role, "teamId" FROM dashboard."user" WHERE email = $1`,
      [`carol-${suffix}@example.test`],
    );
    expect(carol[0].role).toBe("member");
    expect(carol[0].teamId).toBeTruthy();
    expect(carol[0].teamId).not.toBe(alice.teamId);

    await expect(
      accounts.acceptInvite(token, { name: "Again", email: `carol-${suffix}@example.test`, password: "correct-horse-battery" }),
    ).rejects.toThrow(/invalid, expired or already used/);

    const expired = await accounts.createInvite(admin, { role: "member" });
    await query(`UPDATE dashboard.invitation SET expires_at = now() - interval '1 minute' WHERE token_hash = $1`, [
      (await import("@/lib/server/tokens")).hashToken(expired.url.split("/invite/")[1]),
    ]);
    expect(await accounts.findUsableInvite(expired.url.split("/invite/")[1])).toBeNull();

    const revoked = await accounts.createInvite(admin, { role: "member" });
    const list = await accounts.listInvites(admin);
    const revokedRow = list.find((row) => row.created_at && accounts.inviteStatus(row) === "pending");
    await accounts.revokeInvite(admin, revokedRow!.id);
    expect(accounts.inviteStatus({ ...revokedRow!, revoked_at: new Date() })).toBe("revoked");
    expect(revoked.url).toContain("/invite/");
  });

  it("refuses bootstrap with a wrong token or once accounts exist", async () => {
    await expect(
      accounts.bootstrapAdmin("wrong-token", { name: "X", email: `x-${suffix}@example.test`, password: "correct-horse-battery" }),
    ).rejects.toThrow(/not valid/);
    await expect(
      accounts.bootstrapAdmin("test-bootstrap-token", { name: "X", email: `x-${suffix}@example.test`, password: "correct-horse-battery" }),
    ).rejects.toThrow(/already been set up/);
  });
});
