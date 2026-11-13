"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setPending(true);
        setError(null);
        const { data: result, error } = await authClient.signIn.email({
          email: String(data.get("email") ?? ""),
          password: String(data.get("password") ?? ""),
        });
        setPending(false);
        if (error) {
          setError(
            error.status === 429
              ? "Too many attempts. Wait a minute and try again."
              : (error.message ?? "Sign-in failed."),
          );
          return;
        }
        if (result && "twoFactorRedirect" in result && result.twoFactorRedirect) {
          router.push("/two-factor");
          return;
        }
        router.push("/");
        router.refresh();
      }}
    >
      {error && (
        <Alert variant="error">
          <AlertDescription data-testid="login-error">{error}</AlertDescription>
        </Alert>
      )}
      <Field name="email">
        <FieldLabel>Email</FieldLabel>
        <Input name="email" type="email" required autoComplete="email" />
      </Field>
      <Field name="password">
        <FieldLabel>Password</FieldLabel>
        <Input name="password" type="password" required autoComplete="current-password" />
      </Field>
      <Button type="submit" loading={pending} className="w-full">
        Sign in
      </Button>
    </Form>
  );
}
