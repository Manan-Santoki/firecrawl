/**
 * Runs against a real PostgreSQL migrated with community/migrations (all
 * versions through 100-community-metering) and seeded with 090-seed.sql.
 * Skipped unless COMMUNITY_TEST_DATABASE_URL points at such a database.
 */
import { randomUUID } from "node:crypto";

const DATABASE_URL = process.env.COMMUNITY_TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("community metering against PostgreSQL", () => {
  // Modules are imported after the environment is set, so they stay untyped.
  let mod: { metering: any; requestLog: any; db: any; sql: any };
  const orgId = randomUUID();
  const teamId = randomUUID();
  let keyId: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    process.env.DATABASE_REPLICA_URL = DATABASE_URL;
    process.env.USE_DB_AUTHENTICATION = "true";
    process.env.SELF_HOSTED_BILLING_MODE = "metered";
    process.env.COMMUNITY_REQUEST_LOG_RETENTION_DAYS = "30";
    vi.resetModules();
    const { db } = await import("../../../db/connection.js");
    const { sql } = (await import("drizzle-orm")) as any;
    mod = {
      metering: await import("../metering.js"),
      requestLog: await import("../request-log.js"),
      db,
      sql,
    };
    await db.execute(
      sql`INSERT INTO public.organizations (id, name) VALUES (${orgId}::uuid, 'test')`,
    );
    await db.execute(
      sql`INSERT INTO public.teams (id, name, org_id) VALUES (${teamId}::uuid, 'test', ${orgId}::uuid)`,
    );
    const key = await db.execute(
      sql`INSERT INTO public.api_keys (name, team_id) VALUES ('k', ${teamId}::uuid) RETURNING id`,
    );
    keyId = Number((key.rows[0] as { id: string }).id);
  });

  const settle = () => new Promise(resolve => setTimeout(resolve, 300));

  it("records charges and refuses once the team window is spent", async () => {
    const { db, sql, metering } = mod;
    expect(
      await metering.checkCommunityCredits({ teamId, value: 5 }),
    ).toBeNull();

    await db.execute(
      sql`INSERT INTO community.team_limits (team_id, credit_limit, credit_limit_interval)
          VALUES (${teamId}::uuid, 10, 'day')`,
    );
    metering.recordCommunityCreditUsage({
      teamId,
      value: 8,
      properties: { endpoint: "scrape", apiKeyId: keyId, jobId: "job-1" },
    });
    await settle();

    expect(
      await metering.checkCommunityCredits({
        teamId,
        value: 2,
        properties: { apiKeyId: keyId },
      }),
    ).toEqual({ allowed: true, remaining: 2 });
    expect(
      await metering.checkCommunityCredits({
        teamId,
        value: 3,
        properties: { apiKeyId: keyId },
      }),
    ).toEqual({ allowed: false, remaining: 2 });

    const ledger = await db.execute(
      sql`SELECT endpoint, job_id, api_key_id, credits FROM community.credit_usage WHERE team_id = ${teamId}::uuid`,
    );
    expect(ledger.rows).toEqual([
      {
        endpoint: "scrape",
        job_id: "job-1",
        api_key_id: String(keyId),
        credits: "8.00",
      },
    ]);
  });

  it("enforces a per-key limit independently of the team", async () => {
    const { db, sql, metering } = mod;
    await db.execute(
      sql`UPDATE community.team_limits SET credit_limit = 1000 WHERE team_id = ${teamId}::uuid`,
    );
    await db.execute(
      sql`UPDATE public.api_keys SET credit_limit = 8, credit_limit_interval = 'month' WHERE id = ${keyId}`,
    );
    metering.recordCommunityCreditUsage({
      teamId,
      value: 0.5,
      properties: { endpoint: "map", apiKeyId: keyId },
    });
    await settle();
    const refused = await metering.checkCommunityCredits({
      teamId,
      value: 1,
      properties: { apiKeyId: String(keyId) },
    });
    expect(refused?.allowed).toBe(false);
    expect(refused?.remaining).toBeGreaterThan(900);
  });

  it("reads the operator concurrency for the team", async () => {
    const { db, sql, metering } = mod;
    await db.execute(
      sql`UPDATE community.team_limits SET concurrency_limit = 3 WHERE team_id = ${teamId}::uuid`,
    );
    const otherTeam = randomUUID();
    expect(await metering.getCommunityConcurrencyLimit(teamId)).toBe(3);
    expect(await metering.getCommunityConcurrencyLimit(otherTeam)).toBeNull();
  });

  it("purges request-log rows past retention and keeps recent ones", async () => {
    const { db, sql, requestLog } = mod;
    await db.execute(sql`
      INSERT INTO community.request_log (created_at, team_id, method, endpoint, path, status_code, duration_ms)
      VALUES (now() - interval '45 days', ${teamId}::uuid, 'POST', '/v2/scrape', '/v2/scrape', 200, 5),
             (now() - interval '1 day', ${teamId}::uuid, 'POST', '/v2/scrape', '/v2/scrape', 200, 5)
    `);
    const result = await requestLog.purgeCommunityRequestLog();
    expect(result?.requestLogDeleted).toBeGreaterThanOrEqual(1);
    const remaining = await db.execute(
      sql`SELECT count(*)::int AS n FROM community.request_log WHERE team_id = ${teamId}::uuid`,
    );
    expect((remaining.rows[0] as { n: number }).n).toBe(1);
  });
});
