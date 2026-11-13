import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "./auth";
import { assertAdmin, type Viewer } from "./authz";

/** The signed-in dashboard user for this request, or null. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) return null;
  const user = session.user as typeof session.user & {
    role?: string | null;
    teamId?: string | null;
    banned?: boolean | null;
    twoFactorEnabled?: boolean | null;
  };
  if (user.banned) return null;
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role === "admin" ? "admin" : "member",
    teamId: user.teamId ?? null,
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
  };
});

/** For pages: the viewer, or a redirect to the login page. */
export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  return viewer;
}

/** For admin-only pages: non-admins are sent to the overview. */
export async function requireAdminPage(): Promise<Viewer> {
  const viewer = await requireViewer();
  if (viewer.role !== "admin") redirect("/");
  return viewer;
}

/** For server actions and route handlers: throws instead of redirecting. */
export async function actionViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new Error("Your session has expired. Sign in again.");
  return viewer;
}

export async function actionAdmin(): Promise<Viewer> {
  const viewer = await actionViewer();
  assertAdmin(viewer);
  return viewer;
}
