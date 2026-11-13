"use client";

import { TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

/** Error boundary for dashboard pages. Shows the digest only, never server details. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon />
        </EmptyMedia>
        <EmptyTitle>This page could not load</EmptyTitle>
        <EmptyDescription>
          A service it depends on may be unavailable. {error.digest ? `Reference: ${error.digest}.` : ""} Check Service health or try again.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" render={<a href="/health" />}>
          Service health
        </Button>
      </EmptyContent>
    </Empty>
  );
}
