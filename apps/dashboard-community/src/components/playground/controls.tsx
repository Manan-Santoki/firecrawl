"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import type { ReactNode } from "react";
import { SimpleSelect } from "@/components/simple-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  description,
  testId,
  type,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  description?: ReactNode;
  testId?: string;
  type?: string;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input value={value} type={type} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} data-testid={testId} />
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}

export function AreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
  mono = false,
  testId,
  description,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
  testId?: string;
  description?: ReactNode;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        className={mono ? "font-mono text-xs" : undefined}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      />
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  );
}

export function SwitchField({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
}) {
  return (
    <Label className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        {description && <span className="font-normal text-muted-foreground text-xs">{description}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={(value) => onChange(Boolean(value))} />
    </Label>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <SimpleSelect options={options} value={value} onValueChange={onChange} ariaLabel={label} className="w-full" />
    </Field>
  );
}

export function CheckList({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <Fieldset className="flex flex-col gap-2">
      <FieldsetLegend className="mb-2 font-medium text-sm">{label}</FieldsetLegend>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {options.map((option) => (
          <Label key={option.value} className="flex items-center gap-2 font-normal">
            <Checkbox
              checked={value.includes(option.value)}
              onCheckedChange={(checked) =>
                onChange(checked ? [...value, option.value] : value.filter((item) => item !== option.value))
              }
              data-testid={`format-${option.value}`}
            />
            {option.label}
          </Label>
        ))}
      </div>
    </Fieldset>
  );
}

/** Editable list of rows with add/remove, used by the actions and schema builders. */
export function RowList<T>({
  rows,
  onChange,
  render,
  create,
  addLabel,
}: {
  rows: T[];
  onChange: (rows: T[]) => void;
  render: (row: T, update: (row: T) => void) => ReactNode;
  create: () => T;
  addLabel: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={index} className="flex items-start gap-2 rounded-lg border p-2">
          <div className="flex flex-1 flex-wrap items-end gap-2">
            {render(row, (next) => onChange(rows.map((item, i) => (i === index ? next : item))))}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2Icon />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" className="self-start" onClick={() => onChange([...rows, create()])}>
        <PlusIcon /> {addLabel}
      </Button>
    </div>
  );
}
