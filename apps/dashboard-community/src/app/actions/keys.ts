"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/server/action-result";
import { CREDIT_INTERVALS, createApiKey, renameApiKey, revokeApiKey, setApiKeyLimits } from "@/lib/server/api-keys";
import { actionViewer } from "@/lib/server/session";

const nameSchema = z.string().trim().min(1, "Give the key a name.").max(100);
const limitsSchema = z.object({
  creditLimit: z.number().int().min(0).max(1_000_000_000).nullable(),
  creditLimitInterval: z.enum(CREDIT_INTERVALS).nullable(),
  concurrency: z.number().int().min(1).max(10_000).nullable(),
});

export async function createKeyAction(input: { name: string; teamId?: string | null }) {
  return runAction(async () => {
    const viewer = await actionViewer();
    const name = nameSchema.parse(input.name);
    const teamId = input.teamId ? z.uuid().parse(input.teamId) : null;
    const created = await createApiKey(viewer, { name, teamId });
    revalidatePath("/keys");
    return created;
  });
}

export async function renameKeyAction(id: number, name: string) {
  return runAction(async () => {
    const viewer = await actionViewer();
    await renameApiKey(viewer, z.number().int().positive().parse(id), nameSchema.parse(name));
    revalidatePath("/keys");
  });
}

export async function revokeKeyAction(id: number) {
  return runAction(async () => {
    const viewer = await actionViewer();
    await revokeApiKey(viewer, z.number().int().positive().parse(id));
    revalidatePath("/keys");
  });
}

export async function setKeyLimitsAction(id: number, limits: z.input<typeof limitsSchema>) {
  return runAction(async () => {
    const viewer = await actionViewer();
    await setApiKeyLimits(viewer, z.number().int().positive().parse(id), limitsSchema.parse(limits));
    revalidatePath("/keys");
  });
}
