import { AuditTable } from "@/components/operate/audit-table";
import { PageHeader } from "@/components/page-header";
import { listAuditLog } from "@/lib/server/audit-log";
import { requireAdminPage } from "@/lib/server/session";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const viewer = await requireAdminPage();
  const params = await searchParams;
  const action = typeof params.action === "string" ? params.action.slice(0, 50) : null;
  const q = typeof params.q === "string" ? params.q.slice(0, 200) : null;
  const rows = await listAuditLog(viewer, { action, q });
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Sign-ins, invites, key changes, limits, settings and user changes. Append-only; secrets are never recorded."
      />
      <AuditTable rows={rows} action={action} q={q} />
    </>
  );
}
