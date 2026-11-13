import { AgentRuns } from "@/components/agent/agent-runs";
import { PageHeader } from "@/components/page-header";
import { listAgentRuns } from "@/lib/server/agent";
import { requireViewer } from "@/lib/server/session";

export const metadata = { title: "Agent runs" };

export default async function AgentPage() {
  const viewer = await requireViewer();
  const runs = await listAgentRuns(viewer);
  return (
    <>
      <PageHeader
        title="Agent runs"
        description="Multi-step research runs. Start one, follow its steps live, and export the result or a reusable skill."
      />
      <AgentRuns runs={runs} isAdmin={viewer.role === "admin"} />
    </>
  );
}
