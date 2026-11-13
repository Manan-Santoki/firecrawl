"use client";

import { CornerDownLeftIcon, SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandDialogTrigger,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { NAV } from "@/lib/nav";
import { THEME_COOKIE } from "@/lib/theme";

type Item = { value: string; label: string; shortcut?: string; run: () => void };
type Group = { value: string; items: Item[] };

/** Two-key "g then x" navigation shortcuts, shown in the palette. */
const GO_KEYS: Record<string, string> = {
  o: "/",
  k: "/keys",
  l: "/logs",
  j: "/jobs",
  u: "/usage",
  p: "/playground",
  h: "/health",
  n: "/notifications",
  d: "/docs",
};

function setTheme(theme: "light" | "dark") {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.themePreference = theme;
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
}

/** Ctrl/Cmd+K palette for navigation and common actions, plus "g" shortcuts. */
export function CommandPalette({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const pendingG = useRef<number>(0);

  const groups: Group[] = useMemo(() => {
    const shortcutFor = (href: string) => {
      const key = Object.entries(GO_KEYS).find(([, path]) => path === href)?.[0];
      return key ? `G ${key.toUpperCase()}` : undefined;
    };
    const pages: Item[] = NAV.flatMap((group) =>
      group.items
        .filter((item) => !item.soon && (!item.adminOnly || isAdmin))
        .map((item) => ({ value: `page:${item.href}`, label: item.title, shortcut: shortcutFor(item.href), run: () => router.push(item.href) })),
    );
    const actions: Item[] = [
      { value: "action:new-key", label: "Create an API key", run: () => router.push("/keys") },
      { value: "action:playground", label: "Run a scrape in the playground", run: () => router.push("/playground") },
      { value: "action:monitor", label: "New monitor", run: () => router.push("/monitors") },
      { value: "action:profile", label: "Profile, password and 2FA", run: () => router.push("/profile") },
      { value: "action:light", label: "Switch to light theme", run: () => setTheme("light") },
      { value: "action:dark", label: "Switch to dark theme", run: () => setTheme("dark") },
      ...(isAdmin
        ? [
            { value: "action:invite", label: "Invite a user", run: () => router.push("/users") },
            { value: "action:audit", label: "Open the audit log", run: () => router.push("/audit") },
          ]
        : []),
    ];
    return [
      { value: "Pages", items: pages },
      { value: "Actions", items: actions },
    ];
  }, [isAdmin, router]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "g") {
        pendingG.current = Date.now();
        return;
      }
      if (Date.now() - pendingG.current < 1000 && GO_KEYS[event.key]) {
        pendingG.current = 0;
        router.push(GO_KEYS[event.key]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandDialogTrigger
        render={<Button variant="outline" size="sm" className="hidden gap-2 text-muted-foreground sm:inline-flex" data-testid="command-trigger" />}
      >
        <SearchIcon /> Search
        <KbdGroup>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </CommandDialogTrigger>
      <CommandDialogPopup aria-label="Command palette" data-testid="command-palette">
        <Command items={groups}>
          <CommandInput placeholder="Go to a page or run an action…" />
          <CommandPanel>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandList>
              {(group: Group, index: number) => (
                <Fragment key={group.value}>
                  <CommandGroup items={group.items}>
                    <CommandGroupLabel>{group.value}</CommandGroupLabel>
                    <CommandCollection>
                      {(item: Item) => (
                        <CommandItem
                          key={item.value}
                          value={item}
                          onClick={() => {
                            setOpen(false);
                            item.run();
                          }}
                        >
                          <span className="flex-1">{item.label}</span>
                          {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
                        </CommandItem>
                      )}
                    </CommandCollection>
                  </CommandGroup>
                  {index < groups.length - 1 && <CommandSeparator />}
                </Fragment>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <span className="flex items-center gap-2">
              <KbdGroup>
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
              </KbdGroup>
              Navigate
            </span>
            <span className="flex items-center gap-2">
              <Kbd>
                <CornerDownLeftIcon />
              </Kbd>
              Open
            </span>
            <span className="flex items-center gap-2">
              <Kbd>Esc</Kbd>
              Close
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
