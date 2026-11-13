"use client";

import { BellIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteAlertRuleAction, saveAlertRuleAction, saveSettingAction, testAlertWebhookAction } from "@/app/actions/operate";
import { type DataColumn, DataTable } from "@/components/data-table";
import { SelectField, SwitchField, TextField } from "@/components/playground/controls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { formatDateTime } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/notify";
import type { AlertEventRow, AlertKind, AlertRuleRow, RuleInput } from "@/lib/server/alerts";

const KINDS: Record<AlertKind, { label: string; unit: string; threshold: number }> = {
  error_rate: { label: "Error rate", unit: "% of requests with HTTP 5xx", threshold: 10 },
  queue_backlog: { label: "Queue backlog", unit: "queued scrape jobs", threshold: 500 },
  service_down: { label: "Service down", unit: "services down", threshold: 1 },
  credit_limit: { label: "Credit limit nearly used", unit: "% of a user's limit", threshold: 80 },
  agent_failures: { label: "Agent failures", unit: "failed agent starts", threshold: 3 },
};

const EMPTY: RuleInput = {
  kind: "error_rate",
  name: "High error rate",
  threshold: 10,
  windowMinutes: 15,
  cooldownMinutes: 60,
  channels: { inApp: true, email: false, webhook: false },
  enabled: true,
};

