import { query } from "@/lib/server/db";

export const dynamic = "force-dynamic";

/** Liveness for container health checks: the process answers and the database is reachable. */
export async function GET() {
  try {
    await query("SELECT 1");
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "database unavailable" }, { status: 503 });
  }
}
