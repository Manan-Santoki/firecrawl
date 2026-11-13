"use client";

import { DownloadIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { type DataColumn, DataTable } from "@/components/data-table";
import { ResultViewer } from "@/components/result-viewer";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { formatCredits, formatNumber } from "@/lib/format";
import type { JobResultsPage } from "@/lib/server/jobs";
import { CancelJobButton } from "./jobs-table";

type PageDoc = {
  index: number;
  url: string;
  statusCode: number | null;
  title: string | null;
  error: string | null;
  raw: Record<string, unknown>;
};

function toDoc(raw: Record<string, unknown>, index: number): PageDoc {
  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
  return {
    index,
    url: String(metadata.sourceURL ?? metadata.url ?? raw.url ?? ""),
    statusCode: typeof metadata.statusCode === "number" ? metadata.statusCode : null,
    title: typeof metadata.title === "string" ? metadata.title : null,
    error: typeof metadata.error === "string" ? metadata.error : null,
    raw,
  };
}

function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function JobDetail({ jobId, results, skip }: { jobId: string; results: JobResultsPage; skip: number }) {
  const router = useRouter();
  const [selected, setSelected] = useState<PageDoc | null>(null);
  const running = results.status === "scraping";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), 5_000);
    return () => clearInterval(timer);
  }, [running, router]);

  const docs = results.data.map((raw, index) => toDoc(raw, skip + index));
  const columns: DataColumn<PageDoc>[] = [
    { id: "n", header: "#", meta: { className: "w-12 text-muted-foreground" }, cell: ({ row }) => row.original.index + 1 },
    {
      id: "url",
      header: "Page",
      cell: ({ row }) => (
        <div className="flex max-w-xl flex-col">
          <span className="truncate font-medium">{row.original.title ?? row.original.url}</span>
          <span className="truncate text-muted-foreground text-xs">{row.original.url}</span>
        </div>
      ),
    },
    {
      id: "status",
      header: "HTTP",
      cell: ({ row }) =>
        row.original.statusCode ? (
          <Badge variant={row.original.statusCode < 400 ? "success" : "warning"}>{row.original.statusCode}</Badge>
        ) : (
          "–"
        ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: "text-right" },
      cell: ({ row }) => (
        <div className="flex justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <Button size="sm" variant="outline" onClick={() => setSelected(row.original)}>
            View
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Download page JSON"
            onClick={() => downloadJson(`page-${row.original.index + 1}.json`, row.original.raw)}
          >
            <DownloadIcon />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Status" value={<Badge variant={running ? "info" : "secondary"}>{results.status}</Badge>} />
        <StatCard label="Pages done" value={`${formatNumber(results.completed)} / ${formatNumber(results.total)}`} />
        <StatCard label="Failed pages" value={formatNumber(results.errors?.length ?? 0)} />
        <StatCard label="Credits used" value={formatCredits(results.creditsUsed)} />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" render={<a href={`/api/jobs/${jobId}/download`} download />}>
          <DownloadIcon /> Download all pages
        </Button>
        {running && <CancelJobButton jobId={jobId} size="default" />}
      </div>
      <DataTable
        columns={columns}
        data={docs}
        empty="No pages yet."
        getRowId={(doc) => String(doc.index)}
        onRowClick={setSelected}
        testId="job-pages"
      />
      <div className="flex justify-between">
        <Button
          variant="outline"
          disabled={skip === 0}
          render={skip === 0 ? undefined : <Link href={`/jobs/${jobId}?skip=${Math.max(0, skip - 25)}`} />}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          disabled={!results.next}
          render={results.next ? <Link href={`/jobs/${jobId}?skip=${skip + docs.length}`} /> : undefined}
        >
          Next
        </Button>
      </div>
      {(results.errors?.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Failed pages</CardTitle>
            <CardDescription>Pages Firecrawl could not scrape.</CardDescription>
          </CardHeader>
          <CardPanel>
            <ul className="flex flex-col gap-2 text-sm">
              {results.errors!.slice(0, 50).map((error, index) => (
                <li key={index} className="flex flex-col">
                  <span className="truncate font-mono text-xs">{String(error.url ?? "")}</span>
                  <span className="text-muted-foreground">{String(error.error ?? "")}</span>
                </li>
              ))}
            </ul>
          </CardPanel>
        </Card>
      )}
      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetPopup className="sm:max-w-3xl" data-testid="page-detail">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="truncate">{selected.title ?? selected.url}</SheetTitle>
                <SheetDescription className="truncate">{selected.url}</SheetDescription>
              </SheetHeader>
              <SheetPanel>
                <ResultViewer body={{ data: selected.raw }} />
              </SheetPanel>
            </>
          )}
        </SheetPopup>
      </Sheet>
    </div>
  );
}
