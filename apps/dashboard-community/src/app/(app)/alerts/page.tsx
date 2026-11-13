import { AlertsManager } from "@/components/operate/alerts-manager";
import { PageHeader } from "@/components/page-header";
import { listEvents, listRules } from "@/lib/server/alerts";
import { env } from "@/lib/server/env";
import { requireAdminPage } from "@/lib/server/session";
import { getSettings } from "@/lib/server/settings";

export const metadata = { title: "Alerts" };

export default async function AlertsPage() {
  const viewer = await requireAdminPage();
  const [rules, events, settings] = await Promise.all([listRules(viewer), listEvents(viewer), getSettings()]);
  return (
    <>
      <PageHeader
        title="Alerts"
        description="Rules are evaluated every minute. Alerts go to administrators in-app, by email (when SMTP is configured) and to a signed webhook. Users get their own credit-limit alerts unless they opt out."
      />
      <AlertsManager
        rules={rules}
        events={events}
        webhookUrl={settings.alertWebhook.url}
        webhookSecretSet={Boolean(settings.alertWebhook.secret)}
        smtpConfigured={Boolean(env().SMTP_HOST && env().SMTP_FROM)}
      />
    </>
  );
}
