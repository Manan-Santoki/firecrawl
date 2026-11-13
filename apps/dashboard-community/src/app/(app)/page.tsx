import Link from "next/link";
import { StackedDailyChart } from "@/components/charts/stacked-chart";
import { PageHeader } from "@/components/page-header";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFrame, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCredits, formatDuration, formatNumber, formatPercent } from "@/lib/format";
import { activeJobCount } from "@/lib/server/jobs";
import { requireViewer } from "@/lib/server/session";
import { overviewStats, perUserToday, requestSeries } from "@/lib/server/usage";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const viewer = await requireViewer();
  const [stats, series, activeJobs, users] = await Promise.all([
    overviewStats(viewer),
    requestSeries(viewer, "endpoint", 14),
    activeJobCount(viewer),
    perUserToday(viewer),
  ]);
  const isAdmin = viewer.role === "admin";

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          isAdmin
            ? "Activity across every user of this deployment."
            : "Your own activity on this Firecrawl deployment."
        }
        actions={
          <Button variant="outline" render={<Link href="/keys" />}>
            Manage API keys
          </Button>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="overview-stats">
        <StatCard
          label="Requests today"
          value={formatNumber(stats.requestsToday)}
          hint={`${formatNumber(stats.requests7d)} in the last 7 days`}
          testId="stat-requests-today"
        />
        <StatCard
          label="Success rate (7d)"
          value={formatPercent(stats.successRate7d)}
          hint="Responses below HTTP 400"
          testId="stat-success-rate"
        />
        <StatCard
          label="Avg latency (7d)"
          value={formatDuration(stats.avgLatencyMs7d)}
          hint="Job-creating requests, excluding status polls"
          testId="stat-latency"
        />
        <StatCard
          label="Credits used today"
          value={formatCredits(stats.creditsToday)}
          hint={`${formatCredits(stats.credits7d)} in the last 7 days`}
          testId="stat-credits"
        />
        <StatCard label="Active jobs" value={formatNumber(activeJobs)} hint="Crawls and batch scrapes in progress" />
        <StatCard
          label="Queue depth"
          value={stats.queue ? formatNumber(stats.queue.queued) : "–"}
          hint={stats.queue ? `${formatNumber(stats.queue.active)} scraping now` : "Queue database not configured"}
        />
        <StatCard label="Open browser sessions" value={formatNumber(stats.openBrowserSessions)} hint="Active sessions" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Requests per day</CardTitle>
          <CardDescription>Last 14 days by endpoint, excluding status polls.</CardDescription>
        </CardHeader>
        <CardPanel>
          <StackedDailyChart series={series} testId="overview-chart" />
        </CardPanel>
      </Card>

      {isAdmin && (
        <CardFrame>
          <Table variant="card" data-testid="overview-users">
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Requests (24h)</TableHead>
                <TableHead className="text-right">Errors (24h)</TableHead>
                <TableHead className="text-right">Credits (24h)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.email}>
                  <TableCell>
                    <div className="font-medium">{user.name}</div>
                    <div className="text-muted-foreground text-xs">{user.email}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(user.requests)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {user.errors > 0 ? <Badge variant="warning">{formatNumber(user.errors)}</Badge> : "0"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCredits(Number(user.credits))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardFrame>
      )}
    </>
  );
}
