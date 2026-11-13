"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";

export function CopyButton({
  value,
  label = "Copy",
  iconOnly = false,
  ...props
}: { value: string; label?: string; iconOnly?: boolean } & Omit<ButtonProps, "onClick" | "children">) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size={iconOnly ? "icon" : "default"}
      aria-label={label}
      {...props}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toastManager.add({ type: "error", title: "Copy failed", description: "Select the text and copy it manually." });
        }
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {!iconOnly && (copied ? "Copied" : label)}
    </Button>
  );
}
