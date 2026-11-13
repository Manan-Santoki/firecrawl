import { JobsTable } from "@/components/jobs/jobs-table";
import { PageHeader } from "@/components/page-header";
import { listJobs } from "@/lib/server/jobs";
import { requireViewer } from "@/lib/server/session";

export const metadata = { title: "Jobs" };

export default async function JobsPage() {
  const viewer = await requireViewer();
  const jobs = await listJobs(viewer, { days: 7 });
  return (
    <>
      <PageHeader
        title="Jobs"
        description="Crawls and batch scrapes from the last 7 days. Progress is read live from the queue; Firecrawl keeps job state for 24 hours."
      />
      <JobsTable jobs={jobs} isAdmin={viewer.role === "admin"} />
    </>
  );
}
