"use client";

import { ShieldCheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CopyButton } from "@/components/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";
import { formatCredits, formatDateTime, formatRelative } from "@/lib/format";

type SessionView = {
  id: string;
  token: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  updatedAt: string;
};

function errorToast(title: string, message?: string) {
  toastManager.add({ type: "error", title, description: message });
}

export function ProfileForms(props: {
  name: string;
  email: string;
  role: "admin" | "member";
  teamId: string | null;
  twoFactorEnabled: boolean;
  limits: { credit_limit: number | null; credit_limit_interval: string | null; concurrency_limit: number | null } | null;
  sessions: SessionView[];
  currentSessionToken: string | null;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <AccountCard {...props} />
      <PasswordCard />
      <TwoFactorCard enabled={props.twoFactorEnabled} />
      <SessionsCard sessions={props.sessions} currentToken={props.currentSessionToken} />
    </div>
  );
}

function AccountCard({
  name,
  email,
  role,
  teamId,
  limits,
}: {
  name: string;
  email: string;
  role: string;
  teamId: string | null;
  limits: { credit_limit: number | null; credit_limit_interval: string | null; concurrency_limit: number | null } | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [pending, startTransition] = useTransition();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>
          {email} · <Badge variant="secondary">{role}</Badge>
        </CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        <Field>
          <FieldLabel>Display name</FieldLabel>
          <Input value={value} onChange={(event) => setValue(event.target.value)} />
        </Field>
        <dl className="grid grid-cols-[9rem_1fr] gap-y-1 text-sm">
          <dt className="text-muted-foreground">Firecrawl team</dt>
          <dd className="break-all font-mono text-xs">{teamId ?? "–"}</dd>
          <dt className="text-muted-foreground">Credit limit</dt>
          <dd>
            {limits?.credit_limit !== null && limits?.credit_limit !== undefined
              ? `${formatCredits(limits.credit_limit)} per ${limits.credit_limit_interval}`
              : "None"}
          </dd>
          <dt className="text-muted-foreground">Concurrency</dt>
          <dd>{limits?.concurrency_limit ?? "Deployment default"}</dd>
        </dl>
      </CardPanel>
      <CardFooter>
        <Button
          loading={pending}
          disabled={value.trim() === "" || value === name}
          onClick={() =>
            startTransition(async () => {
              const { error } = await authClient.updateUser({ name: value.trim() });
              if (error) return errorToast("Update failed", error.message);
              toastManager.add({ type: "success", title: "Name updated" });
              router.refresh();
            })
          }
        >
          Save
        </Button>
      </CardFooter>
    </Card>
  );
}

function PasswordCard() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Changing it signs out your other sessions.</CardDescription>
      </CardHeader>
      <Form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const next = String(data.get("newPassword") ?? "");
          if (next !== String(data.get("confirm") ?? "")) return setError("The new passwords do not match.");
          startTransition(async () => {
            const { error } = await authClient.changePassword({
              currentPassword: String(data.get("currentPassword") ?? ""),
              newPassword: next,
              revokeOtherSessions: true,
            });
            if (error) return setError(error.message ?? "Password change failed.");
            setError(null);
            form.reset();
            toastManager.add({ type: "success", title: "Password changed" });
          });
        }}
      >
        <CardPanel className="flex flex-col gap-4">
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Field name="currentPassword">
            <FieldLabel>Current password</FieldLabel>
            <Input name="currentPassword" type="password" required autoComplete="current-password" />
          </Field>
          <Field name="newPassword">
            <FieldLabel>New password</FieldLabel>
            <Input name="newPassword" type="password" required minLength={12} autoComplete="new-password" />
            <FieldDescription>At least 12 characters.</FieldDescription>
          </Field>
          <Field name="confirm">
            <FieldLabel>Confirm new password</FieldLabel>
            <Input name="confirm" type="password" required minLength={12} autoComplete="new-password" />
          </Field>
        </CardPanel>
        <CardFooter>
          <Button type="submit" loading={pending}>
            Change password
          </Button>
        </CardFooter>
      </Form>
    </Card>
  );
}

