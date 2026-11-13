"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveMonitorAction } from "@/app/actions/build";
import { AreaField, CheckList, SelectField, TextField } from "@/components/playground/controls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toastManager } from "@/components/ui/toast";

export type MonitorFormValue = {
  name: string;
  scheduleMode: "cron" | "text";
  schedule: string;
  timezone: string;
  urls: string;
  formats: string[];
  webhookUrl: string;
  retentionDays: string;
  goal: string;
};

export const EMPTY_MONITOR: MonitorFormValue = {
  name: "",
  scheduleMode: "text",
  schedule: "every day at 9am",
  timezone: "UTC",
  urls: "https://example.com",
  formats: ["markdown"],
  webhookUrl: "",
  retentionDays: "30",
  goal: "",
};

export function MonitorDialog({
  monitorId,
  initial,
  trigger,
}: {
  monitorId: string | null;
  initial: MonitorFormValue;
  trigger: React.ReactElement;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (patch: Partial<MonitorFormValue>) => setValue((current) => ({ ...current, ...patch }));

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setValue(initial); }}>
      <DialogTrigger render={trigger} />
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{monitorId ? "Edit monitor" : "New monitor"}</DialogTitle>
          <DialogDescription>Checks the URLs on a schedule and records added, changed and removed content.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <TextField label="Name" value={value.name} onChange={(name) => set({ name })} testId="monitor-name" />
          <div className="grid grid-cols-[10rem_1fr] gap-3">
            <SelectField
              label="Schedule as"
              value={value.scheduleMode}
              options={[
                { value: "text", label: "Plain English" },
                { value: "cron", label: "Cron" },
              ]}
              onChange={(scheduleMode) => set({ scheduleMode: scheduleMode as "cron" | "text" })}
            />
            <TextField
              label="Schedule"
              value={value.schedule}
              onChange={(schedule) => set({ schedule })}
              placeholder={value.scheduleMode === "cron" ? "0 9 * * *" : "every day at 9am"}
            />
          </div>
          <TextField label="Timezone" value={value.timezone} onChange={(timezone) => set({ timezone })} />
          <AreaField label="URLs (one per line)" value={value.urls} onChange={(urls) => set({ urls })} rows={3} />
          <CheckList
            label="Formats"
            options={[
              { value: "markdown", label: "Markdown" },
              { value: "html", label: "HTML" },
              { value: "links", label: "Links" },
              { value: "summary", label: "Summary" },
            ]}
            value={value.formats}
            onChange={(formats) => set({ formats })}
          />
          <div className="grid grid-cols-2 gap-3">
            <TextField label="Webhook URL (optional)" value={value.webhookUrl} onChange={(webhookUrl) => set({ webhookUrl })} />
            <TextField label="Keep checks (days)" value={value.retentionDays} onChange={(retentionDays) => set({ retentionDays })} />
          </div>
          <AreaField label="Goal (optional)" value={value.goal} onChange={(goal) => set({ goal })} rows={2} description="What counts as a meaningful change; enables the change judge." />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button
            loading={pending}
            data-testid="save-monitor"
            onClick={() =>
              startTransition(async () => {
                const result = await saveMonitorAction(monitorId, {
                  name: value.name,
                  scheduleMode: value.scheduleMode,
                  schedule: value.schedule,
                  timezone: value.timezone,
                  urls: value.urls.split(/\s+/).filter(Boolean),
                  formats: value.formats,
                  webhookUrl: value.webhookUrl,
                  retentionDays: Number(value.retentionDays) || 30,
                  goal: value.goal,
                });
                if (!result.ok) return setError(result.error);
                toastManager.add({ type: "success", title: monitorId ? "Monitor saved" : "Monitor created" });
                setOpen(false);
                router.refresh();
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
