/** Cross-user denial for the v2 features (PostgreSQL; see integration.test.ts). */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, type Viewer } from "@/lib/server/authz";

const enabled = Boolean(process.env.DASHBOARD_TEST_DATABASE_URL);

describe.skipIf(!enabled)("v2 authorization (PostgreSQL)", async () => {
  const { query, pools } = await import("@/lib/server/db");
  const accounts = await import("@/lib/server/accounts");
  const keys = await import("@/lib/server/api-keys");
  const acting = await import("@/lib/server/acting-key");
  const playground = await import("@/lib/server/playground");
  const browser = await import("@/lib/server/browser");
  const monitors = await import("@/lib/server/monitors");
  const agent = await import("@/lib/server/agent");

  const suffix = randomUUID().slice(0, 8);
  let alice: Viewer;
  let bob: Viewer;
  let admin: Viewer;

  async function makeUser(name: string, role: "admin" | "member"): Promise<Viewer> {
    const teamId = await accounts.provisionTeam(null, `${name}-${suffix}`);
    const rows = await query<{ id: string }>(
      `INSERT INTO dashboard."user" (name, email, "emailVerified", role, "teamId") VALUES ($1, $2, false, $3, $4::uuid) RETURNING id`,
      [name, `${name}-v2-${suffix}@example.test`, role, teamId],
    );
    return { userId: rows[0].id, email: `${name}-v2-${suffix}@example.test`, name, role, teamId, twoFactorEnabled: false };
  }

  beforeAll(async () => {
    alice = await makeUser("alice", "member");
    bob = await makeUser("bob", "member");
    admin = await makeUser("root", "admin");
  });

  afterAll(async () => {
    await pools().app.end();
  });

  it("never lets a member act with another user's key", async () => {
    const bobKey = await keys.createApiKey(bob, { name: "bob" });
    await expect(acting.actingKey(alice, { keyId: bobKey.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(acting.actingKey(alice, { teamId: bob.teamId })).rejects.toBeInstanceOf(ForbiddenError);
    const internal = await acting.actingKey(alice);
    expect(internal.teamId).toBe(alice.teamId);
    // The internal key is reused, not recreated.
    expect((await acting.actingKey(alice)).id).toBe(internal.id);
    // Admins may act for any team (e.g. to cancel a user's job).
    expect((await acting.actingKey(admin, { teamId: bob.teamId })).teamId).toBe(bob.teamId);
  });

  it("keeps playground history private", async () => {
    const rows = await query<{ id: string }>(
      `INSERT INTO dashboard.playground_request (user_id, team_id, kind, request, job_id)
       VALUES ($1::uuid, $2::uuid, 'crawl', '{}'::jsonb, $3) RETURNING id`,
      [bob.userId, bob.teamId, randomUUID()],
    );
    expect((await playground.listHistory(alice)).some((item) => item.id === rows[0].id)).toBe(false);
    await expect(playground.pollPlayground(alice, rows[0].id)).rejects.toBeInstanceOf(ForbiddenError);
    await playground.deleteHistory(alice, rows[0].id);
    expect((await playground.listHistory(bob)).some((item) => item.id === rows[0].id)).toBe(true);
  });

  it("hides and protects another user's browser sessions and profiles", async () => {
    const sessionId = randomUUID();
    await query(
      `INSERT INTO public.browser_sessions (id, team_id, browser_id, workspace_id, context_id, cdp_url, cdp_path, ttl_total)
       VALUES ($1::uuid, $2, 'b', 'w', 'c', 'ws://x', '/x', 600)`,
      [sessionId, bob.teamId],
    );
    await query(`INSERT INTO public.browser_profiles (team_id, name, saved_at) VALUES ($1::uuid, 'bob-profile', now())`, [bob.teamId]);
    expect((await browser.listBrowserSessions(alice)).some((s) => s.id === sessionId)).toBe(false);
    expect((await browser.listBrowserSessions(bob)).some((s) => s.id === sessionId)).toBe(true);
    expect((await browser.listBrowserSessions(admin)).some((s) => s.id === sessionId)).toBe(true);
    await expect(browser.browserSessionLinks(alice, sessionId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(browser.executeInBrowser(alice, sessionId, { code: "1", language: "node", timeout: 5 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(browser.closeBrowserSession(alice, sessionId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await browser.listBrowserProfiles(alice)).length).toBe(0);
    await expect(browser.deleteBrowserProfile(alice, bob.teamId!, "bob-profile")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("hides and protects another user's monitors", async () => {
    const monitorId = randomUUID();
    await query(
      `INSERT INTO public.monitors (id, team_id, name, schedule_cron) VALUES ($1::uuid, $2::uuid, 'bob monitor', '0 9 * * *')`,
      [monitorId, bob.teamId],
    );
    expect((await monitors.listMonitors(alice)).some((m) => m.id === monitorId)).toBe(false);
    expect((await monitors.listMonitors(bob)).map((m) => m.id)).toContain(monitorId);
    await expect(monitors.getMonitor(alice, monitorId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(monitors.runMonitor(alice, monitorId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(monitors.deleteMonitor(alice, monitorId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(monitors.updateMonitor(alice, monitorId, { status: "paused" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(monitors.getCheck(alice, monitorId, randomUUID())).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("hides and protects another user's agent runs", async () => {
    const runId = randomUUID();
    await query(
      `INSERT INTO community.request_log (team_id, method, endpoint, path, target, status_code, duration_ms, job_id)
       VALUES ($1::uuid, 'POST', '/v2/agent', '/v2/agent', 'secret research', 200, 10, $2)`,
      [bob.teamId, runId],
    );
    expect((await agent.listAgentRuns(alice)).some((run) => run.id === runId)).toBe(false);
    expect((await agent.listAgentRuns(bob)).some((run) => run.id === runId)).toBe(true);
    await expect(agent.agentDetail(alice, runId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(agent.cancelAgent(alice, runId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(agent.agentSkill(alice, runId)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
