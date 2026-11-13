"use client";

import { CheckIcon, MinusIcon, PlayIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { runSelfTestAction } from "@/app/actions/operate";
import { type DataColumn, DataTable } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, formatDuration } from "@/lib/format";
import { toastError } from "@/lib/notify";
import { SELF_TESTS, type SelfTestId, testsForCapability } from "@/lib/self-tests";
import type { SelfTestResult } from "@/lib/server/selftest";

export type Capability = {
  id: string;
  group: string;
  name: string;
  cloud: boolean;
  community: string;
  requirements: string;
  evidence: string;
};

const STATUS_VARIANT: Record<string, "success" | "info" | "warning" | "error" | "secondary" | "outline"> = {
  available: "success",
  configurable: "info",
  partial: "warning",
  "verification-needed": "warning",
  planned: "secondary",
  unavailable: "error",
  "managed-service-only": "outline",
};

function ResultBadge({ result }: { result?: SelfTestResult }) {
  if (!result) return <span className="text-muted-foreground text-xs">not run</span>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        <Badge variant={result.status === "pass" ? "success" : result.status === "fail" ? "error" : "secondary"} data-testid="selftest-result">
          {result.status} · {formatDuration(result.latencyMs)}
        </Badge>
      </TooltipTrigger>
      <TooltipPopup>
        {result.detail} ({formatDateTime(result.createdAt)} UTC)
      </TooltipPopup>
    </Tooltip>
  );
}

export function FeatureMatrix({
  capabilities,
  statusDefinitions,
  history,
}: {
  capabilities: Capability[];
  statusDefinitions: Record<string, string>;
  history: SelfTestResult[];
}) {
  const router = useRouter();
  const [running, setRunning] = useState<SelfTestId | null>(null);
  const [, startTransition] = useTransition();
  const latest = useMemo(() => {
    const map = new Map<SelfTestId, SelfTestResult>();
    for (const result of history) if (!map.has(result.feature)) map.set(result.feature, result);
    return map;
  }, [history]);

  const run = (id: SelfTestId) => {
    setRunning(id);
    startTransition(async () => {
      const result = await runSelfTestAction(id);
      setRunning(null);
      if (!result.ok) toastError("Self-test could not run", result.error);
      router.refresh();
    });
  };

  const columns: DataColumn<Capability>[] = [
    {
      id: "name",
      header: "Feature",
      cell: ({ row }) => (
        <div className="flex max-w-md flex-col whitespace-normal">
          <span className="font-medium">{row.original.name}</span>
          <span className="text-muted-foreground text-xs">{row.original.group}</span>
        </div>
      ),
    },
    {
      id: "cloud",
      header: "Cloud",
      cell: ({ row }) => (row.original.cloud ? <CheckIcon className="size-4" aria-label="Yes" /> : <MinusIcon className="size-4" aria-label="No" />),
    },
    {
      id: "community",
      header: "This instance",
      cell: ({ row }) => (
        <Tooltip>
          <TooltipTrigger render={<span />}>
            <Badge variant={STATUS_VARIANT[row.original.community] ?? "outline"}>{row.original.community}</Badge>
          </TooltipTrigger>
          <TooltipPopup className="max-w-xs">{statusDefinitions[row.original.community]}</TooltipPopup>
        </Tooltip>
      ),
    },
    {
      id: "requirements",
      header: "Requirements",
      cell: ({ row }) => <span className="block min-w-48 max-w-sm whitespace-normal text-muted-foreground text-xs">{row.original.requirements}</span>,
    },
    {
      id: "selftest",
      header: "Self-test",
      cell: ({ row }) => {
        const tests = testsForCapability(row.original.id);
        if (!tests.length) return <span className="text-muted-foreground text-xs">–</span>;
        return (
          <div className="flex flex-col gap-1.5">
            {tests.map((id) => (
              <div key={id} className="flex items-center gap-2">
                <Button size="xs" variant="outline" loading={running === id} onClick={() => run(id)} data-testid={`selftest-${id}`}>
                  <PlayIcon /> {SELF_TESTS[id].label}
                </Button>
                <ResultBadge result={latest.get(id)} />
              </div>
            ))}
          </div>
        );
      },
    },
  ];

  const historyColumns: DataColumn<SelfTestResult>[] = [
    { id: "when", header: "When (UTC)", cell: ({ row }) => formatDateTime(row.original.createdAt) },
    { id: "test", header: "Test", cell: ({ row }) => SELF_TESTS[row.original.feature].label },
    { id: "result", header: "Result", cell: ({ row }) => <ResultBadge result={row.original} /> },
    { id: "detail", header: "Detail", cell: ({ row }) => <span className="block max-w-lg truncate text-sm">{row.original.detail}</span> },
  ];

  return (
    <Tabs defaultValue="matrix">
      <TabsList>
        <TabsTab value="matrix">Matrix ({capabilities.length})</TabsTab>
        <TabsTab value="history">Self-test history ({history.length})</TabsTab>
      </TabsList>
      <TabsPanel value="matrix" className="mt-4">
        <DataTable columns={columns} data={capabilities} getRowId={(row) => row.id} testId="feature-matrix" empty="No capabilities." />
      </TabsPanel>
      <TabsPanel value="history" className="mt-4">
        <DataTable
          columns={historyColumns}
          data={history}
          getRowId={(row) => `${row.feature}-${row.createdAt}`}
          testId="selftest-history"
          empty="No self-tests have run yet."
        />
      </TabsPanel>
    </Tabs>
  );
}
