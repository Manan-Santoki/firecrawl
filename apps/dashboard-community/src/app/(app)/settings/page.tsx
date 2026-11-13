import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SettingsForms } from "@/components/operate/settings-forms";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { requireAdminPage } from "@/lib/server/session";
import { effectiveConfig, getSettings } from "@/lib/server/settings";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  await requireAdminPage();
  const [settings, config] = await Promise.all([getSettings(), Promise.resolve(effectiveConfig())]);
  return (
    <>
      <PageHeader
        title="Settings"
        description="Effective configuration of this deployment (read-only, secrets masked) and the defaults the dashboard stores."
        actions={
          <Button variant="outline" render={<Link href="/health" />}>
            Service health
          </Button>
        }
      />
      <SettingsForms defaultLimits={settings.defaultLimits} invitePolicy={settings.invitePolicy} />
      <div className="grid gap-4 lg:grid-cols-2" data-testid="effective-config">
        {config.map((group) => (
          <Card key={group.group}>
            <CardHeader>
              <CardTitle>{group.group}</CardTitle>
              <CardDescription>From the dashboard&apos;s environment.</CardDescription>
            </CardHeader>
            <CardPanel>
              <dl className="grid grid-cols-[minmax(9rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
                {group.items.map((item) => (
                  <div key={item.label} className="contents">
                    <dt className="text-muted-foreground">{item.label}</dt>
                    <dd className="break-all font-mono text-xs">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </CardPanel>
          </Card>
        ))}
      </div>
    </>
  );
}
