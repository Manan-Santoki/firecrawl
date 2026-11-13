"use client";

import { EllipsisIcon, MailPlusIcon, UsersIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  createInviteAction,
  resetUserPasswordAction,
  revokeInviteAction,
  setUserDisabledAction,
  setUserLimitsAction,
  setUserRoleAction,
} from "@/app/actions/users";
import { CopyButton } from "@/components/copy-button";
import { type DataColumn, DataTable } from "@/components/data-table";
import { LimitsFields, type LimitsValue, parseLimit } from "@/components/limits-fields";
import { SimpleSelect } from "@/components/simple-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { formatCredits, formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import type { UserRow } from "@/lib/server/users";

export type InviteView = {
  id: string;
  email: string | null;
  role: "admin" | "member";
  note: string | null;
  createdAt: string;
  expiresAt: string;
  usedByEmail: string | null;
  status: "pending" | "used" | "revoked" | "expired";
};

type UserDialog =
  | { kind: "none" }
  | { kind: "limits"; user: UserRow }
  | { kind: "disable"; user: UserRow }
  | { kind: "password"; user: UserRow };

function notify(result: { ok: boolean; error?: string }, success: string): boolean {
  if (result.ok) {
    toastManager.add({ type: "success", title: success });
    return true;
  }
  toastManager.add({ type: "error", title: "Action failed", description: result.error });
  return false;
}

