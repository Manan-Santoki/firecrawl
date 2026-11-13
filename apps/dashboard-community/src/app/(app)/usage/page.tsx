import { StackedDailyChart } from "@/components/charts/stacked-chart";
import { PageHeader } from "@/components/page-header";
import { UsageFilters } from "@/components/usage-filters";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ForbiddenError } from "@/lib/server/authz";
import { requireViewer } from "@/lib/server/session";
import { creditSeries, requestSeries } from "@/lib/server/usage";
import { listUserOptions } from "@/lib/server/users";

export const metadata = { title: "Usage" };

const DAY_OPTIONS = [7, 14, 30];

export default async function UsagePage({ searchParams }: PageProps<"/usage">) {
  const viewer = await requireViewer();
  const params = await searchParams;
  const days = DAY_OPTIONS.includes(Number(params.days)) ? Number(params.days) : 14;
  const teamFilter = typeof params.user === "string" && /^[0-9a-f-]{36}$/i.test(params.user) ? params.user : null;
  const isAdmin = viewer.role === "admin";
  const who = isAdmin && !teamFilter ? "user" : "key";

  let charts;
  try {
    charts = await Promise.all([
      requestSeries(viewer, "endpoint", days, teamFilter),
      creditSeries(viewer, "endpoint", days, teamFilter),
      requestSeries(viewer, who, days, teamFilter),
      creditSeries(viewer, who, days, teamFilter),
    ]);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Not available</EmptyTitle>
            <EmptyDescription>You can only view your own usage.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      );
    }
    throw error;
  }
  const [requestsByEndpoint, creditsByEndpoint, requestsByWho, creditsByWho] = charts;
  const users = await listUserOptions(viewer);
  const whoLabel = who === "user" ? "user" : "API key";

  const cards = [
    { title: "Requests by endpoint", description: "Job-creating requests per day (status polls excluded).", series: requestsByEndpoint, id: "chart-requests-endpoint" },
    { title: "Credits by endpoint", description: "Credits charged per day, including async crawl pages.", series: creditsByEndpoint, id: "chart-credits-endpoint" },
    { title: `Requests by ${whoLabel}`, description: `Requests per day split by ${whoLabel}.`, series: requestsByWho, id: "chart-requests-who" },
    { title: `Credits by ${whoLabel}`, description: `Credits per day split by ${whoLabel}.`, series: creditsByWho, id: "chart-credits-who" },
  ];

  return (
    <>
      <PageHeader
        title="Usage"
        description="Daily requests and credits (UTC days)."
        actions={
          <UsageFilters
            days={days}
            user={teamFilter}
            users={isAdmin ? users.map((user) => ({ value: user.teamId, label: user.label })) : null}
          />
        }
      />
      <div className="grid gap-4 xl:grid-cols-2">
        {cards.map((card) => (
          <Card key={card.id}>
            <CardHeader>
              <CardTitle>{card.title}</CardTitle>
              <CardDescription>{card.description}</CardDescription>
            </CardHeader>
            <CardPanel>
              <StackedDailyChart series={card.series} testId={card.id} />
            </CardPanel>
          </Card>
        ))}
      </div>
    </>
  );
}
