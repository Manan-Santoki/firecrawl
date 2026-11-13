"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { AccountError, acceptInvite, bootstrapAdmin } from "@/lib/server/accounts";

export type FormState =
  | { error?: string; fieldErrors?: Record<string, string>; values?: { name: string; email: string } }
  | undefined;

// Echoed back so a failed submit keeps what was typed (never the password or token).
function keep(formData: FormData) {
  return { name: String(formData.get("name") ?? ""), email: String(formData.get("email") ?? "") };
}

const accountSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(100),
  email: z.email("Enter a valid email address.").max(254),
  password: z.string().min(12, "Use at least 12 characters.").max(256),
});

function parseAccount(formData: FormData) {
  const parsed = accountSchema.safeParse({
    name: formData.get("name"),
    email: String(formData.get("email") ?? "").trim().toLowerCase(),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
    return { fieldErrors } as const;
  }
  return { account: parsed.data } as const;
}

export async function bootstrapAction(_state: FormState, formData: FormData): Promise<FormState> {
  const parsed = parseAccount(formData);
  if ("fieldErrors" in parsed) return { fieldErrors: parsed.fieldErrors, values: keep(formData) };
  try {
    await bootstrapAdmin(String(formData.get("token") ?? ""), parsed.account);
  } catch (error) {
    if (error instanceof AccountError) return { error: error.message, values: keep(formData) };
    throw error;
  }
  redirect("/");
}

export async function acceptInviteAction(_state: FormState, formData: FormData): Promise<FormState> {
  const parsed = parseAccount(formData);
  if ("fieldErrors" in parsed) return { fieldErrors: parsed.fieldErrors, values: keep(formData) };
  try {
    await acceptInvite(String(formData.get("token") ?? ""), parsed.account);
  } catch (error) {
    if (error instanceof AccountError) return { error: error.message, values: keep(formData) };
    throw error;
  }
  redirect("/");
}
