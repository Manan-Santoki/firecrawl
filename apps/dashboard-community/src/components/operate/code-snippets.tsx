"use client";

import { CopyButton } from "@/components/copy-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";

export function CodeSnippets({ snippets }: { snippets: Record<string, string> }) {
  const names = Object.keys(snippets);
  return (
    <Tabs defaultValue={names[0]}>
      <TabsList className="flex-wrap">
        {names.map((name) => (
          <TabsTab key={name} value={name}>
            {name}
          </TabsTab>
        ))}
      </TabsList>
      {names.map((name) => (
        <TabsPanel key={name} value={name} className="relative mt-3">
          <CopyButton value={snippets[name]} iconOnly size="icon-sm" variant="ghost" label={`Copy ${name}`} className="absolute top-2 right-2" />
          <ScrollArea className="max-h-96 rounded-lg border bg-muted/40">
            <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs" data-testid={`snippet-${name}`}>
              {snippets[name]}
            </pre>
          </ScrollArea>
        </TabsPanel>
      ))}
    </Tabs>
  );
}
