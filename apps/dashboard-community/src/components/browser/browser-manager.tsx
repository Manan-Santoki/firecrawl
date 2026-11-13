"use client";

import { GlobeIcon, PlayIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  browserLinksAction,
  closeBrowserAction,
  createBrowserAction,
  deleteProfileAction,
  executeBrowserAction,
} from "@/app/actions/build";
import { type DataColumn, DataTable } from "@/components/data-table";
import { AreaField, SelectField, SwitchField, TextField } from "@/components/playground/controls";
import { JsonBlock } from "@/components/result-viewer";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { formatCredits, formatDateTime, formatRelative } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/notify";
import type { BrowserLinks, BrowserProfileRow, BrowserSessionRow, ExecuteResult } from "@/lib/server/browser";

const SAMPLES: Record<string, string> = {
  node: "await page.goto('https://example.com');\nconsole.log(await page.title());",
  python: "await page.goto('https://example.com')\nprint(await page.title())",
  bash: "agent-browser open https://example.com && agent-browser get title",
};

export function BrowserManager({
  sessions,
  profiles,
  isAdmin,
  includeClosed,
}: {
  sessions: BrowserSessionRow[];
  profiles: BrowserProfileRow[];
  isAdmin: boolean;
  includeClosed: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<{ session: BrowserSessionRow; links: BrowserLinks | null } | null>(null);
  const [, startTransition] = useTransition();

  const columns: DataColumn<BrowserSessionRow>[] = [
    { id: "id", header: "Session", cell: ({ row }) => <span className="font-mono text-xs">{row.original.id}</span> },
    ...(isAdmin ? ([{ id: "user", header: "User", cell: ({ row }) => row.original.userEmail ?? "–" }] satisfies DataColumn<BrowserSessionRow>[]) : []),
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => <Badge variant={row.original.status === "active" ? "success" : "secondary"}>{row.original.status}</Badge>,
    },
    { id: "created", header: "Started (UTC)", cell: ({ row }) => <span className="text-muted-foreground">{formatDateTime(row.original.createdAt)}</span> },
    { id: "activity", header: "Last activity", cell: ({ row }) => <span className="text-muted-foreground">{formatRelative(row.original.updatedAt)}</span> },
    { id: "credits", header: "Credits", meta: { className: "text-right" }, cell: ({ row }) => formatCredits(row.original.creditsUsed) },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: "text-right" },
      cell: ({ row }) =>
        row.original.status === "active" ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="open-session"
            onClick={() => {
              setOpen({ session: row.original, links: null });
              startTransition(async () => {
                const result = await browserLinksAction(row.original.id);
                if (!result.ok) return toastError("Could not open session", result.error);
                setOpen({ session: row.original, links: result.data });
              });
            }}
          >
            Open
          </Button>
        ) : null,
    },
  ];

  const profileColumns: DataColumn<BrowserProfileRow>[] = [
    { id: "name", header: "Profile", cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
    ...(isAdmin ? ([{ id: "user", header: "User", cell: ({ row }) => row.original.userEmail ?? "–" }] satisfies DataColumn<BrowserProfileRow>[]) : []),
    { id: "saved", header: "Saved (UTC)", cell: ({ row }) => formatDateTime(row.original.savedAt) },
    {
      id: "size",
      header: "Size",
      cell: ({ row }) => (row.original.sizeBytes === null ? "–" : `${(row.original.sizeBytes / 1024 / 1024).toFixed(1)} MB`),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: "text-right" },
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="destructive-outline"
          onClick={() =>
            startTransition(async () => {
              const result = await deleteProfileAction(row.original.teamId, row.original.name);
              if (!result.ok) return toastError("Delete failed", result.error);
              toastSuccess("Profile deleted");
              router.refresh();
            })
          }
        >
          Delete
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" render={<Link href={includeClosed ? "/browser" : "/browser?closed=1"} />}>
          {includeClosed ? "Show active only" : "Include closed (7 days)"}
        </Button>
        <CreateSessionDialog onCreated={(links, row) => setOpen({ session: row, links })} />
      </div>
      <DataTable
        columns={columns}
        data={sessions}
        getRowId={(row) => row.id}
        testId="browser-sessions"
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <GlobeIcon />
              </EmptyMedia>
              <EmptyTitle>No open sessions</EmptyTitle>
              <EmptyDescription>Start one here or with POST /v2/browser. Requires the community browser service.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
      <section className="flex flex-col gap-3">
        <h2 className="font-heading font-semibold">Saved profiles</h2>
        <DataTable columns={profileColumns} data={profiles} getRowId={(row) => `${row.teamId}:${row.name}`} empty="Profiles saved by sessions appear here." />
      </section>
      <Sheet open={open !== null} onOpenChange={(value) => !value && setOpen(null)}>
        <SheetPopup className="sm:max-w-4xl" data-testid="session-panel">
          {open && <SessionPanel session={open.session} links={open.links} onClosed={() => { setOpen(null); router.refresh(); }} />}
        </SheetPopup>
      </Sheet>
    </div>
  );
}

