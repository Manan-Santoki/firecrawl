"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { agentSkill, cancelAgent, startAgent } from "@/lib/server/agent";
import { runAction } from "@/lib/server/action-result";
import {
  browserSessionLinks,
  closeBrowserSession,
  createBrowserSession,
  deleteBrowserProfile,
  executeInBrowser,
} from "@/lib/server/browser";
import { createMonitor, deleteMonitor, getCheck, runMonitor, updateMonitor } from "@/lib/server/monitors";
import { actionViewer } from "@/lib/server/session";

const uuid = z.uuid();

// Browser sessions

export async function createBrowserAction(input: {
  ttl: number;
  activityTtl: number;
  streamWebView: boolean;
  blockAds: boolean;
  profileName?: string;
  saveProfile?: boolean;
}) {
  return runAction(async () => {
    const viewer = await actionViewer();
    const parsed = z
      .object({
        ttl: z.number().int().min(30).max(3600),
        activityTtl: z.number().int().min(10).max(3600),
        streamWebView: z.boolean(),
        blockAds: z.boolean(),
        profileName: z.string().trim().max(128).optional(),
        saveProfile: z.boolean().optional(),
      })
      .parse(input);
    const session = await createBrowserSession(viewer, {
      ...parsed,
      profile: parsed.profileName ? { name: parsed.profileName, saveChanges: parsed.saveProfile ?? true } : null,
    });
    revalidatePath("/browser");
    return session;
  });
}

export async function browserLinksAction(sessionId: string) {
  return runAction(async () => browserSessionLinks(await actionViewer(), uuid.parse(sessionId)));
}

export async function executeBrowserAction(sessionId: string, input: { code: string; language: string; timeout: number }) {
  return runAction(async () => {
    const viewer = await actionViewer();
    const parsed = z
      .object({
        code: z.string().min(1).max(100_000),
        language: z.enum(["node", "python", "bash"]),
        timeout: z.number().int().min(1).max(300),
      })
      .parse(input);
    return executeInBrowser(viewer, uuid.parse(sessionId), parsed);
  });
}

export async function closeBrowserAction(sessionId: string) {
  return runAction(async () => {
    await closeBrowserSession(await actionViewer(), uuid.parse(sessionId));
    revalidatePath("/browser");
  });
}

export async function deleteProfileAction(teamId: string, name: string) {
  return runAction(async () => {
    await deleteBrowserProfile(await actionViewer(), uuid.parse(teamId), z.string().min(1).max(128).parse(name));
    revalidatePath("/browser");
  });
}

// Monitors

const monitorSchema = z.object({
  name: z.string().trim().min(1).max(256),
  scheduleMode: z.enum(["cron", "text"]),
  schedule: z.string().trim().min(1).max(128),
  timezone: z.string().trim().min(1).max(64),
  urls: z.array(z.url()).min(1).max(50),
  formats: z.array(z.string()).min(1),
  webhookUrl: z.union([z.url(), z.literal("")]).optional(),
  retentionDays: z.number().int().min(1).max(365),
  goal: z.string().max(2000).optional(),
});

function toMonitorInput(parsed: z.infer<typeof monitorSchema>) {
  return {
    name: parsed.name,
    schedule: parsed.scheduleMode === "cron" ? { cron: parsed.schedule, timezone: parsed.timezone } : { text: parsed.schedule, timezone: parsed.timezone },
    urls: parsed.urls,
    formats: parsed.formats,
    webhookUrl: parsed.webhookUrl || null,
    retentionDays: parsed.retentionDays,
    goal: parsed.goal || null,
  };
}

export async function saveMonitorAction(monitorId: string | null, input: z.input<typeof monitorSchema>) {
  return runAction(async () => {
    const viewer = await actionViewer();
    const parsed = toMonitorInput(monitorSchema.parse(input));
    if (monitorId) await updateMonitor(viewer, uuid.parse(monitorId), parsed);
    else await createMonitor(viewer, parsed);
    revalidatePath("/monitors");
  });
}

export async function setMonitorStatusAction(monitorId: string, status: "active" | "paused") {
  return runAction(async () => {
    await updateMonitor(await actionViewer(), uuid.parse(monitorId), { status: z.enum(["active", "paused"]).parse(status) });
    revalidatePath("/monitors");
  });
}

export async function deleteMonitorAction(monitorId: string) {
  return runAction(async () => {
    await deleteMonitor(await actionViewer(), uuid.parse(monitorId));
    revalidatePath("/monitors");
  });
}

export async function runMonitorAction(monitorId: string) {
  return runAction(async () => {
    const result = await runMonitor(await actionViewer(), uuid.parse(monitorId));
    revalidatePath(`/monitors/${monitorId}`);
    return result;
  });
}

export async function checkDetailAction(monitorId: string, checkId: string) {
  return runAction(async () => getCheck(await actionViewer(), uuid.parse(monitorId), uuid.parse(checkId)));
}

// Agent

export async function startAgentAction(input: { prompt: string; urls: string[]; schema?: string; maxCredits?: number; effort?: string }) {
  return runAction(async () => {
    const viewer = await actionViewer();
    const parsed = z
      .object({
        prompt: z.string().trim().min(1).max(10_000),
        urls: z.array(z.url()).max(50),
        schema: z.string().optional(),
        maxCredits: z.number().int().positive().optional(),
        effort: z.enum(["low", "medium", "high"]).optional(),
      })
      .parse(input);
    let schema: unknown;
    if (parsed.schema?.trim()) {
      try {
        schema = JSON.parse(parsed.schema);
      } catch {
        throw new z.ZodError([{ code: "custom", path: ["schema"], message: "The schema is not valid JSON.", input: parsed.schema }]);
      }
    }
    const run = await startAgent(viewer, {
      prompt: parsed.prompt,
      ...(parsed.urls.length ? { urls: parsed.urls } : {}),
      ...(schema ? { schema } : {}),
      ...(parsed.maxCredits ? { maxCredits: parsed.maxCredits } : {}),
      ...(parsed.effort ? { effort: parsed.effort } : {}),
    });
    revalidatePath("/agent");
    return run;
  });
}

export async function cancelAgentAction(runId: string) {
  return runAction(async () => {
    await cancelAgent(await actionViewer(), uuid.parse(runId));
    revalidatePath(`/agent/${runId}`);
  });
}

export async function agentSkillAction(runId: string) {
  return runAction(async () => agentSkill(await actionViewer(), uuid.parse(runId)));
}
