"use client";

import { PlusIcon, SendIcon, WebhookIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createWebhookAction, deleteWebhookAction, testWebhookAction, updateWebhookAction } from "@/app/actions/operate";
import { CopyButton } from "@/components/copy-button";
import { type DataColumn, DataTable } from "@/components/data-table";
import { CheckList, TextField } from "@/components/playground/controls";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatDateTime, formatDuration } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/notify";
import type { DeliveryRow, UserWebhook } from "@/lib/server/webhooks";

const EVENTS = [
  { value: "crawl", label: "Crawls" },
  { value: "batch_scrape", label: "Batch scrapes" },
  { value: "agent", label: "Agent runs" },
];

function CreateDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState(["crawl", "batch_scrape", "agent"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSecret(null);
          setUrl("");
          setError(null);
          router.refresh();
        }
      }}
    >
      <Button onClick={() => setOpen(true)} data-testid="new-webhook">
        <PlusIcon /> Add webhook
      </Button>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{secret ? "Copy the signing secret" : "Add a default webhook"}</DialogTitle>
          <DialogDescription>
            {secret ? "Shown once. Verify X-Firecrawl-Dashboard-Signature on test deliveries with it." : "Called when your jobs start, progress and finish."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {secret ? (
            <div className="flex gap-2">
              <Input readOnly value={secret} className="font-mono" data-testid="webhook-secret" />
              <CopyButton value={secret} iconOnly label="Copy secret" />
            </div>
          ) : (
            <>
              <TextField label="URL" value={url} onChange={setUrl} placeholder="https://example.org/hooks/firecrawl" testId="webhook-url" />
              <CheckList label="Use for" options={EVENTS} value={events} onChange={setEvents} />
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          {secret ? (
            <DialogClose render={<Button />}>Done</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
              <Button
                loading={pending}
                data-testid="save-webhook"
                onClick={() =>
                  startTransition(async () => {
                    const result = await createWebhookAction({ url, events });
                    if (!result.ok) return setError(result.error);
                    setSecret(result.data.secret);
                  })
                }
              >
                Add
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function WebhooksManager({ webhooks, deliveries }: { webhooks: UserWebhook[]; deliveries: DeliveryRow[] }) {
  const router = useRouter();
  const [lastTest, setLastTest] = useState<{ success: boolean; detail: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const columns: DataColumn<UserWebhook>[] = [
    {
      id: "url",
      header: "URL",
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-mono text-xs">{row.original.url}</span>
          <span className="text-muted-foreground text-xs">secret {row.original.secretHint}</span>
        </div>
      ),
    },
    { id: "events", header: "Used for", cell: ({ row }) => <div className="flex gap-1">{row.original.events.map((event) => <Badge key={event} variant="outline">{event}</Badge>)}</div> },
    {
      id: "enabled",
      header: "Enabled",
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled}
          aria-label="Enabled"
          onCheckedChange={(enabled) =>
            startTransition(async () => {
              const result = await updateWebhookAction(row.original.id, { enabled: Boolean(enabled) });
              if (!result.ok) return toastError("Not saved", result.error);
              router.refresh();
            })
          }
        />
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: "text-right" },
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            variant="outline"
            loading={pending}
            data-testid="test-webhook"
            onClick={() =>
              startTransition(async () => {
                const result = await testWebhookAction(row.original.id);
                if (!result.ok) return toastError("Test failed", result.error);
                const detail = result.data.success ? `HTTP ${result.data.statusCode} in ${formatDuration(result.data.latencyMs)}` : (result.data.error ?? "Failed");
                setLastTest({ success: result.data.success, detail });
                router.refresh();
              })
            }
          >
            <SendIcon /> Test
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              startTransition(async () => {
                const result = await deleteWebhookAction(row.original.id);
                if (!result.ok) return toastError("Delete failed", result.error);
                toastSuccess("Webhook removed");
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

  const deliveryColumns: DataColumn<DeliveryRow>[] = [
    { id: "when", header: "When (UTC)", cell: ({ row }) => <span className="whitespace-nowrap">{formatDateTime(row.original.createdAt)}</span> },
    { id: "source", header: "From", cell: ({ row }) => <Badge variant="outline">{row.original.source === "api" ? "Firecrawl API" : "dashboard test"}</Badge> },
    { id: "event", header: "Event", cell: ({ row }) => <span className="font-mono text-xs">{row.original.event}</span> },
    { id: "url", header: "URL", cell: ({ row }) => <span className="block max-w-xs truncate text-xs">{row.original.url}</span> },
    {
      id: "result",
      header: "Result",
      cell: ({ row }) => (
        <Badge variant={row.original.success ? "success" : "error"} title={row.original.error ?? undefined}>
          {row.original.statusCode ?? "error"}
        </Badge>
      ),
    },
    { id: "latency", header: "Latency", cell: ({ row }) => formatDuration(row.original.latencyMs) },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <CreateDialog />
      </div>
      {lastTest && (
        <Alert variant={lastTest.success ? "success" : "error"} data-testid="webhook-test-result">
          <AlertTitle>{lastTest.success ? "Test delivered" : "Test not delivered"}</AlertTitle>
          <AlertDescription>{lastTest.detail}</AlertDescription>
        </Alert>
      )}
      <DataTable
        columns={columns}
        data={webhooks}
        getRowId={(row) => row.id}
        testId="webhooks-table"
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <WebhookIcon />
              </EmptyMedia>
              <EmptyTitle>No webhooks</EmptyTitle>
              <EmptyDescription>Add a default URL to be called for your crawls, batch scrapes and agent runs.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
      <section className="flex flex-col gap-3">
        <h2 className="font-heading font-semibold">Recent deliveries</h2>
        <DataTable columns={deliveryColumns} data={deliveries} getRowId={(row) => `${row.source}-${row.createdAt}-${row.url}`} testId="webhook-deliveries" empty="No deliveries yet." />
      </section>
    </div>
  );
}
