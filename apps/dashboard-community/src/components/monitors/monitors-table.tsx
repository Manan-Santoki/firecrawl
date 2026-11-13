"use client";

import { EllipsisIcon, PlusIcon, RadarIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { deleteMonitorAction, runMonitorAction, setMonitorStatusAction } from "@/app/actions/build";
import { type DataColumn, DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Menu, MenuItem, MenuLinkItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { formatDateTime } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/notify";
import type { MonitorRow } from "@/lib/server/monitors";
import { EMPTY_MONITOR, MonitorDialog } from "./monitor-form";

export function useMonitorActions() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) =>
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) return toastError("Action failed", result.error);
      toastSuccess(success);
      router.refresh();
    });
  return { pending, act };
}

export function MonitorsTable({ monitors, isAdmin }: { monitors: MonitorRow[]; isAdmin: boolean }) {
  const { act } = useMonitorActions();
  const columns: DataColumn<MonitorRow>[] = [
    {
      id: "name",
      header: "Monitor",
      cell: ({ row }) => (
        <div className="flex flex-col">
          <Link href={`/monitors/${row.original.id}`} className="font-medium hover:underline">
            {row.original.name}
          </Link>
          <span className="text-muted-foreground text-xs">
            {row.original.targetCount} target{row.original.targetCount === 1 ? "" : "s"} · {row.original.cron} {row.original.timezone}
          </span>
        </div>
      ),
    },
    ...(isAdmin ? ([{ id: "user", header: "User", cell: ({ row }) => row.original.userEmail ?? "–" }] satisfies DataColumn<MonitorRow>[]) : []),
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => <Badge variant={row.original.status === "active" ? "success" : "secondary"}>{row.original.status}</Badge>,
    },
    {
      id: "last",
      header: "Last check",
      cell: ({ row }) => {
        const summary = row.original.lastSummary;
        return (
          <div className="flex flex-col text-sm">
            <span className="text-muted-foreground">{formatDateTime(row.original.lastRunAt)}</span>
            {summary && (
              <span className="text-xs">
                {summary.changed ?? 0} changed · {summary.new ?? 0} new · {summary.removed ?? 0} removed
              </span>
            )}
          </div>
        );
      },
    },
    { id: "next", header: "Next run (UTC)", cell: ({ row }) => <span className="text-muted-foreground">{formatDateTime(row.original.nextRunAt)}</span> },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: "w-10 text-right" },
      cell: ({ row }) => (
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.original.name}`} />}>
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuLinkItem render={<Link href={`/monitors/${row.original.id}`} />}>Checks and diffs</MenuLinkItem>
            <MenuItem onClick={() => act(() => runMonitorAction(row.original.id), "Check started")}>Run now</MenuItem>
            <MenuItem
              onClick={() =>
                act(
                  () => setMonitorStatusAction(row.original.id, row.original.status === "active" ? "paused" : "active"),
                  row.original.status === "active" ? "Monitor paused" : "Monitor resumed",
                )
              }
            >
              {row.original.status === "active" ? "Pause" : "Resume"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => act(() => deleteMonitorAction(row.original.id), "Monitor deleted")}>
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <MonitorDialog
          monitorId={null}
          initial={EMPTY_MONITOR}
          trigger={
            <Button data-testid="new-monitor">
              <PlusIcon /> New monitor
            </Button>
          }
        />
      </div>
      <DataTable
        columns={columns}
        data={monitors}
        getRowId={(row) => row.id}
        testId="monitors-table"
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RadarIcon />
              </EmptyMedia>
              <EmptyTitle>No monitors yet</EmptyTitle>
              <EmptyDescription>Create one to get notified when pages change.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
    </div>
  );
}
