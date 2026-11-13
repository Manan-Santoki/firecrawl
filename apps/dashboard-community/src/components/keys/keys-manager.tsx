"use client";

import { EllipsisIcon, KeyRoundIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createKeyAction, renameKeyAction, revokeKeyAction, setKeyLimitsAction } from "@/app/actions/keys";
import { CopyButton } from "@/components/copy-button";
import { type DataColumn, DataTable } from "@/components/data-table";
import { LimitsFields, type LimitsValue, parseLimit } from "@/components/limits-fields";
import { type Option, SimpleSelect } from "@/components/simple-select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toastManager } from "@/components/ui/toast";
import { formatCredits, formatDateTime, formatRelative } from "@/lib/format";
import type { ApiKeyRow } from "@/lib/server/api-keys";

type Dialogs =
  | { kind: "none" }
  | { kind: "limits"; key: ApiKeyRow }
  | { kind: "rename"; key: ApiKeyRow }
  | { kind: "revoke"; key: ApiKeyRow };

function limitsText(key: ApiKeyRow): string {
  const parts: string[] = [];
  if (key.creditLimit !== null) parts.push(`${formatCredits(key.creditLimit)} / ${key.creditLimitInterval ?? "month"}`);
  if (key.concurrency !== null) parts.push(`${key.concurrency} concurrent`);
  return parts.join(" · ");
}

