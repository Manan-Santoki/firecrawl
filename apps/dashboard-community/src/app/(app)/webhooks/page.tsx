import { WebhooksManager } from "@/components/operate/webhooks-manager";
import { PageHeader } from "@/components/page-header";
import { requireViewer } from "@/lib/server/session";
import { listWebhooks, recentDeliveries } from "@/lib/server/webhooks";

export const metadata = { title: "Webhooks" };

export default async function WebhooksPage() {
  const viewer = await requireViewer();
  const [webhooks, deliveries] = await Promise.all([listWebhooks(viewer), recentDeliveries(viewer)]);
  return (
    <>
      <PageHeader
        title="Webhooks"
        description="Default webhook URLs for your crawls, batch scrapes and agent runs. The playground attaches them automatically; use the URL in your own requests' webhook field."
      />
      <WebhooksManager webhooks={webhooks} deliveries={deliveries} />
    </>
  );
}
