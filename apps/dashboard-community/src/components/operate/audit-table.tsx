"use client";

import { SearchIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { type DataColumn, DataTable } from "@/components/data-table";
import { SimpleSelect } from "@/components/simple-select";
import { Badge } from "@/components/ui/badge";
import { Form } from "@/components/ui/form";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { formatDateTime } from "@/lib/format";
import type { AuditRow } from "@/lib/server/audit-log";

const ACTIONS = [
  { value: "all", label: "All actions" },
  { value: "auth.", label: "Sign-ins" },
  { value: "invite.", label: "Invites" },
  { value: "api_key.", label: "API keys" },
  { value: "user.", label: "Users and limits" },
  { value: "settings.", label: "Settings" },
  { value: "blocklist.", label: "Blocklist" },
  { value: "alert.", label: "Alerts" },
  { value: "job.", label: "Jobs" },
  { value: "retention.", label: "Retention" },
];

export function AuditTable({ rows, action, q }: { rows: AuditRow[]; action: string | null; q: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState(q ?? "");
  const go = (next: { action?: string | null; q?: string | null }) => {
    const params = new URLSearchParams();
    const a = next.action === undefined ? action : next.action;
    const s = next.q === undefined ? q : next.q;
    if (a && a !== "all") params.set("action", a);
    if (s) params.set("q", s);
    router.push(`${pathname}?${params.toString()}`);
  };
  const columns: DataColumn<AuditRow>[] = [
    { id: "when", header: "When (UTC)", cell: ({ row }) => <span className="whitespace-nowrap">{formatDateTime(row.original.createdAt)}</span> },
    { id: "actor", header: "Actor", cell: ({ row }) => row.original.actorEmail ?? "–" },
    { id: "action", header: "Action", cell: ({ row }) => <Badge variant="outline" className="font-mono">{row.original.action}</Badge> },
    { id: "target", header: "Target user", cell: ({ row }) => row.original.targetEmail ?? "–" },
    {
      id: "details",
      header: "Details",
      cell: ({ row }) => <span className="block max-w-lg truncate font-mono text-xs" title={JSON.stringify(row.original.details)}>{JSON.stringify(row.original.details)}</span>,
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <SimpleSelect options={ACTIONS} value={action ?? "all"} onValueChange={(value) => go({ action: value })} ariaLabel="Action" className="w-48" />
        <Form className="min-w-64 flex-1" onSubmit={(event) => { event.preventDefault(); go({ q: query }); }}>
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search email or details" aria-label="Search audit log" />
          </InputGroup>
        </Form>
      </div>
      <DataTable columns={columns} data={rows} getRowId={(row) => String(row.id)} testId="audit-table" empty="No matching events." />
    </div>
  );
}