function RuleDialog({ rule, onClose }: { rule: AlertRuleRow | null; onClose: () => void }) {
  const router = useRouter();
  const [value, setValue] = useState<RuleInput>(rule ?? EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (patch: Partial<RuleInput>) => setValue((current) => ({ ...current, ...patch }));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New alert rule"}</DialogTitle>
          <DialogDescription>{KINDS[value.kind].unit}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <SelectField
            label="Condition"
            value={value.kind}
            options={Object.entries(KINDS).map(([kind, meta]) => ({ value: kind, label: meta.label }))}
            onChange={(kind) => set({ kind: kind as AlertKind, name: KINDS[kind as AlertKind].label, threshold: KINDS[kind as AlertKind].threshold })}
          />
          <TextField label="Name" value={value.name} onChange={(name) => set({ name })} testId="alert-name" />
          <div className="grid grid-cols-3 gap-3">
            <TextField label="Threshold" value={String(value.threshold)} onChange={(threshold) => set({ threshold: Number(threshold) || 0 })} testId="alert-threshold" />
            <TextField label="Window (min)" value={String(value.windowMinutes)} onChange={(windowMinutes) => set({ windowMinutes: Number(windowMinutes) || 1 })} />
            <TextField label="Cooldown (min)" value={String(value.cooldownMinutes)} onChange={(cooldownMinutes) => set({ cooldownMinutes: Number(cooldownMinutes) || 1 })} />
          </div>
          <SwitchField label="In-app notification" checked={value.channels.inApp} onChange={(inApp) => set({ channels: { ...value.channels, inApp } })} />
          <SwitchField label="Email administrators" checked={value.channels.email} onChange={(email) => set({ channels: { ...value.channels, email } })} />
          <SwitchField label="Signed webhook" checked={value.channels.webhook} onChange={(webhook) => set({ channels: { ...value.channels, webhook } })} />
          <SwitchField label="Enabled" checked={value.enabled} onChange={(enabled) => set({ enabled })} />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button
            loading={pending}
            data-testid="save-alert-rule"
            onClick={() =>
              startTransition(async () => {
                const result = await saveAlertRuleAction(rule?.id ?? null, value);
                if (!result.ok) return setError(result.error);
                toastSuccess("Rule saved");
                onClose();
                router.refresh();
              })
            }
          >
            Save rule
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function AlertsManager({
  rules,
  events,
  webhookUrl,
  webhookSecretSet,
  smtpConfigured,
}: {
  rules: AlertRuleRow[];
  events: AlertEventRow[];
  webhookUrl: string;
  webhookSecretSet: boolean;
  smtpConfigured: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<AlertRuleRow | null | "new">(null);
  const [url, setUrl] = useState(webhookUrl);
  const [secret, setSecret] = useState("");
  const [pending, startTransition] = useTransition();

  const ruleColumns: DataColumn<AlertRuleRow>[] = [
    {
      id: "name",
      header: "Rule",
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-medium">{row.original.name}</span>
          <span className="text-muted-foreground text-xs">
            {KINDS[row.original.kind].label}: ≥ {row.original.threshold} {KINDS[row.original.kind].unit}, {row.original.windowMinutes} min window
          </span>
        </div>
      ),
    },
    {
      id: "channels",
      header: "Channels",
      cell: ({ row }) => (
        <div className="flex gap-1">
          {row.original.channels.inApp && <Badge variant="outline">in-app</Badge>}
          {row.original.channels.email && <Badge variant="outline">email</Badge>}
          {row.original.channels.webhook && <Badge variant="outline">webhook</Badge>}
        </div>
      ),
    },
    { id: "enabled", header: "State", cell: ({ row }) => <Badge variant={row.original.enabled ? "success" : "secondary"}>{row.original.enabled ? "enabled" : "off"}</Badge> },
    { id: "fired", header: "Last fired (UTC)", cell: ({ row }) => formatDateTime(row.original.lastFiredAt) },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: "text-right" },
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="outline" onClick={() => setEditing(row.original)}>
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              startTransition(async () => {
                const result = await deleteAlertRuleAction(row.original.id);
                if (!result.ok) return toastError("Delete failed", result.error);
                router.refresh();
              })
            }
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  const eventColumns: DataColumn<AlertEventRow>[] = [
    { id: "when", header: "When (UTC)", cell: ({ row }) => <span className="whitespace-nowrap">{formatDateTime(row.original.createdAt)}</span> },
    { id: "severity", header: "Severity", cell: ({ row }) => <Badge variant={row.original.severity === "critical" ? "error" : "warning"}>{row.original.severity}</Badge> },
    { id: "message", header: "Alert", cell: ({ row }) => <span className="text-sm">{row.original.message}</span> },
    {
      id: "deliveries",
      header: "Delivered",
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.deliveries.map((delivery, index) => (
            <Badge key={index} variant={delivery.success ? "success" : "error"} title={delivery.detail}>
              {delivery.channel}
            </Badge>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {!smtpConfigured && (
        <Alert variant="info">
          <AlertDescription>Email delivery needs SMTP_HOST and SMTP_FROM on the dashboard; in-app and webhook delivery work without it.</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")} data-testid="new-alert-rule">
          <PlusIcon /> New rule
        </Button>
      </div>
      <DataTable
        columns={ruleColumns}
        data={rules}
        getRowId={(row) => row.id}
        testId="alert-rules"
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BellIcon />
              </EmptyMedia>
              <EmptyTitle>No alert rules</EmptyTitle>
              <EmptyDescription>Add a rule for error rate, queue backlog, services, credit limits or agent failures.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Alert webhook</CardTitle>
          <CardDescription>
            POSTs JSON signed with HMAC-SHA256 in <code>X-Firecrawl-Dashboard-Signature: t=&lt;unix&gt;,v1=&lt;hex of t.body&gt;</code>.
          </CardDescription>
        </CardHeader>
        <CardPanel className="grid gap-3 sm:grid-cols-2">
          <TextField label="URL" value={url} onChange={setUrl} placeholder="https://hooks.example.org/firecrawl" />
          <TextField label={webhookSecretSet ? "Signing secret (set; leave empty to keep)" : "Signing secret"} value={secret} onChange={setSecret} type="password" />
        </CardPanel>
        <CardFooter className="gap-2">
          <Button
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await saveSettingAction("alertWebhook", { url, secret: secret || (webhookSecretSet ? undefined : "") });
                if (!result.ok) return toastError("Not saved", result.error);
                toastSuccess("Alert webhook saved");
                setSecret("");
                router.refresh();
              })
            }
          >
            Save
          </Button>
          <Button
            variant="outline"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await testAlertWebhookAction();
                if (!result.ok) return toastError("Test failed", result.error);
                if (result.data.success) toastSuccess("Test delivered", `HTTP ${result.data.statusCode}`);
                else toastError("Test not delivered", result.data.error ?? undefined);
              })
            }
          >
            Send test
          </Button>
        </CardFooter>
      </Card>
      <section className="flex flex-col gap-3">
        <h2 className="font-heading font-semibold">History</h2>
        <DataTable columns={eventColumns} data={events} getRowId={(row) => String(row.id)} testId="alert-events" empty="No alerts have fired." />
      </section>
      {editing && <RuleDialog rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
