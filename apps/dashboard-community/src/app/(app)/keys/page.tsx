import { PageHeader } from "@/components/page-header";
import { KeysManager } from "@/components/keys/keys-manager";
import { listApiKeys } from "@/lib/server/api-keys";
import { requireViewer } from "@/lib/server/session";
import { listUserOptions } from "@/lib/server/users";

export const metadata = { title: "API keys" };

export default async function KeysPage() {
  const viewer = await requireViewer();
  const [keys, owners] = await Promise.all([listApiKeys(viewer), listUserOptions(viewer)]);
  return (
    <>
      <PageHeader
        title="API keys"
        description={
          viewer.role === "admin"
            ? "Every key on this deployment. Keys belong to one user's team; limits apply per key."
            : "Keys for your own Firecrawl team. A new key is shown once, so copy it before closing the dialog."
        }
      />
      <KeysManager
        keys={keys}
        isAdmin={viewer.role === "admin"}
        ownTeamId={viewer.teamId}
        owners={owners.map((owner) => ({ value: owner.teamId, label: owner.label }))}
      />
    </>
  );
}