function SessionPanel({ session, links, onClosed }: { session: BrowserSessionRow; links: BrowserLinks | null; onClosed: () => void }) {
  const [language, setLanguage] = useState("node");
  const [code, setCode] = useState(SAMPLES.node);
  const [timeout, setTimeoutValue] = useState("30");
  const [output, setOutput] = useState<ExecuteResult | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <SheetHeader>
        <SheetTitle className="font-mono text-base">{session.id}</SheetTitle>
        <SheetDescription>Started {formatDateTime(session.createdAt)} UTC</SheetDescription>
      </SheetHeader>
      <SheetPanel className="flex flex-col gap-4">
        {!links ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner className="size-4" /> Loading session…
          </div>
        ) : (
          <Tabs defaultValue="live">
            <TabsList>
              <TabsTab value="live">Live View</TabsTab>
              <TabsTab value="interactive">Interactive</TabsTab>
              <TabsTab value="code">Run code</TabsTab>
            </TabsList>
            {(["live", "interactive"] as const).map((mode) => {
              const url = mode === "live" ? links.liveViewUrl : links.interactiveLiveViewUrl;
              return (
                <TabsPanel key={mode} value={mode} className="mt-3">
                  {url ? (
                    <iframe
                      title={`${mode} view`}
                      src={url}
                      className="aspect-video w-full rounded-lg border bg-muted"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
                    />
                  ) : (
                    <Alert variant="info">
                      <AlertDescription>
                        This session has no {mode === "live" ? "Live View" : "interactive view"} URL. Start it with “Stream view” on and set BROWSER_PUBLIC_URL on the browser service.
                      </AlertDescription>
                    </Alert>
                  )}
                </TabsPanel>
              );
            })}
            <TabsPanel value="code" className="mt-3 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <SelectField
                  label="Language"
                  value={language}
                  options={[
                    { value: "node", label: "Node.js" },
                    { value: "python", label: "Python" },
                    { value: "bash", label: "Bash" },
                  ]}
                  onChange={(value) => {
                    setLanguage(value);
                    setCode(SAMPLES[value]);
                  }}
                />
                <TextField label="Timeout (s)" value={timeout} onChange={setTimeoutValue} />
              </div>
              <AreaField label="Code" value={code} onChange={setCode} rows={8} mono testId="browser-code" />
              <Button
                className="self-start"
                loading={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await executeBrowserAction(session.id, { code, language, timeout: Number(timeout) || 30 });
                    if (!result.ok) return toastError("Execution failed", result.error);
                    setOutput(result.data);
                  })
                }
              >
                <PlayIcon /> Run
              </Button>
              {output && (
                <div className="flex flex-col gap-2">
                  <Badge variant={output.exitCode === 0 && !output.killed ? "success" : "error"} className="self-start">
                    exit {output.exitCode ?? "?"}
                    {output.killed ? " (killed)" : ""}
                  </Badge>
                  {output.stdout && <pre className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-xs">{output.stdout}</pre>}
                  {output.stderr && <pre className="whitespace-pre-wrap rounded-lg border border-destructive/30 p-3 font-mono text-xs">{output.stderr}</pre>}
                  {output.result !== undefined && output.result !== null && <JsonBlock value={output.result} />}
                </div>
              )}
            </TabsPanel>
          </Tabs>
        )}
        <Button
          variant="destructive"
          className="self-start"
          loading={pending}
          data-testid="close-session"
          onClick={() =>
            startTransition(async () => {
              const result = await closeBrowserAction(session.id);
              if (!result.ok) return toastError("Could not close session", result.error);
              toastSuccess("Session closed");
              onClosed();
            })
          }
        >
          Close session
        </Button>
      </SheetPanel>
    </>
  );
}

function CreateSessionDialog({ onCreated }: { onCreated: (links: BrowserLinks, row: BrowserSessionRow) => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [ttl, setTtl] = useState("600");
  const [activityTtl, setActivityTtl] = useState("300");
  const [stream, setStream] = useState(true);
  const [blockAds, setBlockAds] = useState(true);
  const [profileName, setProfileName] = useState("");
  const [saveProfile, setSaveProfile] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)} data-testid="new-session">
        <PlusIcon /> New session
      </Button>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New browser session</DialogTitle>
          <DialogDescription>Billed to your account like a /v2/browser call.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Lifetime (s)" value={ttl} onChange={setTtl} />
            <TextField label="Idle timeout (s)" value={activityTtl} onChange={setActivityTtl} />
          </div>
          <SwitchField label="Stream view" description="Needed for Live View." checked={stream} onChange={setStream} />
          <SwitchField label="Block ads" checked={blockAds} onChange={setBlockAds} />
          <TextField label="Profile (optional)" value={profileName} onChange={setProfileName} placeholder="reuse cookies and storage" />
          {profileName && <SwitchField label="Save changes to the profile" checked={saveProfile} onChange={setSaveProfile} />}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await createBrowserAction({
                  ttl: Number(ttl),
                  activityTtl: Number(activityTtl),
                  streamWebView: stream,
                  blockAds,
                  profileName: profileName || undefined,
                  saveProfile,
                });
                if (!result.ok) return setError(result.error);
                setOpen(false);
                const now = new Date().toISOString();
                onCreated(result.data, {
                  id: result.data.id,
                  teamId: "",
                  userEmail: null,
                  status: "active",
                  streamWebView: stream,
                  createdAt: now,
                  updatedAt: now,
                  creditsUsed: null,
                });
                router.refresh();
              })
            }
          >
            Start session
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
