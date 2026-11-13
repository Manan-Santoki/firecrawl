"use client";

import { LayersIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { cancelJobAction } from "@/app/actions/jobs";
import { type DataColumn, DataTable } from "@/components/data-table";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { toastManager } from "@/components/ui/toast";
import { formatCredits, formatDateTime, formatNumber } from "@/lib/format";
import type { JobRow, JobStatus } from "@/lib/server/jobs";

const STATUS_VARIANT: Record<JobStatus, "success" | "info" | "warning" | "error" | "outline" | "secondary"> = {
  completed: "success",
  scraping: "info",
  cancelled: "warning",
  failed: "error",
  expired: "secondary",
  unknown: "outline",
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;
}

export function CancelJobButton({ jobId, size = "sm" }: { jobId: string; size?: "sm" | "default" }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="destructive-outline" size={size} data-testid="cancel-job" />}>
        Cancel
      </AlertDialogTrigger>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this job?</AlertDialogTitle>
          <AlertDialogDescription>
            Firecrawl stops scheduling new pages. Pages already scraped stay available until the job expires.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Keep running</AlertDialogClose>
          <Button
            variant="destructive"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await cancelJobAction(jobId);
                if (!result.ok) {
                  toastManager.add({ type: "error", title: "Cancel failed", description: result.error });
                  return;
                }
                toastManager.add({ type: "success", title: "Job cancelled" });
                router.refresh();
              })
            }
          >
            Cancel job
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export function JobsTable({ jobs, isAdmin }: { jobs: JobRow[]; isAdmin: boolean }) {
  const router = useRouter();
  const running = jobs.some((job) => job.status === "scraping");

  // Poll while anything is still running.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), 5_000);
    return () => clearInterval(timer);
  }, [running, router]);

  const columns: DataColumn<JobRow>[] = [
    {
      id: "job",
      header: "Job",
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          <Link href={`/jobs/${row.original.id}`} className="font-medium hover:underline">
            {row.original.target ?? row.original.id}
          </Link>
          <span className="font-mono text-muted-foreground text-xs">
            {row.original.kind === "crawl" ? "crawl" : "batch scrape"} · {row.original.id.slice(0, 8)}
          </span>
        </div>
      ),
    },
    ...(isAdmin
      ? ([{ id: "user", header: "User", cell: ({ row }) => row.original.userEmail ?? "–" }] satisfies DataColumn<JobRow>[])
      : []),
    { id: "status", header: "Status", cell: ({ row }) => <JobStatusBadge status={row.original.status} /> },
    {
      id: "progress",
      header: "Progress",
      cell: ({ row }) => {
        const { total, completed, failed } = row.original;
        if (total === null) return <span className="text-muted-foreground">–</span>;
        const done = (completed ?? 0) + (failed ?? 0);
        return (
          <div className="flex min-w-40 flex-col gap-1">
            <Progress value={total > 0 ? Math.round((done / total) * 100) : 0} />
            <span className="text-muted-foreground text-xs tabular-nums">
              {formatNumber(completed)} done · {formatNumber(failed)} failed · {formatNumber(total)} total
            </span>
          </div>
        );
      },
    },
    {
      id: "credits",
      header: "Credits",
      meta: { className: "text-right" },
      cell: ({ row }) => <span className="tabular-nums">{formatCredits(row.original.credits)}</span>,
    },
    {
      id: "created",
      header: "Started (UTC)",
      cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(row.original.createdAt)}</span>,
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: "text-right" },
      cell: ({ row }) => (
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" render={<Link href={`/jobs/${row.original.id}`} />}>
            Results
          </Button>
          {row.original.status === "scraping" && <CancelJobButton jobId={row.original.id} />}
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={jobs}
      getRowId={(job) => job.id}
      testId="jobs-table"
      empty={
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayersIcon />
            </EmptyMedia>
            <EmptyTitle>No crawls or batch scrapes yet</EmptyTitle>
            <EmptyDescription>Start one with POST /v2/crawl or /v2/batch/scrape.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      }
    />
  );
}
