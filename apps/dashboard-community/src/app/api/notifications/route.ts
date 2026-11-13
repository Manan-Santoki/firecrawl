import { listNotifications, unreadCount } from "@/lib/server/notifications";
import { getViewer } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** The signed-in user's unread count and newest notifications (polled by the header bell). */
export async function GET(request: Request) {
  const viewer = await getViewer();
  if (!viewer) return new Response("Unauthorized", { status: 401 });
  const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
  const [unread, items] = await Promise.all([
    unreadCount(viewer),
    listNotifications(viewer, { limit: 10, afterId: Number.isInteger(after) && after > 0 ? after : 0 }),
  ]);
  return Response.json({ unread, items }, { headers: { "Cache-Control": "no-store" } });
}
