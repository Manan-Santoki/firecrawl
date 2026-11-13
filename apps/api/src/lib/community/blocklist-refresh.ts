import { config } from "../../config";
import { logger as _logger } from "../logger";
import { initializeBlocklist } from "../../scraper/WebScraper/utils/blocklist";

const logger = _logger.child({ module: "community-blocklist-refresh" });

let timer: NodeJS.Timeout | null = null;

/**
 * Reloads the blocklist table periodically so changes made in the community
 * dashboard apply without restarting the API and workers. Upstream loads it
 * once at startup. A failed reload keeps the previous list.
 */
export function startCommunityBlocklistRefresh(): void {
  if (
    timer !== null ||
    config.USE_DB_AUTHENTICATION !== true ||
    config.DISABLE_BLOCKLIST ||
    config.COMMUNITY_BLOCKLIST_REFRESH_SECONDS === 0
  ) {
    return;
  }
  timer = setInterval(() => {
    initializeBlocklist().catch(error => {
      logger.warn("Blocklist reload failed; keeping the previous list", {
        error,
      });
    });
  }, config.COMMUNITY_BLOCKLIST_REFRESH_SECONDS * 1000);
  timer.unref?.();
}
