"use client";

import { BellIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { markNotificationsReadAction } from "@/app/actions/operate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toastManager } from "@/components/ui/toast";
import { formatRelative } from "@/lib/format";
import type { NotificationRow } from "@/lib/server/notifications";

/** Header bell: unread count, a short list, and a toast for each new notification. */
export function NotificationBell() {
  const router = useRouter();
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const newest = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/notifications`, { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { unread: number; items: NotificationRow[] };
      setUnread(data.unread);
      setItems(data.items);
      const top = data.items[0]?.id ?? 0;
      if (newest.current !== null) {
        for (const item of data.items.filter((entry) => entry.id > newest.current! && !entry.readAt).reverse()) {
          toastManager.add({ type: item.kind === "alert" ? "warning" : "info", title: item.title, description: item.body ?? undefined });
        }
      }
      newest.current = Math.max(newest.current ?? 0, top);
    } catch {
      // Offline or signed out: try again on the next tick.
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [load]);

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="icon" aria-label={`Notifications (${unread} unread)`} className="relative" data-testid="notification-bell" />}>
        <BellIcon />
        {unread > 0 && (
          <Badge size="sm" className="-top-1 -right-1 absolute min-w-5 px-1" data-testid="notification-count">
            {unread > 99 ? "99+" : unread}
          </Badge>
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="font-medium text-sm">Notifications</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={unread === 0}
            onClick={async () => {
              await markNotificationsReadAction("all");
              await load();
              router.refresh();
            }}
          >
            Mark all read
          </Button>
        </div>
        <ScrollArea className="max-h-80">
          {items.length === 0 ? (
            <p className="p-4 text-center text-muted-foreground text-sm">You&apos;re all caught up.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {items.map((item) => (
                <li key={item.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
                  <span className={item.readAt ? "text-muted-foreground" : "font-medium"}>{item.title}</span>
                  {item.body && <span className="line-clamp-2 text-muted-foreground text-xs">{item.body}</span>}
                  <span className="text-muted-foreground text-xs">{formatRelative(item.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
        <div className="border-t p-2">
          <Button variant="outline" size="sm" className="w-full" render={<Link href="/notifications" />}>
            View all
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
