"use client";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";

export type Option = { value: string; label: string };

/** A coss Select fed from a plain option list. */
export function SimpleSelect({
  options,
  value,
  onValueChange,
  placeholder,
  name,
  className,
  ariaLabel,
  testId,
  size,
}: {
  options: Option[];
  value: string | null;
  onValueChange: (value: string) => void;
  placeholder?: string;
  name?: string;
  className?: string;
  ariaLabel?: string;
  testId?: string;
  size?: "sm" | "default" | "lg";
}) {
  return (
    <Select
      items={options}
      value={value}
      name={name}
      onValueChange={(next) => {
        if (next !== null && next !== undefined) onValueChange(String(next));
      }}
    >
      <SelectTrigger className={className} aria-label={ariaLabel} data-testid={testId} size={size}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
