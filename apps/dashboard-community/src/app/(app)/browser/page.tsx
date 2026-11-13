import { BrowserManager } from "@/components/browser/browser-manager";
import { PageHeader } from "@/components/page-header";
import { listBrowserProfiles, listBrowserSessions } from "@/lib/server/browser";
import { requireViewer } from "@/lib/server/session";

export const metadata = { title: "Browser sessions" };

export default async function BrowserPage({ searchParams }: PageProps<"/browser">) {
  const viewer = await requireViewer();
  const includeClosed = (await searchParams).closed === "1";
  const [sessions, profiles] = await Promise.all([
    listBrowserSessions(viewer, { includeClosed }),
    listBrowserProfiles(viewer),
  ]);
  return (
    <>
      <PageHeader
        title="Browser sessions"
        description="Remote browsers for interactive automation. Open Live View, run Node, Python or Bash against a session, and manage saved profiles."
      />
      <BrowserManager sessions={sessions} profiles={profiles} isAdmin={viewer.role === "admin"} includeClosed={includeClosed} />
    </>
  );
}
