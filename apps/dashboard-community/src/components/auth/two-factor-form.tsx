"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function TwoFactorForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [trust, setTrust] = useState(false);

  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
        setPending(true);
        setError(null);
        const isTotp = /^\d{6}$/.test(code);
        const { error } = isTotp
          ? await authClient.twoFactor.verifyTotp({ code, trustDevice: trust })
          : await authClient.twoFactor.verifyBackupCode({ code, trustDevice: trust });
        setPending(false);
        if (error) {
          setError(error.status === 429 ? "Too many attempts. Wait a minute." : (error.message ?? "Invalid code."));
          return;
        }
        router.push("/");
        router.refresh();
      }}
    >
      {error && (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Field name="code">
        <FieldLabel>Code</FieldLabel>
        <Input name="code" required autoComplete="one-time-code" inputMode="text" />
      </Field>
      <Label className="flex items-center gap-2">
        <Checkbox checked={trust} onCheckedChange={(value) => setTrust(Boolean(value))} />
        Trust this device for 30 days
      </Label>
      <Button type="submit" loading={pending} className="w-full">
        Verify
      </Button>
    </Form>
  );
}
