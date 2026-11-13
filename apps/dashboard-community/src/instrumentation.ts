/** Starts the dashboard's background scheduler once per server process. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.DATABASE_URL) return;
  const { startScheduler } = await import("./lib/server/scheduler");
  startScheduler();
}
