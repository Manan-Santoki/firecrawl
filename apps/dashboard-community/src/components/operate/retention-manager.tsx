"use client";

import { Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { purgeNowAction, saveSettingAction } from "@/app/actions/operate";
import { type DataColumn, DataTable } from "@/components/data-table";
import { TextField } from "@/components/playground/controls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatNumber } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/notify";
import type { CleanupJob, CleanupRunRow } from "@/lib/server/cleanup";

type Retention = { requestLogDays: number; playgroundDays: number; alertEventDays: number; notificationDays: number };

const JOBS: { job: CleanupJob; label: string; field?: keyof Retention; size?: string }[] = [
  { job: "request_log", label: "Request log and credit ledger", field: "requestLogDays", size: "request_log" },
  { job: "playground_history", label: "Playground history", field: "playgroundDays", size: "playground" },
  { job: "alert_events", label: "Alert history", field: "alertEventDays", size: "alert_events" },
  { job: "notifications", label: "Notifications", field: "notificationDays", size: "notifications" },
  { job: "auth_records", label: "Expired sessions, verifications and stale invites" },
];

export function RetentionManager({
  retention,
  apiRetentionDays,
  runs,
  sizes,
}: {
  retention: Retention;
  apiRetentionDays: number;
  runs: CleanupRunRow[];
  sizes: Record<string, string | null>;
}) {
  const router = useRouter();
  const [value, setValue] = useState<Record<keyof Retention, string>>({
    requestLogDays: String(retention.requestLogDays),
    playgroundDays: String(retention.playgroundDays),
    alertEventDays: String(retention.alertEventDays),
    notificationDays: String(retention.notificationDays),
  });
  const [pending, startTransition] = useTransition();
  const lastRun = (job: CleanupJob) => runs.find((run) => run.job === job);

  const runColumns: DataColumn<CleanupRunRow>[] = [
    { id: "when", header: "Started (UTC)", cell: ({ row }) => formatDateTime(row.original.startedAt) },
    { id: "job", header: "Job", cell: ({ row }) => JOBS.find((job) => job.job === row.original.job)?.label ?? row.original.job },
    { id: "trigger", header: "Trigger", cell: ({ row }) => <Badge variant="outline">{row.original.trigger}</Badge> },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant={row.original.status === "succeeded" ? "success" : row.original.status === "failed" ? "error" : "secondary"} title={row.original.error ?? undefined}>
          {row.original.status}
        </Badge>
      ),
    },
    { id: "deleted", header: "Rows deleted", meta: { className: "text-right" }, cell: ({ row }) => formatNumber(row.original.deletedRows) },
  ];

  return (
    <div className="flex flex-col gap-4">
      {Number(value.requestLogDays) > apiRetentionDays && (
        <Alert variant="warning">
          <AlertDescription>
            The API also purges the request log after COMMUNITY_REQUEST_LOG_RETENTION_DAYS ({apiRetentionDays} days); raise it on the API to keep rows longer.
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Retention periods</CardTitle>
          <CardDescription>The credit ledger is always kept at least 62 days so monthly limits see a full window.</CardDescription>
        </CardHeader>
        <CardPanel className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {JOBS.filter((job) => job.field).map((job) => (
            <TextField
              key={job.job}
              label={`${job.label} (days)`}
              value={value[job.field!]}
              onChange={(next) => setValue({ ...value, [job.field!]: next })}
              testId={`retention-${job.job}`}
              description={job.size ? `${formatNumber(Number(sizes[job.size] ?? 0))} rows stored` : undefined}
            />
          ))}
        </CardPanel>
        <CardFooter>
          <Button
            loading={pending}
            data-testid="save-retention"
            onClick={() =>
              startTransition(async () => {
                const result = await saveSettingAction("retention", Object.fromEntries(Object.entries(value).map(([key, days]) => [key, Number(days)])));
                if (!result.ok) return toastError("Not saved", result.error);
                toastSuccess("Retention saved");
                router.refresh();
              })
            }
          >
            Save retention
          </Button>
        </CardFooter>
      </Card>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {JOBS.map((job) => {
          const run = lastRun(job.job);
          return (
            <Card key={job.job} data-testid={`cleanup-${job.job}`}>
              <CardHeader>
                <CardTitle className="text-base">{job.label}</CardTitle>
                <CardDescription>
                  {run ? (
                    <>
                      Last run {formatDateTime(run.startedAt)} UTC: <Badge variant={run.status === "succeeded" ? "success" : "error"}>{run.status}</Badge>{" "}
                      {run.deletedRows !== null && `${formatNumber(run.deletedRows)} rows`}
                    </>
                  ) : (
                    "Not run yet"
                  )}
                </CardDescription>
              </CardHeader>
              <CardFooter>
                <Button
                  variant="destructive-outline"
                  size="sm"
                  loading={pending}
                  data-testid={`purge-${job.job}`}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await purgeNowAction(job.job);
                      if (!result.ok) return toastError("Purge failed", result.error);
                      if (result.data.status === "succeeded") toastSuccess("Purged", `${result.data.deleted} rows deleted`);
                      else toastError("Purge failed", result.data.error);
                      router.refresh();
                    })
                  }
                >
                  <Trash2Icon /> Purge now
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </div>
      <section className="flex flex-col gap-3">
        <h2 className="font-heading font-semibold">Cleanup history</h2>
        <DataTable columns={runColumns} data={runs} getRowId={(row) => `${row.job}-${row.startedAt}`} testId="cleanup-runs" empty="No cleanup has run yet." />
      </section>
    </div>
  );
}
