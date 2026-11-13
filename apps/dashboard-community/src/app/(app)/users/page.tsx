import { PageHeader } from "@/components/page-header";
import { UsersManager } from "@/components/users/users-manager";
import { inviteStatus, listInvites } from "@/lib/server/accounts";
import { requireAdminPage } from "@/lib/server/session";
import { getSettings } from "@/lib/server/settings";
import { listUsers } from "@/lib/server/users";

export const metadata = { title: "Users" };

export default async function UsersPage() {
  const viewer = await requireAdminPage();
  const [users, invites, settings] = await Promise.all([listUsers(viewer), listInvites(viewer), getSettings()]);
  return (
    <>
      <PageHeader
        title="Users"
        description="Each user owns one Firecrawl team. Disabling a user ends their sessions and makes the API reject all of their keys."
      />
      <UsersManager
        users={users}
        currentUserId={viewer.userId}
        defaultInviteRole={settings.invitePolicy.defaultRole}
        invites={invites.map((invite) => ({
          id: invite.id,
          email: invite.email,
          role: invite.role,
          note: invite.note,
          createdAt: new Date(invite.created_at).toISOString(),
          expiresAt: new Date(invite.expires_at).toISOString(),
          usedByEmail: invite.used_by_email,
          status: inviteStatus(invite),
        }))}
      />
    </>
  );
}
