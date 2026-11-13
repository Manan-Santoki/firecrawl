import { LogsView } from "@/components/logs/logs-view";
import { PageHeader } from "@/components/page-header";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { listApiKeys } from "@/lib/server/api-keys";
import { ForbiddenError } from "@/lib/server/authz";
import { listEndpoints, PAGE_SIZE, parseLogFilters, searchLogs } from "@/lib/server/request-log";
import { requireViewer } from "@/lib/server/session";
import { listUserOptions } from "@/lib/server/users";

export const metadata = { title: "Request log" };

export default async function LogsPage({ searchParams }: PageProps<"/logs">) {
  const viewer = await requireViewer();
  const filters = parseLogFilters(await searchParams);
  let result;
  try {
    result = await searchLogs(viewer, filters);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Not available</EmptyTitle>
            <EmptyDescription>You can only view your own requests.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    throw error;
  }
  const [endpoints, keys, users] = await Promise.all([
    listEndpoints(viewer),
    listApiKeys(viewer),
    listUserOptions(viewer),
  ]);

  return (
    <>
      <PageHeader
        title="Request log"
        description="Every API request with its status, latency, credits and job. Kept for the configured retention period (30 days by default)."
      />
      <LogsView
        rows={result.rows}
        total={result.total}
        page={filters.page}
        pageSize={PAGE_SIZE}
        filters={filters}
        endpoints={endpoints}
        keys={keys.map((key) => ({ value: String(key.id), label: `${key.name || "Unnamed"} (${key.masked})` }))}
        users={users.map((user) => ({ value: user.teamId, label: user.label }))}
        isAdmin={viewer.role === "admin"}
      />
    </>
  );
}
