"use client";

import { BotIcon, PlayIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { startAgentAction } from "@/app/actions/build";
import { type DataColumn, DataTable } from "@/components/data-table";
import { AreaField, SelectField, TextField } from "@/components/playground/controls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { formatDateTime, statusTone } from "@/lib/format";
import type { AgentRunRow } from "@/lib/server/agent";
import { AgentUnavailable } from "./agent-unavailable";

export function AgentRuns({ runs, isAdmin }: { runs: AgentRunRow[]; isAdmin: boolean }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [urls, setUrls] = useState("");
  const [schema, setSchema] = useState("");
  const [maxCredits, setMaxCredits] = useState("");
  const [effort, setEffort] = useState("medium");
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [pending, startTransition] = useTransition();

  const columns: DataColumn<AgentRunRow>[] = [
    {
      id: "prompt",
      header: "Run",
      cell: ({ row }) => (
        <div className="flex flex-col">
          <Link href={`/agent/${row.original.id}`} className="block max-w-xl truncate font-medium hover:underline">
            {row.original.prompt ?? row.original.id}
          </Link>
          <span className="font-mono text-muted-foreground text-xs">{row.original.id}</span>
        </div>
      ),
    },
    ...(isAdmin ? ([{ id: "user", header: "User", cell: ({ row }) => row.original.userEmail ?? "–" }] satisfies DataColumn<AgentRunRow>[]) : []),
    { id: "accepted", header: "Start", cell: ({ row }) => <Badge variant={statusTone(row.original.statusCode)}>{row.original.statusCode}</Badge> },
    { id: "created", header: "Started (UTC)", cell: ({ row }) => <span className="text-muted-foreground">{formatDateTime(row.original.createdAt)}</span> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Start a run</CardTitle>
          <CardDescription>Billed to your account. The prompt is stored in your request log.</CardDescription>
        </CardHeader>
        <CardPanel className="flex flex-col gap-3">
          {unavailable ? (
            <AgentUnavailable />
          ) : (
            <>
              {error && (
                <Alert variant="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <AreaField label="Prompt" value={prompt} onChange={setPrompt} rows={3} testId="agent-prompt" />
              <div className="grid gap-3 sm:grid-cols-3">
                <TextField label="URLs (optional, comma separated)" value={urls} onChange={setUrls} />
                <TextField label="Max credits" value={maxCredits} onChange={setMaxCredits} />
                <SelectField
                  label="Effort"
                  value={effort}
                  options={["low", "medium", "high"].map((value) => ({ value, label: value }))}
                  onChange={setEffort}
                />
              </div>
              <AreaField label="Output JSON Schema (optional)" value={schema} onChange={setSchema} rows={4} mono />
              <Button
                className="self-start"
                loading={pending}
                disabled={!prompt.trim()}
                data-testid="agent-start"
                onClick={() =>
                  startTransition(async () => {
                    const result = await startAgentAction({
                      prompt,
                      urls: urls.split(/[\s,]+/).filter(Boolean),
                      schema: schema || undefined,
                      maxCredits: Number(maxCredits) || undefined,
                      effort,
                    });
                    if (!result.ok) {
                      if (result.code === "agent_unavailable") setUnavailable(true);
                      else setError(result.error);
                      return;
                    }
                    router.push(`/agent/${result.data.id}`);
                  })
                }
              >
                <PlayIcon /> Start run
              </Button>
            </>
          )}
        </CardPanel>
      </Card>
      <DataTable
        columns={columns}
        data={runs}
        getRowId={(row) => row.id}
        testId="agent-runs"
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle>No agent runs yet</EmptyTitle>
              <EmptyDescription>Runs started here or with POST /v2/agent appear in this list.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
    </div>
  );
}
