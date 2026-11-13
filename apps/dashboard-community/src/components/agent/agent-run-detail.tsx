"use client";

import { DownloadIcon, SquareIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { agentSkillAction, cancelAgentAction } from "@/app/actions/build";
import { JsonBlock } from "@/components/result-viewer";
import { StatCard } from "@/components/stat-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatCredits, formatDateTime } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/notify";
import type { AgentStatus } from "@/lib/server/agent";

type Trace = { events: Array<Record<string, unknown>>; activeBrowserSessions?: { id: string; liveViewUrl: string }[] } | null;

function eventLabel(event: Record<string, unknown>): string {
  for (const key of ["type", "kind", "event", "name"]) {
    if (typeof event[key] === "string") return event[key] as string;
  }
  return "event";
}

function eventText(event: Record<string, unknown>): string {
  for (const key of ["message", "text", "summary", "url", "query", "tool"]) {
    if (typeof event[key] === "string") return event[key] as string;
  }
  return JSON.stringify(event).slice(0, 300);
}

function download(name: string, content: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function AgentRunDetail({ id, status, trace }: { id: string; status: AgentStatus; trace: Trace }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const running = status.status === "processing";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), 3_000);
    return () => clearInterval(timer);
  }, [running, router]);

  const live = trace?.activeBrowserSessions?.find((session) => session.liveViewUrl);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Status"
          value={
            <Badge variant={status.status === "completed" ? "success" : status.status === "failed" ? "error" : "info"} data-testid="agent-status">
              {status.status}
            </Badge>
          }
        />
        <StatCard label="Credits used" value={formatCredits(status.creditsUsed ?? null)} />
        <StatCard label="Expires (UTC)" value={<span className="text-base">{formatDateTime(status.expiresAt ?? null)}</span>} />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {status.data !== undefined && (
          <Button variant="outline" onClick={() => download(`agent-${id}.json`, JSON.stringify(status.data, null, 2), "application/json")}>
            <DownloadIcon /> Result JSON
          </Button>
        )}
        {status.status === "completed" && (
          <Button
            variant="outline"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await agentSkillAction(id);
                if (!result.ok) return toastError("Skill export unavailable", result.error);
                download(`${result.data.skill.name || "agent-skill"}.md`, result.data.skill.skillMd);
              })
            }
          >
            <DownloadIcon /> Export skill
          </Button>
        )}
        {running && (
          <Button
            variant="destructive-outline"
            loading={pending}
            data-testid="agent-cancel"
            onClick={() =>
              startTransition(async () => {
                const result = await cancelAgentAction(id);
                if (!result.ok) return toastError("Cancel failed", result.error);
                toastSuccess("Run cancelled");
                router.refresh();
              })
            }
          >
            <SquareIcon /> Cancel
          </Button>
        )}
      </div>
      {status.error && (
        <Alert variant="error">
          <AlertTitle>Run failed</AlertTitle>
          <AlertDescription>{status.error}</AlertDescription>
        </Alert>
      )}
      {live && (
        <Card>
          <CardHeader>
            <CardTitle>Live view</CardTitle>
          </CardHeader>
          <CardPanel>
            <iframe title="Agent live view" src={live.liveViewUrl} className="aspect-video w-full rounded-lg border" sandbox="allow-scripts allow-same-origin" />
          </CardPanel>
        </Card>
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Steps</CardTitle>
            <CardDescription>{trace ? `${trace.events.length} trace events` : "No trace available."}</CardDescription>
          </CardHeader>
          <CardPanel>
            <ScrollArea className="max-h-[32rem]">
              <ol className="flex flex-col gap-2" data-testid="agent-steps">
                {(trace?.events ?? []).map((event, index) => (
                  <li key={index} className="flex gap-3 rounded-lg border p-2 text-sm">
                    <Badge variant="outline" className="shrink-0">
                      {index + 1}. {eventLabel(event)}
                    </Badge>
                    <span className="break-words text-muted-foreground">{eventText(event)}</span>
                  </li>
                ))}
              </ol>
            </ScrollArea>
          </CardPanel>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
          </CardHeader>
          <CardPanel>
            {status.data !== undefined ? <JsonBlock value={status.data} testId="agent-result" /> : <p className="text-muted-foreground text-sm">The result appears when the run completes.</p>}
          </CardPanel>
        </Card>
      </div>
    </div>
  );
}
