"use client";

import { toastManager } from "@/components/ui/toast";

export function toastError(title: string, description?: string): void {
  toastManager.add({ type: "error", title, description });
}

export function toastSuccess(title: string, description?: string): void {
  toastManager.add({ type: "success", title, description });
}
