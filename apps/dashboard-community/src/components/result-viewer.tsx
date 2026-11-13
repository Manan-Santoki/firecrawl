"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";

type Doc = Record<string, unknown>;

function asDoc(value: unknown): Doc | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Doc) : null;
}

/** Finds the scraped document in a scrape/crawl/search response. */
export function primaryDocument(body: unknown): Doc | null {
  const root = asDoc(body);
  if (!root) return null;
  const data = root.data;
  if (Array.isArray(data)) return asDoc(data[0]);
  const doc = asDoc(data);
  if (doc && Array.isArray(doc.web)) return asDoc(doc.web[0]);
  return doc ?? root;
}

function colorsOf(branding: unknown): { name: string; value: string }[] {
  const colors = asDoc(asDoc(branding)?.colors);
  if (!colors) return [];
  return Object.entries(colors)
    .filter(([, value]) => typeof value === "string" && /^(#|rgb|hsl)/i.test(value as string))
    .map(([name, value]) => ({ name, value: value as string }));
}

export function JsonBlock({ value, testId }: { value: unknown; testId?: string }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="relative">
      <CopyButton value={text} iconOnly size="icon-sm" variant="ghost" label="Copy JSON" className="absolute top-2 right-2" />
      <ScrollArea className="max-h-[32rem] rounded-lg border bg-muted/40">
        <pre className="whitespace-pre-wrap break-all p-3 font-mono text-xs" data-testid={testId}>
          {text}
        </pre>
      </ScrollArea>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <ScrollArea className="max-h-[32rem] rounded-lg border">
      <div className="flex flex-col gap-3 p-4 text-sm leading-relaxed [&_a]:text-info-foreground [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:font-heading [&_h1]:font-semibold [&_h1]:text-xl [&_h2]:font-semibold [&_h2]:text-lg [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_table]:w-full [&_td]:border [&_td]:p-1 [&_th]:border [&_th]:p-1 [&_ul]:list-disc">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    </ScrollArea>
  );
}

/** Renders a Firecrawl result: markdown, raw JSON, screenshot, media and branding. */
export function ResultViewer({ body }: { body: unknown }) {
  const doc = primaryDocument(body);
  const markdown = typeof doc?.markdown === "string" ? doc.markdown : null;
  const summary = typeof doc?.summary === "string" ? doc.summary : null;
  const screenshot = typeof doc?.screenshot === "string" ? doc.screenshot : null;
  const audio = typeof doc?.audio === "string" ? doc.audio : null;
  const video = typeof doc?.video === "string" ? doc.video : null;
  const colors = colorsOf(doc?.branding);
  const json = doc?.json;
  const links = Array.isArray(doc?.links) ? (doc.links as unknown[]) : Array.isArray(asDoc(body)?.links) ? (asDoc(body)!.links as unknown[]) : [];

  const tabs: { value: string; label: string; show: boolean }[] = [
    { value: "rendered", label: "Markdown", show: markdown !== null },
    { value: "summary", label: "Summary", show: summary !== null },
    { value: "json", label: "Structured", show: json !== undefined },
    { value: "screenshot", label: "Screenshot", show: screenshot !== null },
    { value: "media", label: "Media", show: audio !== null || video !== null },
    { value: "branding", label: "Branding", show: doc?.branding !== undefined },
    { value: "links", label: `Links (${links.length})`, show: links.length > 0 },
    { value: "raw", label: "Raw JSON", show: true },
  ];
  const visible = tabs.filter((tab) => tab.show);

  return (
    <Tabs defaultValue={visible[0].value} className="w-full">
      <TabsList className="flex-wrap">
        {visible.map((tab) => (
          <TabsTab key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTab>
        ))}
      </TabsList>
      {markdown !== null && (
        <TabsPanel value="rendered" className="mt-3" data-testid="result-markdown">
          <Markdown text={markdown} />
        </TabsPanel>
      )}
      {summary !== null && (
        <TabsPanel value="summary" className="mt-3">
          <p className="rounded-lg border p-4 text-sm">{summary}</p>
        </TabsPanel>
      )}
      {json !== undefined && (
        <TabsPanel value="json" className="mt-3">
          <JsonBlock value={json} />
        </TabsPanel>
      )}
      {screenshot !== null && (
        <TabsPanel value="screenshot" className="mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- remote screenshot URL or data URL */}
          <img src={screenshot} alt="Page screenshot" className="max-h-[40rem] w-full rounded-lg border object-contain object-top" />
        </TabsPanel>
      )}
      {(audio !== null || video !== null) && (
        <TabsPanel value="media" className="mt-3 flex flex-col gap-3">
          {audio && <audio controls src={audio} className="w-full" />}
          {video && <video controls src={video} className="max-h-[32rem] w-full rounded-lg border" />}
        </TabsPanel>
      )}
      {doc?.branding !== undefined && (
        <TabsPanel value="branding" className="mt-3 flex flex-col gap-3">
          {colors.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {colors.map((color) => (
                <div key={color.name} className="flex items-center gap-2 rounded-lg border p-2">
                  <span className="size-8 shrink-0 rounded-md border" style={{ background: color.value }} />
                  <span className="flex flex-col text-xs">
                    <span className="font-medium">{color.name}</span>
                    <span className="font-mono text-muted-foreground">{color.value}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle className="text-base">No colors detected</EmptyTitle>
                <EmptyDescription>The branding result is shown below.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <JsonBlock value={doc.branding} />
        </TabsPanel>
      )}
      {links.length > 0 && (
        <TabsPanel value="links" className="mt-3">
          <ScrollArea className="max-h-[32rem] rounded-lg border">
            <ul className="flex flex-col divide-y text-sm">
              {links.slice(0, 500).map((link, index) => {
                const record = asDoc(link);
                const url = typeof link === "string" ? link : String(record?.url ?? "");
                return (
                  <li key={index} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="truncate font-mono text-xs">{url}</span>
                    {record?.title ? <Badge variant="outline">{String(record.title).slice(0, 60)}</Badge> : null}
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        </TabsPanel>
      )}
      <TabsPanel value="raw" className="mt-3">
        <JsonBlock value={body} testId="result-raw" />
      </TabsPanel>
    </Tabs>
  );
}
