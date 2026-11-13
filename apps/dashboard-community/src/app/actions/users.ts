"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createInvite, revokeInvite } from "@/lib/server/accounts";
import { runAction } from "@/lib/server/action-result";
import { CREDIT_INTERVALS } from "@/lib/server/api-keys";
import { sendInviteEmail } from "@/lib/server/mail";
import { actionAdmin } from "@/lib/server/session";
import { setTeamLimits, setUserDisabled, setUserPassword, setUserRole } from "@/lib/server/users";

const userId = z.uuid();
const role = z.enum(["admin", "member"]);

export async function createInviteAction(input: { email?: string; role: string; note?: string; ttlHours?: number }) {
  return runAction(async () => {
    const viewer = await actionAdmin();
    const parsed = z
      .object({
        email: z.union([z.email("Enter a valid email or leave it empty."), z.literal("")]).optional(),
        role,
        note: z.string().max(200).optional(),
        ttlHours: z.number().int().min(1).max(24 * 30).optional(),
      })
      .parse(input);
    const invite = await createInvite(viewer, {
      email: parsed.email || null,
      role: parsed.role,
      note: parsed.note,
      ttlHours: parsed.ttlHours,
    });
    const emailed = parsed.email ? await sendInviteEmail(parsed.email, invite.url, invite.expiresAt) : false;
    revalidatePath("/users");
    return { url: invite.url, expiresAt: invite.expiresAt.toISOString(), emailed };
  });
}

export async function revokeInviteAction(inviteId: string) {
  return runAction(async () => {
    const viewer = await actionAdmin();
    await revokeInvite(viewer, z.uuid().parse(inviteId));
    revalidatePath("/users");
  });
}

export async function setUserDisabledAction(id: string, disabled: boolean) {
  return runAction(async () => {
    const viewer = await actionAdmin();
    await setUserDisabled(viewer, userId.parse(id), z.boolean().parse(disabled));
    revalidatePath("/users");
  });
}

export async function setUserRoleAction(id: string, newRole: string) {
  return runAction(async () => {
    const viewer = await actionAdmin();
    await setUserRole(viewer, userId.parse(id), role.parse(newRole));
    revalidatePath("/users");
  });
}

export async function setUserLimitsAction(
  id: string,
  limits: { creditLimit: number | null; creditLimitInterval: string | null; concurrencyLimit: number | null },
) {
  return runAction(async () => {
    const viewer = await actionAdmin();
    const parsed = z
      .object({
        creditLimit: z.number().int().min(0).max(1_000_000_000).nullable(),
        creditLimitInterval: z.enum(CREDIT_INTERVALS).nullable(),
        concurrencyLimit: z.number().int().min(1).max(10_000).nullable(),
      })
      .parse(limits);
    await setTeamLimits(viewer, userId.parse(id), parsed);
    revalidatePath("/users");
  });
}

export async function resetUserPasswordAction(id: string, password: string) {
  return runAction(async () => {
    const viewer = await actionAdmin();
    await setUserPassword(viewer, userId.parse(id), z.string().min(12, "Use at least 12 characters.").max(256).parse(password));
  });
}
