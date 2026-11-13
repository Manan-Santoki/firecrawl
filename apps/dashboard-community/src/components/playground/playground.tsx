"use client";

import { HistoryIcon, PlayIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { deleteHistoryAction, pollPlaygroundAction, runPlaygroundAction } from "@/app/actions/playground";
import { CopyButton } from "@/components/copy-button";
import { type DataColumn, DataTable } from "@/components/data-table";
import { ResultViewer } from "@/components/result-viewer";
import { type Option, SimpleSelect } from "@/components/simple-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { formatDateTime, formatDuration, statusTone } from "@/lib/format";
import { buildBody, DEFAULT_FORM, type FormState } from "@/lib/playground-body";
import { ASYNC_KINDS, type PlaygroundKind, snippets } from "@/lib/playground-shared";
import type { HistoryItem } from "@/lib/server/playground";
import { KindFields, ScrapeOptions } from "./options-form";

const KINDS: { value: PlaygroundKind; label: string }[] = [
  { value: "scrape", label: "Scrape" },
  { value: "search", label: "Search" },
  { value: "map", label: "Map" },
  { value: "crawl", label: "Crawl" },
  { value: "batch_scrape", label: "Batch scrape" },
  { value: "extract", label: "Extract" },
  { value: "agent", label: "Agent" },
];

const WITH_SCRAPE_OPTIONS: PlaygroundKind[] = ["scrape", "search", "crawl", "batch_scrape"];

type Run = { status: number; durationMs: number; body: unknown; historyId: string; jobId: string | null; polling: boolean };

export function Playground({ keys, history, apiUrl }: { keys: Option[]; history: HistoryItem[]; apiUrl: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<PlaygroundKind>("scrape");
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [override, setOverride] = useState<string | null>(null);
  const [keyId, setKeyId] = useState<string>("internal");
  const [run, setRun] = useState<Run | null>(null);
  const [pending, startTransition] = useTransition();
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const generated = useMemo(() => buildBody(kind, form), [kind, form]);
  const requestText = override ?? JSON.stringify(generated, null, 2);
  const parsedRequest = useMemo(() => {
    try {
      return { body: JSON.parse(requestText) as Record<string, unknown>, error: null };
    } catch (error) {
      return { body: null, error: (error as Error).message };
    }
  }, [requestText]);
  const code = useMemo(() => snippets(kind, parsedRequest.body ?? generated, apiUrl), [kind, parsedRequest.body, generated, apiUrl]);

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  function set(patch: Partial<FormState>) {
    setForm((current) => ({ ...current, ...patch }));
    setOverride(null);
  }

  function poll(historyId: string) {
    pollTimer.current = setTimeout(async () => {
      const result = await pollPlaygroundAction(historyId);
      if (!result.ok) {
        setRun((current) => (current ? { ...current, polling: false } : current));
        toastManager.add({ type: "error", title: "Polling failed", description: result.error });
        return;
      }
      const status = (result.data.body as { status?: string } | null)?.status;
      const done = result.data.status >= 400 || (status !== undefined && !["scraping", "processing", "pending"].includes(status));
      setRun((current) => (current ? { ...current, body: result.data.body, polling: !done } : current));
      if (!done) poll(historyId);
    }, 2_500);
  }

  function execute() {
    if (!parsedRequest.body) return;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    startTransition(async () => {
      const result = await runPlaygroundAction({
        kind,
        body: parsedRequest.body!,
        keyId: keyId === "internal" ? null : Number(keyId),
        title: String(parsedRequest.body!.url ?? parsedRequest.body!.query ?? parsedRequest.body!.prompt ?? "").slice(0, 200) || null,
      });
      if (!result.ok) {
        toastManager.add({ type: "error", title: "Request failed", description: result.error });
        return;
      }
      const { status, durationMs, body, historyId, jobId } = result.data;
      const async = ASYNC_KINDS.includes(kind) && jobId !== null && status < 400;
      setRun({ status, durationMs, body, historyId, jobId, polling: async });
      if (async) poll(historyId);
      router.refresh();
    });
  }

  const historyColumns: DataColumn<HistoryItem>[] = [
    { id: "when", header: "When (UTC)", cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(row.original.createdAt)}</span> },
    { id: "kind", header: "Endpoint", cell: ({ row }) => <Badge variant="secondary">{row.original.kind}</Badge> },
    { id: "title", header: "Target", cell: ({ row }) => <span className="block max-w-80 truncate">{row.original.title ?? "–"}</span> },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.statusCode ? <Badge variant={statusTone(row.original.statusCode)}>{row.original.statusCode}</Badge> : "–",
    },
    { id: "duration", header: "Duration", cell: ({ row }) => formatDuration(row.original.durationMs) },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: "text-right" },
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setKind(row.original.kind);
              setOverride(JSON.stringify(row.original.request, null, 2));
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            <RotateCcwIcon /> Load
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete from history"
            onClick={() =>
              startTransition(async () => {
                await deleteHistoryAction(row.original.id);
                router.refresh();
              })
            }
          >
            <Trash2Icon />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Request</CardTitle>
            <CardDescription>Runs against this deployment as you, with your API key and limits.</CardDescription>
          </CardHeader>
          <CardPanel className="flex flex-col gap-4">
            <Tabs value={kind} onValueChange={(value) => { setKind(value as PlaygroundKind); setOverride(null); }}>
              <TabsList className="flex-wrap" data-testid="pg-kinds">
                {KINDS.map((item) => (
                  <TabsTab key={item.value} value={item.value}>
                    {item.label}
                  </TabsTab>
                ))}
              </TabsList>
              {KINDS.map((item) => (
                <TabsPanel key={item.value} value={item.value} className="mt-4 flex flex-col gap-4">
                  <KindFields kind={item.value} state={form} set={set} />
                  {WITH_SCRAPE_OPTIONS.includes(item.value) && <ScrapeOptions state={form} set={set} />}
                </TabsPanel>
              ))}
            </Tabs>
          </CardPanel>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Body and code</CardTitle>
              <CardDescription>Edit the JSON directly to send options the form does not cover.</CardDescription>
            </CardHeader>
            <CardPanel className="flex flex-col gap-3">
              <Tabs defaultValue="json">
                <TabsList>
                  <TabsTab value="json">JSON</TabsTab>
                  <TabsTab value="curl">curl</TabsTab>
                  <TabsTab value="python">Python</TabsTab>
                  <TabsTab value="javascript">JavaScript</TabsTab>
                </TabsList>
                <TabsPanel value="json" className="mt-3">
                  <Field>
                    <Textarea
                      value={requestText}
                      rows={14}
                      className="font-mono text-xs"
                      aria-label="Request JSON"
                      data-testid="pg-json"
                      onChange={(event) => setOverride(event.target.value)}
                    />
                    {parsedRequest.error && <FieldDescription className="text-destructive-foreground">Invalid JSON: {parsedRequest.error}</FieldDescription>}
                  </Field>
                  {override !== null && (
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => setOverride(null)}>
                      Reset to form
                    </Button>
                  )}
                </TabsPanel>
                {(["curl", "python", "javascript"] as const).map((language) => (
                  <TabsPanel key={language} value={language} className="relative mt-3">
                    <CopyButton value={code[language]} iconOnly size="icon-sm" variant="ghost" label={`Copy ${language}`} className="absolute top-2 right-2" />
                    <ScrollArea className="max-h-80 rounded-lg border bg-muted/40">
                      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs" data-testid={`pg-snippet-${language}`}>
                        {code[language]}
                      </pre>
                    </ScrollArea>
                  </TabsPanel>
                ))}
              </Tabs>
              <div className="flex flex-wrap items-end gap-2">
                <Field className="min-w-56 flex-1">
                  <FieldLabel>API key</FieldLabel>
                  <SimpleSelect
                    options={[{ value: "internal", label: "Dashboard key (counted in your usage)" }, ...keys]}
                    value={keyId}
                    onValueChange={setKeyId}
                    ariaLabel="API key"
                    className="w-full"
                  />
                </Field>
                <Button onClick={execute} loading={pending} disabled={!parsedRequest.body} data-testid="pg-run">
                  <PlayIcon /> Run
                </Button>
              </div>
            </CardPanel>
          </Card>

          <Card data-testid="pg-result">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Result
                {run && <Badge variant={statusTone(run.status)}>{run.status}</Badge>}
                {run && <span className="font-normal text-muted-foreground text-sm">{formatDuration(run.durationMs)}</span>}
                {run?.polling && <Spinner className="size-4" />}
              </CardTitle>
              {run?.jobId && <CardDescription className="font-mono">job {run.jobId}</CardDescription>}
            </CardHeader>
            <CardPanel>
              {run ? (
                run.status >= 400 ? (
                  <div className="flex flex-col gap-3">
                    <Alert variant="error">
                      <AlertTitle>HTTP {run.status}</AlertTitle>
                      <AlertDescription>
                        {String((run.body as { error?: string } | null)?.error ?? "The API refused the request.")}
                      </AlertDescription>
                    </Alert>
                    <ResultViewer body={run.body} />
                  </div>
                ) : (
                  <ResultViewer body={run.body} />
                )
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle className="text-base">No result yet</EmptyTitle>
                    <EmptyDescription>Configure a request and press Run.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardPanel>
          </Card>
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 font-heading font-semibold">
          <HistoryIcon className="size-4" /> History
        </h2>
        <DataTable
          columns={historyColumns}
          data={history}
          getRowId={(item) => item.id}
          testId="pg-history"
          empty="Requests you run here are saved for you only."
        />
      </section>
    </div>
  );
}
