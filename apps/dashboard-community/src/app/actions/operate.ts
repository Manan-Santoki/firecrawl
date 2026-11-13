"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { deleteRule, ruleSchema, saveRule, testAlertWebhook } from "@/lib/server/alerts";
import { runAction } from "@/lib/server/action-result";
import { parseEntries, saveBlocklist } from "@/lib/server/blocklist";
import { CLEANUP_JOBS, type CleanupJob, purgeNow } from "@/lib/server/cleanup";
import { markRead, setPreferences } from "@/lib/server/notifications";
import { runSelfTest } from "@/lib/server/selftest";
import { actionAdmin, actionViewer } from "@/lib/server/session";
import { getSettings, type SettingKey, SETTING_SCHEMAS, setSetting } from "@/lib/server/settings";
import { createWebhook, deleteWebhook, testWebhook, updateWebhook, WEBHOOK_EVENTS } from "@/lib/server/webhooks";
import { SELF_TESTS, type SelfTestId } from "@/lib/self-tests";

export async function saveSettingAction(key: string, value: unknown) {
  return runAction(async () => {
    const viewer = await actionAdmin();
    const settingKey = z.enum(Object.keys(SETTING_SCHEMAS) as [SettingKey, ...SettingKey[]]).parse(key);
    let next = value;
    // An omitted webhook secret keeps the stored one (the form never shows it).
    if (settingKey === "alertWebhook" && value && typeof value === "object" && (value as { secret?: unknown }).secret === undefined) {
      next = { ...(value as object), secret: (await getSettings()).alertWebhook.secret };
    }
    await setSetting(viewer, settingKey, next);
    revalidatePath("/settings");
    revalidatePath("/retention");
    revalidatePath("/alerts");
  });
}

export async function runSelfTestAction(feature: string) {
  return runAction(async () => {
    const viewer = await actionViewer();
    const id = z.enum(Object.keys(SELF_TESTS) as [SelfTestId, ...SelfTestId[]]).parse(feature);
    const result = await runSelfTest(viewer, id);
    revalidatePath("/features");
    return result;
  });
}

export async function saveAlertRuleAction(id: string | null, input: z.input<typeof ruleSchema>) {
  return runAction(async () => {
    await saveRule(await actionAdmin(), id ? z.uuid().parse(id) : null, ruleSchema.parse(input));
    revalidatePath("/alerts");
  });
}

export async function deleteAlertRuleAction(id: string) {
  return runAction(async () => {
    await deleteRule(await actionAdmin(), z.uuid().parse(id));
    revalidatePath("/alerts");
  });
}

export async function testAlertWebhookAction() {
  return runAction(async () => testAlertWebhook(await actionAdmin()));
}

export async function saveBlocklistAction(scope: { global: true } | { teamId: string }, input: { blocklist: string; allowedKeywords: string }) {
  return runAction(async () => {
    const viewer = await actionViewer();
    const parsedScope = "global" in scope ? ({ global: true } as const) : { teamId: z.uuid().parse(scope.teamId) };
    await saveBlocklist(viewer, parsedScope, {
      blocklist: parseEntries(z.string().max(500_000).parse(input.blocklist)),
      allowedKeywords: parseEntries(z.string().max(100_000).parse(input.allowedKeywords)),
    });
    revalidatePath("/blocklist");
  });
}

export async function purgeNowAction(job: string) {
  return runAction(async () => {
    const viewer = await actionAdmin();
    const parsed = z.enum(Object.keys(CLEANUP_JOBS) as [CleanupJob, ...CleanupJob[]]).parse(job);
    const result = await purgeNow(viewer, parsed);
    revalidatePath("/retention");
    return result;
  });
}

export async function createWebhookAction(input: { url: string; events: string[] }) {
  return runAction(async () => {
    const viewer = await actionViewer();
    const parsed = z
      .object({ url: z.url().refine((value) => /^https?:\/\//.test(value), "Use an http(s) URL."), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) })
      .parse(input);
    const created = await createWebhook(viewer, parsed);
    revalidatePath("/webhooks");
    return created;
  });
}

export async function updateWebhookAction(id: string, input: { enabled?: boolean; events?: string[] }) {
  return runAction(async () => {
    const viewer = await actionViewer();
    await updateWebhook(viewer, z.uuid().parse(id), {
      enabled: input.enabled,
      events: input.events ? z.array(z.enum(WEBHOOK_EVENTS)).min(1).parse(input.events) : undefined,
    });
    revalidatePath("/webhooks");
  });
}

export async function deleteWebhookAction(id: string) {
  return runAction(async () => {
    await deleteWebhook(await actionViewer(), z.uuid().parse(id));
    revalidatePath("/webhooks");
  });
}

export async function testWebhookAction(id: string) {
  return runAction(async () => {
    const result = await testWebhook(await actionViewer(), z.uuid().parse(id));
    revalidatePath("/webhooks");
    return result;
  });
}

export async function markNotificationsReadAction(ids: number[] | "all") {
  return runAction(async () => {
    const viewer = await actionViewer();
    await markRead(viewer, ids === "all" ? "all" : z.array(z.number().int().positive()).max(500).parse(ids));
    revalidatePath("/notifications");
  });
}

export async function savePreferencesAction(input: { limitAlerts: boolean; jobNotifications: boolean }) {
  return runAction(async () => {
    const viewer = await actionViewer();
    await setPreferences(viewer, z.object({ limitAlerts: z.boolean(), jobNotifications: z.boolean() }).parse(input));
    revalidatePath("/notifications");
  });
}
