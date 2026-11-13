/**
 * Authorization rules shared by every page, server action and route handler.
 * Pure functions so the cross-user rules are unit-tested in isolation; the
 * database helpers always filter by the scope these return.
 */

export type Role = "admin" | "member";

export type Viewer = {
  userId: string;
  email: string;
  name: string;
  role: Role;
  teamId: string | null;
  twoFactorEnabled: boolean;
};

/** Teams a query may read: every team, or an explicit list. */
export type Scope = { kind: "all" } | { kind: "teams"; teamIds: string[] };

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "You do not have access to this resource.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function isAdmin(viewer: Viewer): boolean {
  return viewer.role === "admin";
}

/**
 * The scope for a read. Members always get exactly their own team, and asking
 * for anyone else's team is an error rather than a silent fallback. Admins get
 * everything, or the one team they filtered on.
 */
export function resolveScope(viewer: Viewer, requestedTeamId?: string | null): Scope {
  if (isAdmin(viewer)) {
    return requestedTeamId ? { kind: "teams", teamIds: [requestedTeamId] } : { kind: "all" };
  }
  if (!viewer.teamId) {
    return { kind: "teams", teamIds: [] };
  }
  if (requestedTeamId && requestedTeamId !== viewer.teamId) {
    throw new ForbiddenError();
  }
  return { kind: "teams", teamIds: [viewer.teamId] };
}

/** Throws unless the viewer may manage resources that belong to `teamId`. */
export function assertCanManageTeam(viewer: Viewer, teamId: string | null | undefined): void {
  if (!teamId) throw new ForbiddenError();
  if (isAdmin(viewer)) return;
  if (viewer.teamId !== teamId) throw new ForbiddenError();
}

export function assertAdmin(viewer: Viewer): void {
  if (!isAdmin(viewer)) throw new ForbiddenError("Administrator access is required.");
}

/**
 * Appends a team filter for `column` to a parameter list and returns the SQL
 * fragment. An empty team list matches nothing (never everything).
 */
export function scopeClause(scope: Scope, column: string, params: unknown[]): string {
  if (scope.kind === "all") return "TRUE";
  if (scope.teamIds.length === 0) return "FALSE";
  params.push(scope.teamIds);
  // Compared as text so uuid and text team columns (browser_sessions) both work.
  return `${column}::text = ANY($${params.length}::text[])`;
}
