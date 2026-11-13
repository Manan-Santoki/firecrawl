"use client";

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SimpleSelect } from "./simple-select";

export type LimitsValue = {
  creditLimit: string;
  creditLimitInterval: string;
  concurrency: string;
};

export const INTERVAL_OPTIONS = [
  { value: "day", label: "per day" },
  { value: "week", label: "per week" },
  { value: "month", label: "per month" },
];

export function parseLimit(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 0 ? value : Number.NaN;
}

/** Credit limit + interval + concurrency inputs, shared by key and user limits. */
export function LimitsFields({
  value,
  onChange,
  concurrencyHelp,
}: {
  value: LimitsValue;
  onChange: (value: LimitsValue) => void;
  concurrencyHelp: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <Field>
          <FieldLabel>Credit limit</FieldLabel>
          <Input
            inputMode="numeric"
            placeholder="Unlimited"
            value={value.creditLimit}
            data-testid="limit-credits"
            onChange={(event) => onChange({ ...value, creditLimit: event.target.value })}
          />
        </Field>
        <SimpleSelect
          options={INTERVAL_OPTIONS}
          value={value.creditLimitInterval}
          ariaLabel="Credit limit interval"
          testId="limit-interval"
          onValueChange={(creditLimitInterval) => onChange({ ...value, creditLimitInterval })}
        />
      </div>
      <p className="-mt-2 text-muted-foreground text-xs">
        Leave empty for no limit. Windows are calendar periods in UTC; 0 blocks all paid requests.
      </p>
      <Field>
        <FieldLabel>Concurrency</FieldLabel>
        <Input
          inputMode="numeric"
          placeholder="Default"
          value={value.concurrency}
          data-testid="limit-concurrency"
          onChange={(event) => onChange({ ...value, concurrency: event.target.value })}
        />
        <FieldDescription>{concurrencyHelp}</FieldDescription>
      </Field>
    </div>
  );
}
