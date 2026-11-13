import Link from "next/link";
import { acceptInviteAction } from "@/app/actions/auth";
import { AccountForm } from "@/components/auth/account-form";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { findUsableInvite } from "@/lib/server/accounts";

export const metadata = { title: "Accept invite" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const invite = await findUsableInvite(token);
  if (!invite) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>This invite can’t be used</EmptyTitle>
          <EmptyDescription>
            The link is invalid, has expired, was revoked, or has already been used. Ask the administrator for a new
            one.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" render={<Link href="/login" />}>
            Go to sign in
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Join this Firecrawl deployment</CardTitle>
        <CardDescription>
          You get your own Firecrawl team: your API keys, usage and jobs are kept separate from everyone else’s.
        </CardDescription>
      </CardHeader>
      <CardPanel>
        <AccountForm
          action={acceptInviteAction}
          token={token}
          defaultEmail={invite.email}
          submitLabel="Create account"
        />
      </CardPanel>
    </Card>
  );
}
