"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/actions/auth";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";

/** Account creation form shared by the bootstrap and invite pages. */
export function AccountForm({
  action,
  token,
  askToken = false,
  defaultEmail,
  submitLabel,
}: {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  token?: string;
  askToken?: boolean;
  defaultEmail?: string | null;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);

  return (
    <Form action={formAction} errors={state?.fieldErrors} className="flex flex-col gap-4">
      {state?.error && (
        <Alert variant="error">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {askToken ? (
        <Field name="token">
          <FieldLabel>Bootstrap token</FieldLabel>
          <Input name="token" type="password" required autoComplete="off" />
          <FieldDescription>The value of DASHBOARD_BOOTSTRAP_TOKEN on the server.</FieldDescription>
          <FieldError />
        </Field>
      ) : (
        <input type="hidden" name="token" value={token} />
      )}
      <Field name="name">
        <FieldLabel>Name</FieldLabel>
        <Input name="name" required autoComplete="name" defaultValue={state?.values?.name} />
        <FieldError />
      </Field>
      <Field name="email">
        <FieldLabel>Email</FieldLabel>
        <Input
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={defaultEmail ?? state?.values?.email}
          readOnly={Boolean(defaultEmail)}
        />
        <FieldError />
      </Field>
      <Field name="password">
        <FieldLabel>Password</FieldLabel>
        <Input name="password" type="password" required minLength={12} autoComplete="new-password" />
        <FieldDescription>At least 12 characters.</FieldDescription>
        <FieldError />
      </Field>
      <Button type="submit" loading={pending} className="w-full">
        {submitLabel}
      </Button>
    </Form>
  );
}
