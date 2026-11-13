import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { RefreshButton } from "@/components/refresh-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { formatDuration } from "@/lib/format";
import { type HealthCheck, type HealthState, runHealthChecks } from "@/lib/server/health";
import { requireViewer } from "@/lib/server/session";

export const metadata = { title: "Service health" };

const STATE: Record<HealthState, { label: string; variant: "success" | "warning" | "error" | "outline"; icon: typeof CircleCheckIcon }> = {
  ok: { label: "Healthy", variant: "success", icon: CircleCheckIcon },
  degraded: { label: "Degraded", variant: "warning", icon: TriangleAlertIcon },
  down: { label: "Down", variant: "error", icon: CircleXIcon },
  not_configured: { label: "Not configured", variant: "outline", icon: CircleDashedIcon },
};

const GROUPS: HealthCheck["group"][] = ["Core", "Data", "AI", "Optional services"];

export default async function HealthPage() {
  await requireViewer();
  const checks = await runHealthChecks();
  const configured = checks.filter((check) => check.state !== "not_configured");
  const problems = configured.filter((check) => check.state !== "ok");

  return (
    <>
      <PageHeader
        title="Service health"
        description={
          problems.length === 0
            ? `All ${configured.length} configured services are healthy.`
            : `${problems.length} of ${configured.length} configured services need attention.`
        }
        actions={<RefreshButton />}
      />
      {GROUPS.map((group) => {
        const items = checks.filter((check) => check.group === group);
        if (items.length === 0) return null;
        return (
          <section key={group} className="flex flex-col gap-3">
            <h2 className="font-heading font-semibold text-muted-foreground text-sm">{group}</h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid={`health-${group}`}>
              {items.map((check) => {
                const state = STATE[check.state];
                const Icon = state.icon;
                return (
                  <Card key={check.id} data-testid={`health-check-${check.id}`} data-state={check.state}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="flex items-center gap-2 text-base">
                          <Icon className="size-4 opacity-80" />
                          {check.name}
                        </CardTitle>
                        <Badge variant={state.variant}>{state.label}</Badge>
                      </div>
                      <CardDescription className="break-words">{check.detail}</CardDescription>
                    </CardHeader>
                    {(check.version || check.latencyMs !== null) && (
                      <CardPanel className="flex gap-4 pt-0 text-muted-foreground text-xs">
                        {check.version && <span>{check.version}</span>}
                        {check.latencyMs !== null && <span>{formatDuration(check.latencyMs)}</span>}
                      </CardPanel>
                    )}
                  </Card>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}