export function KeysManager({
  keys,
  isAdmin,
  ownTeamId,
  owners,
}: {
  keys: ApiKeyRow[];
  isAdmin: boolean;
  ownTeamId: string | null;
  owners: Option[];
}) {
  const [dialog, setDialog] = useState<Dialogs>({ kind: "none" });

  const columns: DataColumn<ApiKeyRow>[] = [
    {
      id: "name",
      header: "Name",
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="font-medium">{row.original.name || "Unnamed key"}</span>
          <span className="font-mono text-muted-foreground text-xs">{row.original.masked}</span>
        </div>
      ),
    },
    ...(isAdmin
      ? ([
          {
            id: "owner",
            header: "Owner",
            cell: ({ row }) =>
              row.original.ownerEmail ? (
                <span className="text-sm">{row.original.ownerEmail}</span>
              ) : (
                <Badge variant="outline">No dashboard user</Badge>
              ),
          },
        ] satisfies DataColumn<ApiKeyRow>[])
      : []),
    {
      id: "limits",
      header: "Limits",
      cell: ({ row }) => {
        const text = limitsText(row.original);
        return text ? <span className="text-sm">{text}</span> : <span className="text-muted-foreground">None</span>;
      },
    },
    {
      id: "credits",
      header: "Credits (30d)",
      meta: { className: "text-right" },
      cell: ({ row }) => <span className="tabular-nums">{formatCredits(row.original.creditsUsed30d)}</span>,
    },
    {
      id: "lastUsed",
      header: "Last used",
      cell: ({ row }) => <span className="text-muted-foreground">{formatRelative(row.original.lastUsedAt)}</span>,
    },
    {
      id: "created",
      header: "Created (UTC)",
      cell: ({ row }) => <span className="text-muted-foreground">{formatDateTime(row.original.createdAt)}</span>,
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      meta: { className: "w-10 text-right" },
      cell: ({ row }) => (
        <Menu>
          <MenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.original.name ?? "key"}`} />}
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setDialog({ kind: "rename", key: row.original })}>Rename</MenuItem>
            <MenuItem onClick={() => setDialog({ kind: "limits", key: row.original })}>Edit limits</MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => setDialog({ kind: "revoke", key: row.original })}>
              Revoke
            </MenuItem>
          </MenuPopup>
        </Menu>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <CreateKeyDialog isAdmin={isAdmin} ownTeamId={ownTeamId} owners={owners} />
      </div>
      <DataTable
        columns={columns}
        data={keys}
        getRowId={(key) => String(key.id)}
        testId="keys-table"
        empty={
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KeyRoundIcon />
              </EmptyMedia>
              <EmptyTitle>No API keys yet</EmptyTitle>
              <EmptyDescription>Create a key to call this deployment’s Firecrawl API.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
      />
      {dialog.kind === "limits" && (
        <KeyLimitsDialog apiKey={dialog.key} onClose={() => setDialog({ kind: "none" })} />
      )}
      {dialog.kind === "rename" && <RenameDialog apiKey={dialog.key} onClose={() => setDialog({ kind: "none" })} />}
      {dialog.kind === "revoke" && <RevokeDialog apiKey={dialog.key} onClose={() => setDialog({ kind: "none" })} />}
    </div>
  );
}

function CreateKeyDialog({ isAdmin, ownTeamId, owners }: { isAdmin: boolean; ownTeamId: string | null; owners: Option[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [teamId, setTeamId] = useState<string | null>(ownTeamId);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setCreated(null);
          setName("");
          setError(null);
          router.refresh();
        }
      }}
    >
      <Button onClick={() => setOpen(true)} data-testid="create-key" disabled={!ownTeamId && !isAdmin}>
        <PlusIcon /> Create key
      </Button>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{created ? "Copy your new key" : "Create API key"}</DialogTitle>
          <DialogDescription>
            {created
              ? "This is the only time the full key is shown. Store it in a secret manager."
              : "Use it as a Bearer token with this deployment’s Firecrawl API."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {created ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Input readOnly value={created} className="font-mono" data-testid="new-key-value" />
                <CopyButton value={created} iconOnly label="Copy key" />
              </div>
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertTitle>Shown once</AlertTitle>
                <AlertDescription>Closing this dialog hides the key permanently. Revoke and recreate it if lost.</AlertDescription>
              </Alert>
            </div>
          ) : (
            <Form
              id="create-key-form"
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                startTransition(async () => {
                  const result = await createKeyAction({ name, teamId: isAdmin ? teamId : null });
                  if (result.ok) {
                    setCreated(result.data.key);
                    setError(null);
                  } else {
                    setError(result.error);
                  }
                });
              }}
            >
              {error && (
                <Alert variant="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. laptop scripts"
                  required
                  data-testid="new-key-name"
                />
              </Field>
              {isAdmin && owners.length > 0 && (
                <Field>
                  <FieldLabel>Owner</FieldLabel>
                  <SimpleSelect options={owners} value={teamId} onValueChange={setTeamId} ariaLabel="Owner" />
                </Field>
              )}
            </Form>
          )}
        </DialogPanel>
        <DialogFooter>
          {created ? (
            <DialogClose render={<Button data-testid="close-new-key" />}>Done</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
              <Button type="submit" form="create-key-form" loading={pending} data-testid="submit-new-key">
                Create key
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function KeyLimitsDialog({ apiKey, onClose }: { apiKey: ApiKeyRow; onClose: () => void }) {
  const router = useRouter();
  const [value, setValue] = useState<LimitsValue>({
    creditLimit: apiKey.creditLimit === null ? "" : String(apiKey.creditLimit),
    creditLimitInterval: apiKey.creditLimitInterval ?? "month",
    concurrency: apiKey.concurrency === null ? "" : String(apiKey.concurrency),
  });
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Limits for {apiKey.name || apiKey.masked}</DialogTitle>
          <DialogDescription>Limits on one key never raise the owner’s own limits.</DialogDescription>
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
            concurrencyHelp="Per-key concurrency is enforced by the FoundationDB queue backend (NUQ_BACKEND=fdb) only; the PostgreSQL queue applies the owner’s concurrency."
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button
            loading={pending}
            data-testid="save-limits"
            onClick={() => {
              const creditLimit = parseLimit(value.creditLimit);
              const concurrency = parseLimit(value.concurrency);
              if (Number.isNaN(creditLimit) || Number.isNaN(concurrency) || concurrency === 0) {
                setError("Limits must be whole numbers (concurrency at least 1).");
                return;
              }
              startTransition(async () => {
                const result = await setKeyLimitsAction(apiKey.id, {
                  creditLimit,
                  creditLimitInterval: creditLimit === null ? null : (value.creditLimitInterval as "day" | "week" | "month"),
                  concurrency,
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

function RenameDialog({ apiKey, onClose }: { apiKey: ApiKeyRow; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(apiKey.name ?? "");
  const [pending, startTransition] = useTransition();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Rename key</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await renameKeyAction(apiKey.id, name);
                if (!result.ok) {
                  toastManager.add({ type: "error", title: "Rename failed", description: result.error });
                  return;
                }
                onClose();
                router.refresh();
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RevokeDialog({ apiKey, onClose }: { apiKey: ApiKeyRow; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {apiKey.name || apiKey.masked}?</AlertDialogTitle>
          <AlertDialogDescription>
            Requests with this key are rejected immediately. Its request history stays in the log. This cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            loading={pending}
            data-testid="confirm-revoke"
            onClick={() =>
              startTransition(async () => {
                const result = await revokeKeyAction(apiKey.id);
                if (!result.ok) {
                  toastManager.add({ type: "error", title: "Revoke failed", description: result.error });
                  return;
                }
                toastManager.add({ type: "success", title: "Key revoked" });
                onClose();
                router.refresh();
              })
            }
          >
            Revoke key
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
