import "server-only";
import { actingKey } from "./acting-key";
import type { Viewer } from "./authz";
import { firecrawlRequest } from "./firecrawl-api";

/**
 * Calls the Firecrawl API as `teamId` (which the viewer must be allowed to
 * manage). Admins acting on another user's resources use that user's team
 * key, so ownership checks in the API still hold.
 */
export async function callAs<T = unknown>(
  viewer: Viewer,
  teamId: string,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const key = await actingKey(viewer, { teamId });
  return firecrawlRequest<T>(key.key, path, init);
}
