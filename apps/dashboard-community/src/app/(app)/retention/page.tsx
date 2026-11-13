import { RetentionManager } from "@/components/operate/retention-manager";
import { PageHeader } from "@/components/page-header";
import { cleanupHistory, retentionSizes } from "@/lib/server/cleanup";
import { env } from "@/lib/server/env";
import { requireAdminPage } from "@/lib/server/session";
import { getSettings } from "@/lib/server/settings";

export const metadata = { title: "Retention" };

export default async function RetentionPage() {
  await requireAdminPage();
  const [settings, runs, sizes] = await Promise.all([getSettings(), cleanupHistory(), retentionSizes()]);
  return (
    <>
      <PageHeader
        title="Retention"
        description="How long the dashboard keeps request logs, playground history, alerts and notifications. Cleanup runs hourly; purge any job now."
      />
      <RetentionManager
        retention={settings.retention}
        apiRetentionDays={env().COMMUNITY_REQUEST_LOG_RETENTION_DAYS}
        runs={runs}
        sizes={Object.fromEntries(Object.entries(sizes).map(([key, value]) => [key, value === null ? null : String(value)]))}
      />
    </>
  );
}
