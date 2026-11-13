import { BlocklistEditor } from "@/components/operate/blocklist-editor";
import { PageHeader } from "@/components/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getGlobalBlocklist, getTeamBlocklist, recentBlocklistHits } from "@/lib/server/blocklist";
import { requireViewer } from "@/lib/server/session";
import { listUserOptions } from "@/lib/server/users";

export const metadata = { title: "Blocklist" };

export default async function BlocklistPage({ searchParams }: PageProps<"/blocklist">) {
  const viewer = await requireViewer();
  const params = await searchParams;
  const isAdmin = viewer.role === "admin";
  const users = await listUserOptions(viewer);
  const requested = typeof params.user === "string" && /^[0-9a-f-]{36}$/i.test(params.user) ? params.user : null;
  const teamId = isAdmin && requested ? requested : viewer.teamId;
  const [team, global, hits] = await Promise.all([
    teamId ? getTeamBlocklist(viewer, teamId) : Promise.resolve(null),
    isAdmin ? getGlobalBlocklist(viewer) : Promise.resolve(null),
    recentBlocklistHits(viewer, teamId),
  ]);
  return (
    <>
      <PageHeader
        title="Blocklist and domain rules"
        description="Domains Firecrawl refuses to scrape. Allowed keywords exempt matching URLs. The team list applies to one user's keys; the global list applies to everyone."
      />
      <Alert variant="info">
        <AlertDescription>
          Changes are written to Firecrawl&apos;s blocklist table. The community API reloads it every minute (COMMUNITY_BLOCKLIST_REFRESH_SECONDS).
        </AlertDescription>
      </Alert>
      <BlocklistEditor
        team={team}
        teamId={teamId}
        global={global}
        users={isAdmin ? users.map((user) => ({ value: user.teamId, label: user.label })) : null}
        hits={hits.map((hit) => ({ domain: hit.domain, url: hit.url, createdAt: new Date(hit.created_at).toISOString() }))}
      />
    </>
  );
}
