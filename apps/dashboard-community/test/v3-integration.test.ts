/** v3 authorization and behavior against PostgreSQL (see integration.test.ts). */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, type Viewer } from "@/lib/server/authz";

const enabled = Boolean(process.env.DASHBOARD_TEST_DATABASE_URL);

describe.skipIf(!enabled)("v3 operations (PostgreSQL)", async () => {
  const { query, pools } = await import("@/lib/server/db");
  const accounts = await import("@/lib/server/accounts");
  const settings = await import("@/lib/server/settings");
  const notifications = await import("@/lib/server/notifications");
  const webhooks = await import("@/lib/server/webhooks");
  const blocklist = await import("@/lib/server/blocklist");
  const auditLog = await import("@/lib/server/audit-log");
  const alerts = await import("@/lib/server/alerts");
  const cleanup = await import("@/lib/server/cleanup");
  const users = await import("@/lib/server/users");

  const suffix = randomUUID().slice(0, 8);
  let alice: Viewer;
  let bob: Viewer;
  let admin: Viewer;

  async function makeUser(name: string, role: "admin" | "member"): Promise<Viewer> {
    const teamId = await accounts.provisionTeam(null, `${name}-${suffix}`);
    const rows = await query<{ id: string }>(
      `INSERT INTO dashboard."user" (name, email, "emailVerified", role, "teamId") VALUES ($1, $2, false, $3, $4::uuid) RETURNING id`,
      [name, `${name}-v3-${suffix}@example.test`, role, teamId],
    );
    return { userId: rows[0].id, email: `${name}-v3-${suffix}@example.test`, name, role, teamId, twoFactorEnabled: false };
  }

  beforeAll(async () => {
    alice = await makeUser("alice", "member");
    bob = await makeUser("bob", "member");
    admin = await makeUser("root", "admin");
  });

  afterAll(async () => {
    await query(`DELETE FROM dashboard.setting`);
    await query(`DELETE FROM dashboard.alert_rule`);
    await pools().app.end();
  });

  it("lets only admins change settings, and audits it without secrets", async () => {
    await expect(settings.setSetting(alice, "retention", settings.defaultSettings().retention)).rejects.toBeInstanceOf(ForbiddenError);
    await settings.setSetting(admin, "alertWebhook", { url: "https://hooks.example.test/x", secret: "s3cret-value" });
    expect((await settings.getSettings()).alertWebhook.secret).toBe("s3cret-value");
    const log = await auditLog.listAuditLog(admin, { action: "settings." });
    expect(JSON.stringify(log)).not.toContain("s3cret-value");
    await expect(auditLog.listAuditLog(alice)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("applies invite policy and default limits, and tells the inviter", async () => {
    await settings.setSetting(admin, "invitePolicy", { defaultTtlHours: 24, requireEmail: true, defaultRole: "member" });
    await expect(accounts.createInvite(admin, { role: "member" })).rejects.toThrow(/must name/);
    await settings.setSetting(admin, "defaultLimits", { creditLimit: 250, creditLimitInterval: "week", concurrencyLimit: 3 });
    const email = `dana-${suffix}@example.test`;
    const invite = await accounts.createInvite(admin, { role: "member", email });
    await accounts.acceptInvite(invite.url.split("/invite/")[1], { name: "Dana", email, password: "correct-horse-battery" });
    const limits = await query<{ credit_limit: number; credit_limit_interval: string; concurrency_limit: number }>(
      `SELECT l.credit_limit, l.credit_limit_interval, l.concurrency_limit FROM community.team_limits l
       JOIN dashboard."user" u ON u."teamId" = l.team_id WHERE u.email = $1`,
      [email],
    );
    expect(limits[0]).toEqual({ credit_limit: 250, credit_limit_interval: "week", concurrency_limit: 3 });
    const inbox = await notifications.listNotifications(admin);
    expect(inbox.some((item) => item.kind === "invite" && item.title.includes("Dana"))).toBe(true);
  });

  it("keeps notifications private to their owner", async () => {
    await notifications.notify([bob.userId], { kind: "job", title: "bob's crawl finished", dedupeKey: `t-${suffix}` });
    // A repeated dedupe key does not create a second notification.
    expect(await notifications.notify([bob.userId], { kind: "job", title: "again", dedupeKey: `t-${suffix}` })).toBe(0);
    expect((await notifications.listNotifications(alice)).some((item) => item.title.includes("bob"))).toBe(false);
    const bobs = await notifications.listNotifications(bob);
    await notifications.markRead(alice, bobs.map((item) => item.id));
    expect(await notifications.unreadCount(bob)).toBe(1);
    await notifications.markRead(bob, "all");
    expect(await notifications.unreadCount(bob)).toBe(0);
  });

  it("keeps user webhooks private", async () => {
    const hook = await webhooks.createWebhook(bob, { url: "http://127.0.0.1:1/hook", events: ["crawl"] });
    expect(hook.secret).toMatch(/^whsec_/);
    expect(await webhooks.listWebhooks(alice)).toEqual([]);
    await expect(webhooks.testWebhook(alice, hook.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(webhooks.deleteWebhook(alice, hook.id)).rejects.toBeInstanceOf(ForbiddenError);
    const result = await webhooks.testWebhook(bob, hook.id);
    expect(result.success).toBe(false);
    const deliveries = await webhooks.recentDeliveries(bob);
    expect(deliveries[0]).toMatchObject({ source: "dashboard", event: "webhook.test", success: false });
    expect(await webhooks.recentDeliveries(alice)).toEqual([]);
    expect((await webhooks.defaultWebhookFor(bob, "crawl"))?.url).toBe("http://127.0.0.1:1/hook");
    expect(await webhooks.defaultWebhookFor(bob, "agent")).toBeNull();
  });

  it("scopes team blocklists and keeps the global list admin-only", async () => {
    await blocklist.saveBlocklist(alice, { teamId: alice.teamId! }, { blocklist: ["alice-blocked.test"], allowedKeywords: [] });
    expect((await blocklist.getTeamBlocklist(alice, alice.teamId!)).blocklist).toEqual(["alice-blocked.test"]);
    await expect(blocklist.getTeamBlocklist(alice, bob.teamId!)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(blocklist.saveBlocklist(alice, { teamId: bob.teamId! }, { blocklist: ["x.test"], allowedKeywords: [] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(blocklist.getGlobalBlocklist(alice)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(blocklist.saveBlocklist(alice, { global: true }, { blocklist: [], allowedKeywords: [] })).rejects.toBeInstanceOf(ForbiddenError);
    // The API reads the same rows: the team list is stored on the team's org.
    const rows = await query<{ data: { blocklist: string[] } }>(
      `SELECT b.data FROM public.blocklist b JOIN public.teams t ON t.org_id = b.org_id WHERE t.id = $1::uuid`,
      [alice.teamId],
    );
    expect(rows[0].data.blocklist).toEqual(["alice-blocked.test"]);
    const global = await blocklist.getGlobalBlocklist(admin);
    expect(Array.isArray(global.blocklist)).toBe(true);
  });

  it("fires a credit-limit alert to admins and the opted-in user", async () => {
    await expect(alerts.listRules(alice)).rejects.toBeInstanceOf(ForbiddenError);
    await users.setTeamLimits(admin, alice.userId, { creditLimit: 10, creditLimitInterval: "day", concurrencyLimit: null });
    await query(`INSERT INTO community.credit_usage (team_id, endpoint, credits) VALUES ($1::uuid, 'scrape', 9)`, [alice.teamId]);
    await alerts.saveRule(admin, null, {
      kind: "credit_limit",
      name: "Limit nearly used",
      threshold: 80,
      windowMinutes: 15,
      cooldownMinutes: 60,
      channels: { inApp: true, email: false, webhook: false },
      enabled: true,
    });
    expect(await alerts.evaluateAlerts()).toBeGreaterThanOrEqual(1);
    const events = await alerts.listEvents(admin);
    expect(events.some((event) => event.kind === "credit_limit" && event.message.includes(alice.email))).toBe(true);
    expect((await notifications.listNotifications(alice)).some((item) => item.kind === "limit")).toBe(true);
    // Cooldown: an immediate re-evaluation does not fire again.
    expect(await alerts.evaluateAlerts()).toBe(0);
  });

  it("records cleanup runs and purges only expired rows", async () => {
    await query(
      `INSERT INTO dashboard.playground_request (user_id, team_id, kind, request, created_at)
       VALUES ($1::uuid, $2::uuid, 'scrape', '{}'::jsonb, now() - interval '400 days'),
              ($1::uuid, $2::uuid, 'scrape', '{}'::jsonb, now())`,
      [alice.userId, alice.teamId],
    );
    await expect(cleanup.purgeNow(alice, "playground_history")).rejects.toBeInstanceOf(ForbiddenError);
    const result = await cleanup.purgeNow(admin, "playground_history");
    expect(result).toMatchObject({ status: "succeeded" });
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const left = await query<{ n: number }>(`SELECT count(*)::int AS n FROM dashboard.playground_request WHERE user_id = $1::uuid`, [alice.userId]);
    expect(left[0].n).toBe(1);
    const history = await cleanup.cleanupHistory();
    expect(history[0]).toMatchObject({ job: "playground_history", trigger: "manual", status: "succeeded" });
  });
});
