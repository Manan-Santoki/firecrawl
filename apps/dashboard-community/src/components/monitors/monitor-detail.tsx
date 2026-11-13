"use client";

import { PlayIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { checkDetailAction, runMonitorAction } from "@/app/actions/build";
import { type DataColumn, DataTable } from "@/components/data-table";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { formatCredits, formatDateTime } from "@/lib/format";
import { toastError } from "@/lib/notify";
import type { CheckPage, MonitorCheck, MonitorDetail } from "@/lib/server/monitors";
import { diffLines } from "@/lib/diff";
import { cn } from "@/lib/utils";
import { EMPTY_MONITOR, MonitorDialog, type MonitorFormValue } from "./monitor-form";
import { useMonitorActions } from "./monitors-table";

const PAGE_VARIANT: Record<CheckPage["status"], "success" | "info" | "warning" | "error" | "secondary"> = {
  same: "secondary",
  new: "info",
  changed: "warning",
  removed: "error",
  error: "error",
};

/** Unified diff with added and removed lines tinted with the success/destructive tokens. */
export function DiffView({ text }: { text: string }) {
  return (
    <ScrollArea className="max-h-[36rem] rounded-lg border">
      <pre className="font-mono text-xs" data-testid="diff-view">
        {diffLines(text).map((line, index) => (
          <div
            key={index}
            className={cn(
              "whitespace-pre-wrap break-all px-3",
              line.kind === "add" && "bg-success/12 text-success-foreground",
              line.kind === "del" && "bg-destructive/12 text-destructive-foreground",
              line.kind === "hunk" && "bg-info/10 text-info-foreground",
            )}
          >
            {line.text || " "}
          </div>
        ))}
      </pre>
    </ScrollArea>
  );
}

function toForm(monitor: MonitorDetail): MonitorFormValue {
  const scrapeTarget = monitor.targets.find((target) => target.type === "scrape");
  const urls = Array.isArray(scrapeTarget?.urls) ? (scrapeTarget!.urls as string[]) : [];
  const formats = ((scrapeTarget?.scrapeOptions as { formats?: unknown[] } | undefined)?.formats ?? ["markdown"]).filter(
    (format): format is string => typeof format === "string",
  );
  const webhook = monitor.webhook;
  return {
    ...EMPTY_MONITOR,
    name: monitor.name,
    scheduleMode: "cron",
    schedule: monitor.schedule.cron,
    timezone: monitor.schedule.timezone,
    urls: urls.join("\n"),
    formats: formats.length ? formats : ["markdown"],
    webhookUrl: typeof webhook === "string" ? webhook : ((webhook as { url?: string } | null)?.url ?? ""),
    retentionDays: String(monitor.retentionDays),
    goal: monitor.goal ?? "",
  };
}

export function MonitorDetailView({ monitor, checks }: { monitor: MonitorDetail; checks: MonitorCheck[] }) {
  const { act, pending } = useMonitorActions();
  const [selected, setSelected] = useState<(MonitorCheck & { pages?: CheckPage[] }) | null>(null);
  const [page, setPage] = useState<CheckPage | null>(null);
  const [loading, startTransition] = useTransition();

  const checkColumns: DataColumn<MonitorCheck>[] = [
    { id: "when", header: "Started (UTC)", cell: ({ row }) => formatDateTime(row.original.startedAt ?? row.original.createdAt) },
    { id: "trigger", header: "Trigger", cell: ({ row }) => <Badge variant="outline">{row.original.trigger}</Badge> },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant={row.original.status === "completed" ? "success" : row.original.status === "failed" ? "error" : "info"}>
          {row.original.status}
        </Badge>
      ),
    },
    {
      id: "summary",
      header: "Pages",
      cell: ({ row }) => {
        const s = row.original.summary;
        return s ? (
          <span className="text-sm">
            {s.totalPages} total · {s.changed} changed · {s.new} new · {s.removed} removed · {s.error} errors
          </span>
        ) : (
          "–"
        );
      },
    },
    { id: "credits", header: "Credits", meta: { className: "text-right" }, cell: ({ row }) => formatCredits(row.original.actualCredits) },
  ];

  const pageColumns: DataColumn<CheckPage>[] = [
    { id: "url", header: "Page", cell: ({ row }) => <span className="block max-w-96 truncate">{row.original.url}</span> },
    { id: "status", header: "Change", cell: ({ row }) => <Badge variant={PAGE_VARIANT[row.original.status]}>{row.original.status}</Badge> },
    {
      id: "judge",
      header: "Judgment",
      cell: ({ row }) =>
        row.original.judgment ? (
          <span className="text-sm">{row.original.judgment.meaningful ? "Meaningful" : "Not meaningful"}</span>
        ) : (
          "–"
        ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Next run (UTC)" value={<span className="text-base">{formatDateTime(monitor.nextRunAt)}</span>} />
        <StatCard label="Last run (UTC)" value={<span className="text-base">{formatDateTime(monitor.lastRunAt)}</span>} />
        <StatCard label="Checks kept" value={`${monitor.retentionDays} days`} />
        <StatCard label="Est. credits / month" value={formatCredits(monitor.estimatedCreditsPerMonth)} />
      </div>
      <div className="flex justify-end gap-2">
        <MonitorDialog monitorId={monitor.id} initial={toForm(monitor)} trigger={<Button variant="outline">Edit</Button>} />
        <Button loading={pending} onClick={() => act(() => runMonitorAction(monitor.id), "Check started")} data-testid="run-monitor">
          <PlayIcon /> Run now
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Check history</CardTitle>
          <CardDescription>Select a check to see each page and its diff against the previous check.</CardDescription>
        </CardHeader>
        <CardPanel>
          <DataTable
            columns={checkColumns}
            data={checks}
            getRowId={(check) => check.id}
            testId="monitor-checks"
            onRowClick={(check) => {
              setSelected(check);
              startTransition(async () => {
                const result = await checkDetailAction(monitor.id, check.id);
                if (!result.ok) return toastError("Could not load check", result.error);
                setSelected(result.data);
              });
            }}
            empty="No checks yet. Use Run now to start one."
          />
        </CardPanel>
      </Card>
      <Sheet open={selected !== null} onOpenChange={(open) => !open && (setSelected(null), setPage(null))}>
        <SheetPopup className="sm:max-w-4xl">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>Check {formatDateTime(selected.startedAt ?? selected.createdAt)} UTC</SheetTitle>
                <SheetDescription>{selected.status}</SheetDescription>
              </SheetHeader>
              <SheetPanel className="flex flex-col gap-4">
                {loading || !selected.pages ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Spinner className="size-4" /> Loading pages…
                  </div>
                ) : (
                  <DataTable
                    columns={pageColumns}
                    data={selected.pages}
                    getRowId={(row) => row.id}
                    onRowClick={setPage}
                    empty="This check has no pages."
                  />
                )}
                {page && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="truncate text-base">{page.url}</CardTitle>
                      {page.judgment && <CardDescription>{page.judgment.reason}</CardDescription>}
                    </CardHeader>
                    <CardPanel>
                      {page.diff?.text ? (
                        <DiffView text={page.diff.text} />
                      ) : (
                        <Empty>
                          <EmptyHeader>
                            <EmptyTitle className="text-base">No diff</EmptyTitle>
                            <EmptyDescription>
                              {page.status === "same" ? "The page did not change." : page.error ?? "This page has no text diff."}
                            </EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      )}
                    </CardPanel>
                  </Card>
                )}
              </SheetPanel>
            </>
          )}
        </SheetPopup>
      </Sheet>
    </div>
  );
}
