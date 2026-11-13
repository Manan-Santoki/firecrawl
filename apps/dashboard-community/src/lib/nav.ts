/**
 * Sidebar sections. Later releases switch an entry on by flipping `soon` and
 * adding its route; nothing else in the shell needs to change.
 */
export type NavIcon =
  | "overview"
  | "keys"
  | "logs"
  | "jobs"
  | "usage"
  | "playground"
  | "browser"
  | "monitors"
  | "agent"
  | "health"
  | "users"
  | "settings"
  | "features"
  | "alerts"
  | "blocklist"
  | "retention";

export type NavItem = {
  title: string;
  href: string;
  icon: NavIcon;
  adminOnly?: boolean;
  soon?: "v2" | "v3";
};

export type NavGroup = { label: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { title: "Overview", href: "/", icon: "overview" },
      { title: "API keys", href: "/keys", icon: "keys" },
      { title: "Request log", href: "/logs", icon: "logs" },
      { title: "Jobs", href: "/jobs", icon: "jobs" },
      { title: "Usage", href: "/usage", icon: "usage" },
    ],
  },
  {
    label: "Build",
    items: [
      { title: "Playground", href: "/playground", icon: "playground" },
      { title: "Browser sessions", href: "/browser", icon: "browser" },
      { title: "Monitors", href: "/monitors", icon: "monitors" },
      { title: "Agent runs", href: "/agent", icon: "agent" },
    ],
  },
  {
    label: "Operate",
    items: [
      { title: "Service health", href: "/health", icon: "health" },
      { title: "Users", href: "/users", icon: "users", adminOnly: true },
    ],
  },
  {
    label: "Administration",
    items: [
      { title: "Settings", href: "/settings", icon: "settings", adminOnly: true, soon: "v3" },
      { title: "Feature matrix", href: "/features", icon: "features", soon: "v3" },
      { title: "Alerts", href: "/alerts", icon: "alerts", adminOnly: true, soon: "v3" },
      { title: "Blocklist", href: "/blocklist", icon: "blocklist", adminOnly: true, soon: "v3" },
      { title: "Retention", href: "/retention", icon: "retention", adminOnly: true, soon: "v3" },
    ],
  },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
