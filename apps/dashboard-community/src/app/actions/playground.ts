"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { PLAYGROUND_KINDS } from "@/lib/playground-shared";
import { runAction } from "@/lib/server/action-result";
import { deleteHistory, pollPlayground, runPlayground } from "@/lib/server/playground";
import { actionViewer } from "@/lib/server/session";

const runSchema = z.object({
  kind: z.enum(PLAYGROUND_KINDS),
  body: z.record(z.string(), z.unknown()),
  keyId: z.number().int().positive().nullable().optional(),
  title: z.string().max(200).nullable().optional(),
});

export async function runPlaygroundAction(input: z.input<typeof runSchema>) {
  return runAction(async () => {
    const viewer = await actionViewer();
    const parsed = runSchema.parse(input);
    const result = await runPlayground(viewer, parsed);
    revalidatePath("/playground");
    return result;
  });
}

export async function pollPlaygroundAction(historyId: string) {
  return runAction(async () => {
    const viewer = await actionViewer();
    return pollPlayground(viewer, z.uuid().parse(historyId));
  });
}

export async function deleteHistoryAction(historyId: string) {
  return runAction(async () => {
    const viewer = await actionViewer();
    await deleteHistory(viewer, z.uuid().parse(historyId));
    revalidatePath("/playground");
  });
}
