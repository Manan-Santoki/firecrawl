"use client";

import { BellOffIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { markNotificationsReadAction, savePreferencesAction } from "@/app/actions/operate";
import { type DataColumn, DataTable } from "@/components/data-table";
import { SwitchField } from "@/components/playground/controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { formatDateTime } from "@/lib/format";
import { toastError } from "@/lib/notify";
import type { NotificationRow, Preferences } from "@/lib/server/notifications";

export function NotificationsView({ items, preferences }: { items: NotificationRow[]; preferences: Preferences }) {
  const router = useRouter();
  const [prefs, setPrefs] = useState(preferences);
  const [pending, startTransition] = useTransition();

  const savePrefs = (next: Preferences) => {
    setPrefs(next);
    startTransition(async () => {
      const result = await savePreferencesAction(next);
      if (!result.ok) toastError("Not saved", result.error);
    });
  };

  const columns: DataColumn<NotificationRow>[] = [
    { id: "when", header: "When (UTC)", cell: ({ row }) => <span className="whitespace-nowrap">{formatDateTime(row.original.createdAt)}</span> },
    { id: "kind", header: "Type", cell: ({ row }) => <Badge variant={row.original.kind === "alert" ? "warning" : "outline"}>{row.original.kind}</Badge> },
    {
      id: "title",
      header: "Notification",
      cell: ({ row }) => (
        <div className="flex flex-col">
          {row.original.link ? (
            <Link href={row.original.link} className={row.original.readAt ? "hover:underline" : "font-medium hover:underline"}>
              {row.original.title}
            </Link>
          ) : (
            <span className={row.original.readAt ? undefined : "font-medium"}>{row.original.title}</span>
          )}
          {row.original.body && <span className="text-muted-foreground text-xs">{row.original.body}</span>}
        </div>
      ),
    },
    { id: "state", header: "State", cell: ({ row }) => (row.original.readAt ? <span className="text-muted-foreground text-sm">read</span> : <Badge variant="info">new</Badge>) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Preferences</CardTitle>
          <CardDescription>Choose what the dashboard tells you about.</CardDescription>
        </CardHeader>
        <CardPanel className="grid gap-3 md:grid-cols-2">
          <SwitchField
            label="My credit-limit alerts"
            description="When you have used most of your credit limit."
            checked={prefs.limitAlerts}
            onChange={(limitAlerts) => savePrefs({ ...prefs, limitAlerts })}
          />
          <SwitchField
            label="Finished jobs"
            description="When one of your crawls or batch scrapes completes, fails or is cancelled."
            checked={prefs.jobNotifications}
            onChange={(jobNotifications) => savePrefs({ ...prefs, jobNotifications })}
          />
        </CardPanel>
      </Card>
      <div className="flex justify-end">
        <Button
          variant="outline"
          loading={pending}
          disabled={!items.some((item) => !item.readAt)}
          onClick={() =>
            startTransition(async () => {
              await markNotificationsReadAction("all");
              router.refresh();
            })
          }
        >
          Mark all read
        </Button>
      </div>
      <DataTable
        columns={columns}
        data={items}
        getRowId={(row) => String(row.id)}
        testId="notifications-table"
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BellOffIcon />
              </EmptyMedia>
              <EmptyTitle>No notifications</EmptyTitle>
              <EmptyDescription>Alerts, accepted invites and finished jobs show up here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
    </div>
  );
}
