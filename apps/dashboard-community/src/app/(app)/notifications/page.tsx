import { NotificationsView } from "@/components/operate/notifications-view";
import { PageHeader } from "@/components/page-header";
import { getPreferences, listNotifications } from "@/lib/server/notifications";
import { requireViewer } from "@/lib/server/session";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const viewer = await requireViewer();
  const [items, preferences] = await Promise.all([listNotifications(viewer, { limit: 200 }), getPreferences(viewer)]);
  return (
    <>
      <PageHeader title="Notifications" description="Alerts, accepted invites and finished jobs. Only you can see your notifications." />
      <NotificationsView items={items} preferences={preferences} />
    </>
  );
}
