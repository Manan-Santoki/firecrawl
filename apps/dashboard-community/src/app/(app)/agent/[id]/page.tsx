import { notFound } from "next/navigation";
import { AgentRunDetail } from "@/components/agent/agent-run-detail";
import { AgentUnavailable } from "@/components/agent/agent-unavailable";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AgentUnavailableError, agentDetail } from "@/lib/server/agent";
import { ForbiddenError } from "@/lib/server/authz";
import { FirecrawlApiError } from "@/lib/server/firecrawl-api";
import { requireViewer } from "@/lib/server/session";

export const metadata = { title: "Agent run" };

async function load(viewer: Awaited<ReturnType<typeof requireViewer>>, id: string) {
  try {
    return { kind: "ok", data: await agentDetail(viewer, id) } as const;
  } catch (error) {
    if (error instanceof ForbiddenError) return { kind: "missing" } as const;
    if (error instanceof AgentUnavailableError) return { kind: "unavailable", status: error.status } as const;
    if (error instanceof FirecrawlApiError) return { kind: "error", status: error.status, message: error.message } as const;
    throw error;
  }
}

export default async function AgentRunPage({ params }: PageProps<"/agent/[id]">) {
  const viewer = await requireViewer();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const loaded = await load(viewer, id);
  if (loaded.kind === "missing") notFound();
  const header = <PageHeader title="Agent run" description={<span className="font-mono">{id}</span>} />;
  if (loaded.kind === "unavailable") {
    return (
      <>
        {header}
        <AgentUnavailable status={loaded.status} />
      </>
    );
  }
  if (loaded.kind === "error") {
    return (
      <>
        {header}
        <Alert variant={loaded.status === 404 || loaded.status === 410 ? "warning" : "error"}>
          <AlertTitle>{loaded.status === 404 || loaded.status === 410 ? "This run is no longer available" : "Could not load the run"}</AlertTitle>
          <AlertDescription>{loaded.message}</AlertDescription>
        </Alert>
      </>
    );
  }
  return (
    <>
      {header}
      <AgentRunDetail id={id} status={loaded.data.status} trace={loaded.data.trace} />
    </>
  );
}
