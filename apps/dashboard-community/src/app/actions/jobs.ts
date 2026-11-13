"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction } from "@/lib/server/action-result";
import { cancelJob } from "@/lib/server/jobs";
import { actionViewer } from "@/lib/server/session";

export async function cancelJobAction(jobId: string) {
  return runAction(async () => {
    const viewer = await actionViewer();
    await cancelJob(viewer, z.uuid().parse(jobId));
    revalidatePath("/jobs");
    revalidatePath(`/jobs/${jobId}`);
  });
}
