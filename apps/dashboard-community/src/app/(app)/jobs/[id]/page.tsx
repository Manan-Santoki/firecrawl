import { notFound } from "next/navigation";
import { JobDetail } from "@/components/jobs/job-detail";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ForbiddenError } from "@/lib/server/authz";
import { FirecrawlApiError } from "@/lib/server/firecrawl-api";
import { jobResults } from "@/lib/server/jobs";
import { requireViewer } from "@/lib/server/session";

export const metadata = { title: "Job" };

async function load(viewer: Awaited<ReturnType<typeof requireViewer>>, id: string, skip: number) {
  try {
    return { kind: "ok", results: await jobResults(viewer, id, skip) } as const;
  } catch (error) {
    if (error instanceof ForbiddenError) return { kind: "missing" } as const;
    if (error instanceof FirecrawlApiError) return { kind: "error", apiError: { status: error.status, message: error.message } } as const;
    throw error;
  }
}

export default async function JobPage({ params, searchParams }: PageProps<"/jobs/[id]">) {
  const viewer = await requireViewer();
  const { id } = await params;
  const skip = Math.max(0, Number((await searchParams).skip) || 0);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const loaded = await load(viewer, id, skip);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "error") {
    const gone = loaded.apiError.status === 404;
    return (
      <>
        <PageHeader title="Job" description={<span className="font-mono">{id}</span>} />
        <Alert variant={gone ? "warning" : "error"}>
          <AlertTitle>{gone ? "Results are no longer available" : "Could not load results"}</AlertTitle>
          <AlertDescription>
            {gone
              ? "Firecrawl keeps crawl results for 24 hours. The request is still in the request log."
              : loaded.apiError.message}
          </AlertDescription>
        </Alert>
      </>
    );
  }
  const { results } = loaded;
  return (
    <>
      <PageHeader
        title={results.kind === "crawl" ? "Crawl" : "Batch scrape"}
        description={<span className="font-mono">{id}</span>}
      />
      <JobDetail jobId={id} results={results} skip={skip} />
    </>
  );
}
