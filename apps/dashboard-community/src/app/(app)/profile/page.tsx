import { headers } from "next/headers";
import { PageHeader } from "@/components/page-header";
import { ProfileForms } from "@/components/profile/profile-forms";
import { auth } from "@/lib/server/auth";
import { requireViewer } from "@/lib/server/session";
import { getTeamLimitsForViewer } from "@/lib/server/users";

export const metadata = { title: "Profile and security" };

export default async function ProfilePage() {
  const viewer = await requireViewer();
  const requestHeaders = await headers();
  const [sessions, current, limits] = await Promise.all([
    auth().api.listSessions({ headers: requestHeaders }),
    auth().api.getSession({ headers: requestHeaders }),
    getTeamLimitsForViewer(viewer),
  ]);
  return (
    <>
      <PageHeader title="Profile and security" description="Your account, password, two-factor authentication and sessions." />
      <ProfileForms
        name={viewer.name}
        email={viewer.email}
        role={viewer.role}
        teamId={viewer.teamId}
        twoFactorEnabled={viewer.twoFactorEnabled}
        limits={limits}
        currentSessionToken={current?.session.token ?? null}
        sessions={sessions.map((session) => ({
          id: session.id,
          token: session.token,
          userAgent: session.userAgent ?? null,
          ipAddress: session.ipAddress ?? null,
          createdAt: new Date(session.createdAt).toISOString(),
          updatedAt: new Date(session.updatedAt).toISOString(),
        }))}
      />
    </>
  );
}
