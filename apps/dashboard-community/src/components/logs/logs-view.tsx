"use client";

import { DownloadIcon, ScrollTextIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { type DataColumn, DataTable } from "@/components/data-table";
import { type Option, SimpleSelect } from "@/components/simple-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Form } from "@/components/ui/form";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Sheet, SheetDescription, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "@/components/ui/sheet";
import { formatCredits, formatDateTime, formatDuration, formatNumber, statusTone } from "@/lib/format";
import type { LogFilters, LogRow } from "@/lib/server/request-log";

const RANGE_OPTIONS: Option[] = [
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];

const STATUS_OPTIONS: Option[] = [
  { value: "all", label: "Any status" },
  { value: "2xx", label: "2xx success" },
  { value: "3xx", label: "3xx" },
  { value: "4xx", label: "4xx client error" },
  { value: "5xx", label: "5xx server error" },
  { value: "errors", label: "All errors" },
];

export function StatusBadge({ status }: { status: number }) {
  return (
    <Badge variant={statusTone(status)} className="tabular-nums">
      {status}
    </Badge>
  );
}

export function LogsView({
  rows,
  total,
  page,
  pageSize,
  filters,
  endpoints,
  keys,
  users,
  isAdmin,
}: {
  rows: LogRow[];
  total: number;
  page: number;
  pageSize: number;
  filters: LogFilters;
  endpoints: string[];
  keys: Option[];
  users: Option[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<LogRow | null>(null);
  const [query, setQuery] = useState(filters.q ?? "");

  function update(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "" || value === "all") params.delete(key);
      else params.set(key, value);
    }
    if (!("page" in changes)) params.delete("page");
    router.push(`${pathname}?${params.toString()}`);
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const exportParams = new URLSearchParams(searchParams.toString());
  exportParams.delete("page");

  const columns: DataColumn<LogRow>[] = [
    {
      id: "time",
      header: "Time (UTC)",
      cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(row.original.createdAt)}</span>,
    },
    ...(isAdmin
      ? ([
          {
            id: "user",
            header: "User",
            cell: ({ row }) => <span className="text-sm">{row.original.userEmail ?? "–"}</span>,
          },
        ] satisfies DataColumn<LogRow>[])
      : []),
    {
      id: "endpoint",
      header: "Endpoint",
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-mono text-xs">
          <span className="text-muted-foreground">{row.original.method}</span> {row.original.endpoint}
        </span>
      ),
    },
    {
      id: "target",
      header: "Target",
      cell: ({ row }) => (
        <span className="block max-w-72 truncate text-sm" title={row.original.target ?? undefined}>
          {row.original.target ?? (row.original.zeroDataRetention ? "Redacted (ZDR)" : "–")}
        </span>
      ),
    },
    { id: "status", header: "Status", cell: ({ row }) => <StatusBadge status={row.original.statusCode} /> },
    {
      id: "duration",
      header: "Duration",
      meta: { className: "text-right" },
      cell: ({ row }) => <span className="tabular-nums">{formatDuration(row.original.durationMs)}</span>,
    },
    {
      id: "credits",
      header: "Credits",
      meta: { className: "text-right" },
      cell: ({ row }) => <span className="tabular-nums">{formatCredits(row.original.credits)}</span>,
    },
    {
      id: "key",
      header: "Key",
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">
          {row.original.apiKeyName ?? (row.original.apiKeyId ? `#${row.original.apiKeyId}` : "–")}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2" data-testid="log-filters">
        <SimpleSelect
          options={RANGE_OPTIONS}
          value={filters.range}
          onValueChange={(range) => update({ range })}
          ariaLabel="Time range"
          className="w-40"
        />
        <SimpleSelect
          options={[{ value: "all", label: "Any endpoint" }, ...endpoints.map((value) => ({ value, label: value }))]}
          value={filters.endpoint ?? "all"}
          onValueChange={(endpoint) => update({ endpoint })}
          ariaLabel="Endpoint"
          className="w-48"
        />
        <SimpleSelect
          options={STATUS_OPTIONS}
          value={filters.status ?? "all"}
          onValueChange={(status) => update({ status })}
          ariaLabel="Status"
          className="w-40"
        />
        <SimpleSelect
          options={[{ value: "all", label: "Any key" }, ...keys]}
          value={filters.apiKeyId ? String(filters.apiKeyId) : "all"}
          onValueChange={(key) => update({ key })}
          ariaLabel="API key"
          className="w-48"
        />
        {isAdmin && (
          <SimpleSelect
            options={[{ value: "all", label: "Every user" }, ...users]}
            value={filters.teamId ?? "all"}
            onValueChange={(user) => update({ user })}
            ariaLabel="User"
            className="w-56"
          />
        )}
        <Form
          className="min-w-56 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            update({ q: query });
          }}
        >
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              placeholder="Search URL, query, job id or error"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search"
              data-testid="log-search"
            />
          </InputGroup>
        </Form>
        <Button variant="outline" render={<a href={`/api/logs/export?${exportParams.toString()}`} download />}>
          <DownloadIcon /> Export CSV
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => String(row.id)}
        onRowClick={setSelected}
        testId="log-table"
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ScrollTextIcon />
              </EmptyMedia>
              <EmptyTitle>No requests match</EmptyTitle>
              <EmptyDescription>Widen the time range or clear filters.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />

      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {formatNumber(total)} requests · page {page} of {pageCount}
        </p>
        <Pagination className="mx-0 w-auto">
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                aria-disabled={page <= 1}
                className={page <= 1 ? "pointer-events-none opacity-50" : undefined}
                href={`${pathname}?${withPage(searchParams, page - 1)}`}
              />
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                aria-disabled={page >= pageCount}
                className={page >= pageCount ? "pointer-events-none opacity-50" : undefined}
                href={`${pathname}?${withPage(searchParams, page + 1)}`}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetPopup className="sm:max-w-lg" data-testid="log-detail">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="font-mono text-base">
                  {selected.method} {selected.path}
                </SheetTitle>
                <SheetDescription>{formatDateTime(selected.createdAt)} UTC</SheetDescription>
              </SheetHeader>
              <SheetPanel className="flex flex-col gap-4">
                <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-2 text-sm">
                  <Detail label="Status">
                    <StatusBadge status={selected.statusCode} />
                  </Detail>
                  <Detail label="Duration">{formatDuration(selected.durationMs)}</Detail>
                  <Detail label="Credits">{formatCredits(selected.credits)}</Detail>
                  <Detail label="Endpoint">
                    <span className="font-mono text-xs">{selected.endpoint}</span>
                  </Detail>
                  <Detail label="User">{selected.userEmail ?? "–"}</Detail>
                  <Detail label="API key">
                    {selected.apiKeyName ?? "–"} {selected.apiKeyId ? `(#${selected.apiKeyId})` : ""}
                  </Detail>
                  <Detail label="Origin">{selected.origin ?? "–"}</Detail>
                  <Detail label="Zero retention">{selected.zeroDataRetention ? "Yes" : "No"}</Detail>
                  <Detail label="Job id">
                    {selected.jobId ? (
                      <span className="flex items-center gap-1">
                        <span className="break-all font-mono text-xs">{selected.jobId}</span>
                        <CopyButton value={selected.jobId} iconOnly size="icon-xs" variant="ghost" label="Copy job id" />
                      </span>
                    ) : (
                      "–"
                    )}
                  </Detail>
                  <Detail label="Target">
                    <span className="break-all">{selected.target ?? "–"}</span>
                  </Detail>
                </dl>
                {selected.error && (
                  <div className="flex flex-col gap-1">
                    <span className="font-medium text-sm">Error</span>
                    <pre className="whitespace-pre-wrap break-words rounded-lg border bg-muted p-3 font-mono text-xs">
                      {selected.error}
                    </pre>
                  </div>
                )}
                {selected.jobId && /crawl|batch/.test(selected.endpoint) && (
                  <Button variant="outline" render={<Link href={`/jobs/${selected.jobId}`} />}>
                    Open job
                  </Button>
                )}
              </SheetPanel>
            </>
          )}
        </SheetPopup>
      </Sheet>
    </div>
  );
}

function withPage(searchParams: URLSearchParams, page: number): string {
  const params = new URLSearchParams(searchParams.toString());
  params.set("page", String(Math.max(1, page)));
  return params.toString();
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
