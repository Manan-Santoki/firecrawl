/**
 * Sidebar sections. A future entry can ship disabled by setting `soon`; the
 * shell renders it as a "Soon" item until its route exists.
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
  | "webhooks"
  | "docs"
  | "notifications"
  | "health"
  | "users"
  | "settings"
  | "features"
  | "alerts"
  | "blocklist"
  | "retention"
  | "audit";

export type NavItem = {
  title: string;
  href: string;
  icon: NavIcon;
  adminOnly?: boolean;
  soon?: string;
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
      { title: "Notifications", href: "/notifications", icon: "notifications" },
    ],
  },
  {
    label: "Build",
    items: [
      { title: "Playground", href: "/playground", icon: "playground" },
      { title: "Browser sessions", href: "/browser", icon: "browser" },
      { title: "Monitors", href: "/monitors", icon: "monitors" },
      { title: "Agent runs", href: "/agent", icon: "agent" },
      { title: "Webhooks", href: "/webhooks", icon: "webhooks" },
      { title: "API docs", href: "/docs", icon: "docs" },
    ],
  },
  {
    label: "Operate",
    items: [
      { title: "Service health", href: "/health", icon: "health" },
      { title: "Feature matrix", href: "/features", icon: "features" },
      { title: "Blocklist", href: "/blocklist", icon: "blocklist" },
      { title: "Users", href: "/users", icon: "users", adminOnly: true },
    ],
  },
  {
    label: "Administration",
    items: [
      { title: "Settings", href: "/settings", icon: "settings", adminOnly: true },
      { title: "Alerts", href: "/alerts", icon: "alerts", adminOnly: true },
      { title: "Retention", href: "/retention", icon: "retention", adminOnly: true },
      { title: "Audit log", href: "/audit", icon: "audit", adminOnly: true },
    ],
  },
];

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
