import { PageHeader } from "@/components/page-header";
import { Playground } from "@/components/playground/playground";
import { listApiKeys } from "@/lib/server/api-keys";
import { env } from "@/lib/server/env";
import { listHistory } from "@/lib/server/playground";
import { requireViewer } from "@/lib/server/session";

export const metadata = { title: "Playground" };

export default async function PlaygroundPage() {
  const viewer = await requireViewer();
  const [keys, history] = await Promise.all([
    listApiKeys(viewer, viewer.teamId),
    listHistory(viewer),
  ]);
  const config = env();
  return (
    <>
      <PageHeader
        title="Playground"
        description="Try every v2 endpoint with your own key, see rendered results, and copy the request as curl, Python or JavaScript."
      />
      <Playground
        keys={keys.filter((key) => key.teamId === viewer.teamId).map((key) => ({ value: String(key.id), label: `${key.name || "Unnamed"} (${key.masked})` }))}
        history={history}
        apiUrl={(config.FIRECRAWL_PUBLIC_API_URL ?? config.FIRECRAWL_API_URL).replace(/\/$/, "")}
      />
    </>
  );
}
