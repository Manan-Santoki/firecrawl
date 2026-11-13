"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveSettingAction } from "@/app/actions/operate";
import { LimitsFields, type LimitsValue, parseLimit } from "@/components/limits-fields";
import { SelectField, SwitchField } from "@/components/playground/controls";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { toastError, toastSuccess } from "@/lib/notify";

type DefaultLimits = { creditLimit: number | null; creditLimitInterval: "day" | "week" | "month" | null; concurrencyLimit: number | null };
type InvitePolicy = { defaultTtlHours: number; requireEmail: boolean; defaultRole: "member" | "admin" };

export function SettingsForms({ defaultLimits, invitePolicy }: { defaultLimits: DefaultLimits; invitePolicy: InvitePolicy }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [limits, setLimits] = useState<LimitsValue>({
    creditLimit: defaultLimits.creditLimit === null ? "" : String(defaultLimits.creditLimit),
    creditLimitInterval: defaultLimits.creditLimitInterval ?? "month",
    concurrency: defaultLimits.concurrencyLimit === null ? "" : String(defaultLimits.concurrencyLimit),
  });
  const [policy, setPolicy] = useState(invitePolicy);

  const save = (key: string, value: unknown, label: string) =>
    startTransition(async () => {
      const result = await saveSettingAction(key, value);
      if (!result.ok) return toastError("Not saved", result.error);
      toastSuccess(`${label} saved`);
      router.refresh();
    });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Default user limits</CardTitle>
          <CardDescription>Applied to each newly invited user. Existing users keep their limits.</CardDescription>
        </CardHeader>
        <CardPanel>
          <LimitsFields value={limits} onChange={setLimits} concurrencyHelp="Concurrent scrape jobs for new users. Empty uses the deployment default." />
        </CardPanel>
        <CardFooter>
          <Button
            loading={pending}
            data-testid="save-default-limits"
            onClick={() => {
              const creditLimit = parseLimit(limits.creditLimit);
              const concurrencyLimit = parseLimit(limits.concurrency);
              if (Number.isNaN(creditLimit) || Number.isNaN(concurrencyLimit) || concurrencyLimit === 0) {
                return toastError("Invalid limits", "Use whole numbers; concurrency at least 1.");
              }
              save(
                "defaultLimits",
                { creditLimit, creditLimitInterval: creditLimit === null ? null : limits.creditLimitInterval, concurrencyLimit },
                "Default limits",
              );
            }}
          >
            Save defaults
          </Button>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Sign-up and invites</CardTitle>
          <CardDescription>Public sign-up is always closed; people join only through invite links.</CardDescription>
        </CardHeader>
        <CardPanel className="flex flex-col gap-3">
          <SelectField
            label="Invite links expire after"
            value={String(policy.defaultTtlHours)}
            options={[
              { value: "24", label: "1 day" },
              { value: "72", label: "3 days" },
              { value: "168", label: "7 days" },
              { value: "336", label: "14 days" },
            ]}
            onChange={(value) => setPolicy({ ...policy, defaultTtlHours: Number(value) })}
          />
          <SelectField
            label="Default role for invites"
            value={policy.defaultRole}
            options={[
              { value: "member", label: "Member" },
              { value: "admin", label: "Administrator" },
            ]}
            onChange={(value) => setPolicy({ ...policy, defaultRole: value as InvitePolicy["defaultRole"] })}
          />
          <SwitchField
            label="Require an email on every invite"
            description="Only that address can redeem the link."
            checked={policy.requireEmail}
            onChange={(requireEmail) => setPolicy({ ...policy, requireEmail })}
          />
        </CardPanel>
        <CardFooter>
          <Button loading={pending} onClick={() => save("invitePolicy", policy, "Invite policy")}>
            Save policy
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