export function UsersManager({ users, invites, currentUserId }: { users: UserRow[]; invites: InviteView[]; currentUserId: string }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<UserDialog>({ kind: "none" });
  const [, startTransition] = useTransition();
  const close = () => setDialog({ kind: "none" });

  const userColumns: DataColumn<UserRow>[] = [
    {
      id: "user",
      header: "User",
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-medium">{row.original.name}</span>
          <span className="text-muted-foreground text-xs">{row.original.email}</span>
        </div>
      ),
    },
    {
      id: "role",
      header: "Role",
      cell: ({ row }) => <Badge variant={row.original.role === "admin" ? "info" : "secondary"}>{row.original.role}</Badge>,
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <div className="flex gap-1">
          <Badge variant={row.original.disabled ? "error" : "success"} data-testid={`user-status-${row.original.email}`}>
            {row.original.disabled ? "Disabled" : "Active"}
          </Badge>
          {row.original.twoFactorEnabled && <Badge variant="outline">2FA</Badge>}
        </div>
      ),
    },
    {
      id: "limits",
      header: "Limits",
      cell: ({ row }) => {
        const parts = [];
        if (row.original.creditLimit !== null) parts.push(`${formatCredits(row.original.creditLimit)} / ${row.original.creditLimitInterval}`);
        if (row.original.concurrencyLimit !== null) parts.push(`${row.original.concurrencyLimit} concurrent`);
        return parts.length ? <span className="text-sm">{parts.join(" · ")}</span> : <span className="text-muted-foreground">Default</span>;
      },
    },
    {
      id: "usage",
      header: "Usage",
      cell: ({ row }) => (
        <span className="text-sm tabular-nums">
          {formatNumber(row.original.requests24h)} req today · {formatCredits(row.original.credits30d)} credits / 30d
        </span>
      ),
    },
    {
      id: "keys",
      header: "Keys",
      meta: { className: "text-right" },
      cell: ({ row }) => <span className="tabular-nums">{row.original.keyCount}</span>,
    },
    {
      id: "active",
      header: "Last active",
      cell: ({ row }) => <span className="text-muted-foreground">{formatRelative(row.original.lastActiveAt)}</span>,
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: "w-10 text-right" },
      cell: ({ row }) => {
        const user = row.original;
        const self = user.id === currentUserId;
        return (
          <Menu>
            <MenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${user.email}`} data-testid={`user-actions-${user.email}`} />}>
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setDialog({ kind: "limits", user })} data-testid="menu-limits">
                Set limits
              </MenuItem>
              <MenuItem
                disabled={self}
                onClick={() =>
                  startTransition(async () => {
                    const next = user.role === "admin" ? "member" : "admin";
                    if (notify(await setUserRoleAction(user.id, next), `Role set to ${next}`)) router.refresh();
                  })
                }
              >
                {user.role === "admin" ? "Make member" : "Make admin"}
              </MenuItem>
              <MenuItem disabled={self} onClick={() => setDialog({ kind: "password", user })}>
                Set new password
              </MenuItem>
              <MenuSeparator />
              {user.disabled ? (
                <MenuItem
                  data-testid="menu-enable"
                  onClick={() =>
                    startTransition(async () => {
                      if (notify(await setUserDisabledAction(user.id, false), "User enabled")) router.refresh();
                    })
                  }
                >
                  Enable user
                </MenuItem>
              ) : (
                <MenuItem variant="destructive" disabled={self} data-testid="menu-disable" onClick={() => setDialog({ kind: "disable", user })}>
                  Disable user
                </MenuItem>
              )}
            </MenuPopup>
          </Menu>
        );
      },
    },
  ];

  const inviteColumns: DataColumn<InviteView>[] = [
    {
      id: "email",
      header: "Invitee",
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span>{row.original.email ?? "Anyone with the link"}</span>
          {row.original.note && <span className="text-muted-foreground text-xs">{row.original.note}</span>}
        </div>
      ),
    },
    { id: "role", header: "Role", cell: ({ row }) => <Badge variant="secondary">{row.original.role}</Badge> },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => {
        const status = row.original.status;
        const variant = status === "pending" ? "info" : status === "used" ? "success" : "outline";
        return (
          <Badge variant={variant}>
            {status}
            {status === "used" && row.original.usedByEmail ? ` by ${row.original.usedByEmail}` : ""}
          </Badge>
        );
      },
    },
    { id: "created", header: "Created (UTC)", cell: ({ row }) => <span className="text-muted-foreground">{formatDateTime(row.original.createdAt)}</span> },
    { id: "expires", header: "Expires (UTC)", cell: ({ row }) => <span className="text-muted-foreground">{formatDateTime(row.original.expiresAt)}</span> },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: "text-right" },
      cell: ({ row }) =>
        row.original.status === "pending" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              startTransition(async () => {
                if (notify(await revokeInviteAction(row.original.id), "Invite revoked")) router.refresh();
              })
            }
          >
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <Tabs defaultValue="users">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList>
          <TabsTab value="users">Users ({users.length})</TabsTab>
          <TabsTab value="invites" data-testid="invites-tab">
            Invites ({invites.filter((invite) => invite.status === "pending").length} pending)
          </TabsTab>
        </TabsList>
        <InviteDialog />
      </div>
      <TabsPanel value="users" className="mt-4">
        <DataTable
          columns={userColumns}
          data={users}
          getRowId={(user) => user.id}
          testId="users-table"
          empty={
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <UsersIcon />
                </EmptyMedia>
                <EmptyTitle>No users</EmptyTitle>
              </EmptyHeader>
            </Empty>
          }
        />
      </TabsPanel>
      <TabsPanel value="invites" className="mt-4">
        <DataTable
          columns={inviteColumns}
          data={invites}
          getRowId={(invite) => invite.id}
          testId="invites-table"
          empty={
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No invites yet</EmptyTitle>
                <EmptyDescription>Invite links are single-use and expire.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          }
        />
      </TabsPanel>

      {dialog.kind === "limits" && <UserLimitsDialog user={dialog.user} onClose={close} />}
      {dialog.kind === "password" && <PasswordDialog user={dialog.user} onClose={close} />}
      {dialog.kind === "disable" && (
        <AlertDialog open onOpenChange={(open) => !open && close()}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Disable {dialog.user.email}?</AlertDialogTitle>
              <AlertDialogDescription>
                Their dashboard sessions end now and the Firecrawl API rejects all of their {dialog.user.keyCount} API keys.
                Running jobs are not cancelled. You can enable the user again later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
              <Button
                variant="destructive"
                data-testid="confirm-disable"
                onClick={() =>
                  startTransition(async () => {
                    if (notify(await setUserDisabledAction(dialog.user.id, true), "User disabled")) {
                      close();
                      router.refresh();
                    }
                  })
                }
              >
                Disable user
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      )}
    </Tabs>
  );
}

function InviteDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [note, setNote] = useState("");
  const [ttl, setTtl] = useState("72");
  const [created, setCreated] = useState<{ url: string; expiresAt: string; emailed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setCreated(null);
          setEmail("");
          setNote("");
          setError(null);
          router.refresh();
        }
      }}
    >
      <Button onClick={() => setOpen(true)} data-testid="invite-user">
        <MailPlusIcon /> Invite user
      </Button>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{created ? "Invite link ready" : "Invite a user"}</DialogTitle>
          <DialogDescription>
            {created
              ? created.emailed
                ? "The link was emailed. You can also copy it below."
                : "Send this link to the person you are inviting. It works once."
              : "They get their own Firecrawl team, keys and usage."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {created ? (
            <>
              <div className="flex items-center gap-2">
                <Input readOnly value={created.url} className="font-mono text-xs" data-testid="invite-url" />
                <CopyButton value={created.url} iconOnly label="Copy invite link" />
              </div>
              <p className="text-muted-foreground text-sm">Expires {formatDateTime(created.expiresAt)} UTC.</p>
            </>
          ) : (
            <>
              <Field>
                <FieldLabel>Email (optional)</FieldLabel>
                <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="friend@example.com" />
                <FieldDescription>When set, only this email can redeem the link.</FieldDescription>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>Role</FieldLabel>
                  <SimpleSelect
                    options={[
                      { value: "member", label: "Member" },
                      { value: "admin", label: "Administrator" },
                    ]}
                    value={role}
                    onValueChange={setRole}
                    ariaLabel="Role"
                  />
                </Field>
                <Field>
                  <FieldLabel>Expires after</FieldLabel>
                  <SimpleSelect
                    options={[
                      { value: "24", label: "1 day" },
                      { value: "72", label: "3 days" },
                      { value: "168", label: "7 days" },
                    ]}
                    value={ttl}
                    onValueChange={setTtl}
                    ariaLabel="Expiry"
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel>Note (optional)</FieldLabel>
                <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Who is this for?" />
              </Field>
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          {created ? (
            <DialogClose render={<Button />}>Done</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
              <Button
                loading={pending}
                data-testid="create-invite"
                onClick={() =>
                  startTransition(async () => {
                    const result = await createInviteAction({ email, role, note, ttlHours: Number(ttl) });
                    if (!result.ok) return setError(result.error);
                    setError(null);
                    setCreated(result.data);
                  })
                }
              >
                Create invite link
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function UserLimitsDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const router = useRouter();
  const [value, setValue] = useState<LimitsValue>({
    creditLimit: user.creditLimit === null ? "" : String(user.creditLimit),
    creditLimitInterval: user.creditLimitInterval ?? "month",
    concurrency: user.concurrencyLimit === null ? "" : String(user.concurrencyLimit),
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Limits for {user.name}</DialogTitle>
          <DialogDescription>Applies to every key of this user, on top of any per-key limit.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <LimitsFields
            value={value}
            onChange={setValue}
            concurrencyHelp="Simultaneous scrape jobs for this user. Empty uses the deployment default."
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button
            loading={pending}
            data-testid="save-user-limits"
            onClick={() => {
              const creditLimit = parseLimit(value.creditLimit);
              const concurrencyLimit = parseLimit(value.concurrency);
              if (Number.isNaN(creditLimit) || Number.isNaN(concurrencyLimit) || concurrencyLimit === 0) {
                setError("Limits must be whole numbers (concurrency at least 1).");
                return;
              }
              startTransition(async () => {
                const result = await setUserLimitsAction(user.id, {
                  creditLimit,
                  creditLimitInterval: creditLimit === null ? null : value.creditLimitInterval,
                  concurrencyLimit,
                });
                if (!result.ok) return setError(result.error);
                toastManager.add({ type: "success", title: "Limits saved" });
                onClose();
                router.refresh();
              });
            }}
          >
            Save limits
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PasswordDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Set a new password for {user.name}</DialogTitle>
          <DialogDescription>Their existing sessions end. Share the password with them securely.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Field>
            <FieldLabel>New password</FieldLabel>
            <Input type="password" value={password} minLength={12} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
            <FieldDescription>At least 12 characters.</FieldDescription>
          </Field>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                if (notify(await resetUserPasswordAction(user.id, password), "Password updated")) onClose();
              })
            }
          >
            Set password
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
