import { redirect } from "next/navigation";
import { bootstrapAction } from "@/app/actions/auth";
import { AccountForm } from "@/components/auth/account-form";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { needsBootstrap } from "@/lib/server/accounts";
import { env } from "@/lib/server/env";

export const metadata = { title: "Set up" };

export default async function BootstrapPage() {
  if (!(await needsBootstrap())) redirect("/login");
  if (!env().DASHBOARD_BOOTSTRAP_TOKEN) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Bootstrap is disabled</EmptyTitle>
          <EmptyDescription>
            Set DASHBOARD_BOOTSTRAP_TOKEN on the dashboard service and reload this page to create the first
            administrator.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create the administrator</CardTitle>
        <CardDescription>
          This one-time step creates the owner account. After it, sign-up closes and new people join by invite.
        </CardDescription>
      </CardHeader>
      <CardPanel>
        <AccountForm action={bootstrapAction} askToken submitLabel="Create administrator" />
      </CardPanel>
    </Card>
  );
}
