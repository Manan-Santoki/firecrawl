import { MonitorsTable } from "@/components/monitors/monitors-table";
import { PageHeader } from "@/components/page-header";
import { listMonitors } from "@/lib/server/monitors";
import { requireViewer } from "@/lib/server/session";

export const metadata = { title: "Monitors" };

export default async function MonitorsPage() {
  const viewer = await requireViewer();
  const monitors = await listMonitors(viewer);
  return (
    <>
      <PageHeader
        title="Monitors"
        description="Scheduled scrapes that record what changed between checks. Each check is billed to the monitor's owner."
      />
      <MonitorsTable monitors={monitors} isAdmin={viewer.role === "admin"} />
    </>
  );
}
