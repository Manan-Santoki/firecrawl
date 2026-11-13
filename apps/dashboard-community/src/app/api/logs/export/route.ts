import { ForbiddenError } from "@/lib/server/authz";
import { csvHeader, csvLine, exportLogs, parseLogFilters } from "@/lib/server/request-log";
import { getViewer } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** CSV of the filtered request log, always limited to the caller's scope. */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return new Response("Unauthorized", { status: 401 });
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const filters = parseLogFilters(params);
  const rows = exportLogs(viewer, filters);
  const encoder = new TextEncoder();

  // Fail before streaming starts so a forbidden filter answers 403, not a partial file.
  let first: IteratorResult<Awaited<ReturnType<typeof rows.next>>["value"]>;
  try {
    first = await rows.next();
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    throw error;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(csvHeader()));
      if (!first.done && first.value) controller.enqueue(encoder.encode(csvLine(first.value)));
      for await (const row of rows) controller.enqueue(encoder.encode(csvLine(row)));
      controller.close();
    },
  });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="firecrawl-requests-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
