"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type Option, SimpleSelect } from "./simple-select";

const DAYS: Option[] = [
  { value: "7", label: "Last 7 days" },
  { value: "14", label: "Last 14 days" },
  { value: "30", label: "Last 30 days" },
];

export function UsageFilters({ days, user, users }: { days: number; user: string | null; users: Option[] | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function set(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") params.delete(key);
    else params.set(key, value);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap gap-2">
      <SimpleSelect options={DAYS} value={String(days)} onValueChange={(value) => set("days", value)} ariaLabel="Range" className="w-40" />
      {users && (
        <SimpleSelect
          options={[{ value: "all", label: "Every user" }, ...users]}
          value={user ?? "all"}
          onValueChange={(value) => set("user", value)}
          ariaLabel="User"
          className="w-56"
        />
      )}
    </div>
  );
}
