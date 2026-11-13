import { ForbiddenError } from "@/lib/server/authz";
import { FirecrawlApiError } from "@/lib/server/firecrawl-api";
import { jobResults } from "@/lib/server/jobs";
import { getViewer } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** Every page of a crawl or batch scrape as one JSON array, fetched as the job's owner. */
export async function GET(_request: Request, { params }: RouteContext<"/api/jobs/[id]/download">) {
  const viewer = await getViewer();
  if (!viewer) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });

  const pages: unknown[] = [];
  try {
    let skip = 0;
    for (let i = 0; i < 400; i++) {
      const page = await jobResults(viewer, id, skip);
      pages.push(...page.data);
      if (!page.next || page.data.length === 0) break;
      skip += page.data.length;
    }
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response("Not found", { status: 404 });
    if (error instanceof FirecrawlApiError) return new Response(error.message, { status: error.status });
    throw error;
  }
  return new Response(JSON.stringify(pages, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="job-${id}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
