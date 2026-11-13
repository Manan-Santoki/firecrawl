import "server-only";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env";

type Pools = { app: Pool; nuq: Pool | null };

const globalForPools = globalThis as unknown as { __dashboardPools?: Pools };

function makePools(): Pools {
  const { DATABASE_URL, NUQ_DATABASE_URL } = env();
  // Better Auth tables live in the `dashboard` schema; Firecrawl tables stay
  // in `public` and community metering in `community`. Every query below
  // qualifies its schema explicitly, the search path only serves Better Auth.
  const app = new Pool({
    connectionString: DATABASE_URL,
    application_name: "firecrawl-dashboard",
    max: 10,
    options: "-c search_path=dashboard,public",
  });
  const nuq = NUQ_DATABASE_URL
    ? new Pool({
        connectionString: NUQ_DATABASE_URL,
        application_name: "firecrawl-dashboard",
        max: 3,
      })
    : null;
  return { app, nuq };
}

export function pools(): Pools {
  globalForPools.__dashboardPools ??= makePools();
  return globalForPools.__dashboardPools;
}

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pools().app.query<T>(text, params);
  return result.rows;
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pools().app.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
