import { notFound } from "next/navigation";
import { MonitorDetailView } from "@/components/monitors/monitor-detail";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ForbiddenError } from "@/lib/server/authz";
import { FirecrawlApiError } from "@/lib/server/firecrawl-api";
import { getMonitor } from "@/lib/server/monitors";
import { requireViewer } from "@/lib/server/session";

export const metadata = { title: "Monitor" };

async function load(viewer: Awaited<ReturnType<typeof requireViewer>>, id: string) {
  try {
    return { kind: "ok", data: await getMonitor(viewer, id) } as const;
  } catch (error) {
    if (error instanceof ForbiddenError) return { kind: "missing" } as const;
    if (error instanceof FirecrawlApiError) return { kind: "error", message: error.message } as const;
    throw error;
  }
}

export default async function MonitorPage({ params }: PageProps<"/monitors/[id]">) {
  const viewer = await requireViewer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const loaded = await load(viewer, id);
  if (loaded.kind === "missing") notFound();
  if (loaded.kind === "error") {
    return (
      <Alert variant="error">
        <AlertTitle>Could not load the monitor</AlertTitle>
        <AlertDescription>{loaded.message}</AlertDescription>
      </Alert>
    );
  }
  const { monitor, checks } = loaded.data;
  return (
    <>
      <PageHeader title={monitor.name} description={`${monitor.schedule.cron} (${monitor.schedule.timezone}) · ${monitor.status}`} />
      <MonitorDetailView monitor={monitor} checks={checks} />
    </>
  );
}
