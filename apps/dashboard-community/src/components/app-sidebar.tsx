"use client";

import {
  ActivityIcon,
  BellIcon,
  BotIcon,
  ChartColumnIcon,
  ChevronsUpDownIcon,
  FlameIcon,
  FlaskConicalIcon,
  GaugeIcon,
  GlobeIcon,
  HourglassIcon,
  KeyRoundIcon,
  LayersIcon,
  ListTreeIcon,
  LogOutIcon,
  RadarIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldBanIcon,
  TableIcon,
  UserIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ComponentType } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Menu, MenuGroupLabel, MenuItem, MenuLinkItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { isActive, NAV, type NavIcon } from "@/lib/nav";

const ICONS: Record<NavIcon, ComponentType> = {
  overview: GaugeIcon,
  keys: KeyRoundIcon,
  logs: ScrollTextIcon,
  jobs: LayersIcon,
  usage: ChartColumnIcon,
  playground: FlaskConicalIcon,
  browser: GlobeIcon,
  monitors: RadarIcon,
  agent: BotIcon,
  health: ActivityIcon,
  users: UsersIcon,
  settings: SettingsIcon,
  features: TableIcon,
  alerts: BellIcon,
  blocklist: ShieldBanIcon,
  retention: HourglassIcon,
};

export type SidebarViewer = { name: string; email: string; role: "admin" | "member" };

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function AppSidebar({ viewer }: { viewer: SidebarViewer }) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" />}>
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <FlameIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate font-heading font-semibold text-sm">Firecrawl</span>
                <span className="truncate text-muted-foreground text-xs">Community dashboard</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAV.map((group) => {
          const items = group.items.filter((item) => !item.adminOnly || viewer.role === "admin");
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarMenu>
                {items.map((item) => {
                  const Icon = ICONS[item.icon];
                  if (item.soon) {
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton disabled aria-disabled tooltip={`${item.title} (coming soon)`}>
                          <Icon />
                          <span>{item.title}</span>
                        </SidebarMenuButton>
                        <SidebarMenuBadge>
                          <Badge variant="outline" size="sm">
                            Soon
                          </Badge>
                        </SidebarMenuBadge>
                      </SidebarMenuItem>
                    );
                  }
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        isActive={isActive(pathname, item.href)}
                        tooltip={item.title}
                        render={<Link href={item.href} />}
                      >
                        <Icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <Menu>
              <MenuTrigger
                render={<SidebarMenuButton size="lg" data-testid="user-menu" />}
              >
                <Avatar className="size-8 rounded-lg">
                  <AvatarFallback className="rounded-lg">{initials(viewer.name)}</AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{viewer.name}</span>
                  <span className="truncate text-muted-foreground text-xs">{viewer.email}</span>
                </div>
                <ChevronsUpDownIcon className="ml-auto size-4" />
              </MenuTrigger>
              <MenuPopup side="top" align="start" className="min-w-56">
                <MenuGroupLabel>
                  Signed in as {viewer.role === "admin" ? "administrator" : "member"}
                </MenuGroupLabel>
                <MenuLinkItem render={<Link href="/profile" />}>
                  <UserIcon /> Profile and security
                </MenuLinkItem>
                <MenuLinkItem render={<Link href="/logs" />}>
                  <ListTreeIcon /> My request log
                </MenuLinkItem>
                <MenuSeparator />
                <MenuItem
                  data-testid="sign-out"
                  onClick={async () => {
                    await authClient.signOut();
                    router.push("/login");
                    router.refresh();
                  }}
                >
                  <LogOutIcon /> Sign out
                </MenuItem>
              </MenuPopup>
            </Menu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
