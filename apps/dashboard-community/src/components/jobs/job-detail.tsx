"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { type DataColumn, DataTable } from "@/components/data-table";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { formatCredits, formatNumber } from "@/lib/format";
import type { JobResultsPage } from "@/lib/server/jobs";
import { CancelJobButton } from "./jobs-table";

type PageDoc = {
  url: string;
  statusCode: number | null;
  title: string | null;
  error: string | null;
};

function toDoc(raw: Record<string, unknown>): PageDoc {
  const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
  return {
    url: String(metadata.sourceURL ?? metadata.url ?? raw.url ?? ""),
    statusCode: typeof metadata.statusCode === "number" ? metadata.statusCode : null,
    title: typeof metadata.title === "string" ? metadata.title : null,
    error: typeof metadata.error === "string" ? metadata.error : null,
  };
}

export function JobDetail({ jobId, results, skip }: { jobId: string; results: JobResultsPage; skip: number }) {
  const router = useRouter();
  const running = results.status === "scraping";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), 5_000);
    return () => clearInterval(timer);
  }, [running, router]);

  const docs = results.data.map(toDoc);
  const columns: DataColumn<PageDoc>[] = [
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
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Status" value={<Badge variant={running ? "info" : "secondary"}>{results.status}</Badge>} />
        <StatCard label="Pages done" value={`${formatNumber(results.completed)} / ${formatNumber(results.total)}`} />
        <StatCard label="Failed pages" value={formatNumber(results.errors?.length ?? 0)} />
        <StatCard label="Credits used" value={formatCredits(results.creditsUsed)} />
      </div>
      <div className="flex justify-end gap-2">
        {running && <CancelJobButton jobId={jobId} size="default" />}
      </div>
      <DataTable columns={columns} data={docs} empty="No pages yet." getRowId={(doc) => `${doc.url}`} testId="job-pages" />
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
    </div>
  );
}
