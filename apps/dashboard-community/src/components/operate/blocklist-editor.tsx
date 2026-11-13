"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveBlocklistAction } from "@/app/actions/operate";
import { type DataColumn, DataTable } from "@/components/data-table";
import { AreaField } from "@/components/playground/controls";
import { type Option, SimpleSelect } from "@/components/simple-select";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/notify";

type Data = { blocklist: string[]; allowedKeywords: string[] };
type Hit = { domain: string; url: string | null; createdAt: string };

function ListCard({
  title,
  description,
  data,
  scope,
  testId,
}: {
  title: string;
  description: string;
  data: Data;
  scope: { global: true } | { teamId: string };
  testId: string;
}) {
  const router = useRouter();
  const [blocklist, setBlocklist] = useState(data.blocklist.join("\n"));
  const [keywords, setKeywords] = useState(data.allowedKeywords.join("\n"));
  const [pending, startTransition] = useTransition();
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardPanel className="grid gap-3 md:grid-cols-2">
        <AreaField label="Blocked domains (one per line)" value={blocklist} onChange={setBlocklist} rows={10} mono testId={`${testId}-domains`} />
        <AreaField label="Allowed keywords" value={keywords} onChange={setKeywords} rows={10} mono description="URLs containing one of these are still allowed." />
      </CardPanel>
      <CardFooter>
        <Button
          loading={pending}
          data-testid={`${testId}-save`}
          onClick={() =>
            startTransition(async () => {
              const result = await saveBlocklistAction(scope, { blocklist, allowedKeywords: keywords });
              if (!result.ok) return toastError("Not saved", result.error);
              toastSuccess(`${title} saved`);
              router.refresh();
            })
          }
        >
          Save
        </Button>
      </CardFooter>
    </Card>
  );
}

export function BlocklistEditor({
  team,
  teamId,
  global,
  users,
  hits,
}: {
  team: Data | null;
  teamId: string | null;
  global: Data | null;
  users: Option[] | null;
  hits: Hit[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const columns: DataColumn<Hit>[] = [
    { id: "when", header: "When (UTC)", cell: ({ row }) => formatDateTime(row.original.createdAt) },
    { id: "domain", header: "Domain", cell: ({ row }) => <span className="font-mono text-xs">{row.original.domain}</span> },
    { id: "url", header: "URL", cell: ({ row }) => <span className="block max-w-xl truncate text-sm">{row.original.url ?? "–"}</span> },
  ];
  return (
    <div className="flex flex-col gap-4">
      {users && (
        <div className="flex justify-end">
          <SimpleSelect
            options={users}
            value={teamId}
            onValueChange={(value) => router.push(`${pathname}?user=${value}`)}
            ariaLabel="User"
            placeholder="Choose a user"
            className="w-72"
          />
        </div>
      )}
      {team && teamId && (
        <ListCard key={teamId} title="Team blocklist" description="Applies to every API key of this user." data={team} scope={{ teamId }} testId="team-blocklist" />
      )}
      {global && <ListCard title="Global blocklist" description="Applies to every user of this deployment." data={global} scope={{ global: true }} testId="global-blocklist" />}
      <section className="flex flex-col gap-3">
        <h2 className="font-heading font-semibold">Recently blocked</h2>
        <DataTable columns={columns} data={hits} getRowId={(row) => `${row.domain}-${row.createdAt}`} empty="No blocked requests recorded." />
      </section>
    </div>
  );
}
