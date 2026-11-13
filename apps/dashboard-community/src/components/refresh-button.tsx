"use client";

import { RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button variant="outline" loading={pending} onClick={() => startTransition(() => router.refresh())}>
      <RefreshCwIcon /> Refresh
    </Button>
  );
}
