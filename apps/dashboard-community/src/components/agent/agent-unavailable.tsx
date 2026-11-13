import { BotIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

export function AgentUnavailable({ status }: { status?: number }) {
  return (
    <Empty data-testid="agent-unavailable">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BotIcon />
        </EmptyMedia>
        <EmptyTitle>Agent backend not available</EmptyTitle>
        <EmptyDescription>
          This deployment&apos;s API answered{status ? ` HTTP ${status}` : ""} for the agent endpoints. Enable the community
          agent service (community/docker-compose.agent.yaml) to start and inspect agent runs here.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