function TwoFactorCard({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ uri: string; secret: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [pending, startTransition] = useTransition();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheckIcon className="size-4" /> Two-factor authentication
        </CardTitle>
        <CardDescription>
          {enabled ? "Enabled: sign-in asks for a code from your authenticator app." : "Add a TOTP authenticator app as a second factor."}
        </CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4">
        {setup ? (
          <>
            <Alert variant="info">
              <AlertTitle>Add this account to your authenticator</AlertTitle>
              <AlertDescription>
                Enter the secret manually (or open the otpauth link on a device with an authenticator), then confirm with a code.
              </AlertDescription>
            </Alert>
            <Field>
              <FieldLabel>Secret</FieldLabel>
              <div className="flex w-full gap-2">
                <Input readOnly value={setup.secret} className="font-mono" data-testid="totp-secret" />
                <CopyButton value={setup.secret} iconOnly label="Copy secret" />
              </div>
            </Field>
            <Field>
              <FieldLabel>Backup codes</FieldLabel>
              <pre className="w-full rounded-lg border bg-muted p-3 font-mono text-xs">{setup.backupCodes.join("\n")}</pre>
              <FieldDescription>Each works once. Store them somewhere safe.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Code from the app</FieldLabel>
              <Input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" />
            </Field>
          </>
        ) : (
          <Field>
            <FieldLabel>Confirm with your password</FieldLabel>
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
          </Field>
        )}
      </CardPanel>
      <CardFooter>
        {setup ? (
          <Button
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const { error } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
                if (error) return errorToast("Invalid code", error.message);
                toastManager.add({ type: "success", title: "Two-factor authentication enabled" });
                setSetup(null);
                router.refresh();
              })
            }
          >
            Verify and enable
          </Button>
        ) : enabled ? (
          <Button
            variant="destructive-outline"
            loading={pending}
            disabled={!password}
            onClick={() =>
              startTransition(async () => {
                const { error } = await authClient.twoFactor.disable({ password });
                if (error) return errorToast("Could not disable", error.message);
                toastManager.add({ type: "success", title: "Two-factor authentication disabled" });
                setPassword("");
                router.refresh();
              })
            }
          >
            Disable 2FA
          </Button>
        ) : (
          <Button
            loading={pending}
            disabled={!password}
            data-testid="enable-2fa"
            onClick={() =>
              startTransition(async () => {
                const { data, error } = await authClient.twoFactor.enable({ password });
                if (error || !data || data.method !== "totp") return errorToast("Could not start setup", error?.message);
                const secret = new URL(data.totpURI).searchParams.get("secret") ?? "";
                setSetup({ uri: data.totpURI, secret, backupCodes: data.backupCodes });
                setPassword("");
              })
            }
          >
            Set up 2FA
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function SessionsCard({ sessions, currentToken }: { sessions: SessionView[]; currentToken: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
        <CardDescription>Devices signed in to your account.</CardDescription>
      </CardHeader>
      <CardPanel>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Device</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Signed in (UTC)</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((session) => (
              <TableRow key={session.id}>
                <TableCell className="max-w-80 truncate text-sm">{session.userAgent || "Unknown"}</TableCell>
                <TableCell className="font-mono text-xs">{session.ipAddress ?? "–"}</TableCell>
                <TableCell className="text-muted-foreground">{formatDateTime(session.createdAt)}</TableCell>
                <TableCell className="text-muted-foreground">{formatRelative(session.updatedAt)}</TableCell>
                <TableCell className="text-right">
                  {session.token === currentToken ? (
                    <Badge variant="success">This device</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={pending}
                      onClick={() =>
                        startTransition(async () => {
                          const { error } = await authClient.revokeSession({ token: session.token });
                          if (error) return errorToast("Could not sign out session", error.message);
                          router.refresh();
                        })
                      }
                    >
                      Sign out
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardPanel>
      <CardFooter>
        <Button
          variant="outline"
          loading={pending}
          disabled={sessions.length <= 1}
          onClick={() =>
            startTransition(async () => {
              const { error } = await authClient.revokeOtherSessions();
              if (error) return errorToast("Could not sign out other sessions", error.message);
              toastManager.add({ type: "success", title: "Other sessions signed out" });
              router.refresh();
            })
          }
        >
          Sign out other sessions
        </Button>
      </CardFooter>
    </Card>
  );
}
