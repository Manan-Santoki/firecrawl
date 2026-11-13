"use client";

import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SimpleSelect } from "@/components/simple-select";
import { type ActionRow, type FormState, newAction, type SchemaField } from "@/lib/playground-body";
import type { PlaygroundKind } from "@/lib/playground-shared";
import { AreaField, CheckList, RowList, SelectField, SwitchField, TextField } from "./controls";

type Props = { kind: PlaygroundKind; state: FormState; set: (patch: Partial<FormState>) => void };

const FORMAT_OPTIONS = [
  { value: "markdown", label: "Markdown" },
  { value: "html", label: "HTML" },
  { value: "rawHtml", label: "Raw HTML" },
  { value: "links", label: "Links" },
  { value: "images", label: "Images" },
  { value: "summary", label: "Summary" },
  { value: "screenshot", label: "Screenshot" },
  { value: "branding", label: "Branding" },
  { value: "json", label: "JSON (schema)" },
  { value: "highlights", label: "Highlights" },
  { value: "question", label: "Question" },
  { value: "audio", label: "Audio" },
  { value: "video", label: "Video" },
];

const ACTION_TYPES: { value: ActionRow["type"]; label: string }[] = [
  { value: "wait", label: "Wait" },
  { value: "click", label: "Click" },
  { value: "write", label: "Write" },
  { value: "press", label: "Press key" },
  { value: "scroll", label: "Scroll" },
  { value: "screenshot", label: "Screenshot" },
  { value: "executeJavascript", label: "Run JavaScript" },
  { value: "scrape", label: "Scrape" },
  { value: "pdf", label: "PDF" },
];

export function SchemaBuilder({ state, set }: Omit<Props, "kind">) {
  return (
    <div className="flex flex-col gap-3">
      <SimpleSelect
        options={[
          { value: "builder", label: "Field builder" },
          { value: "raw", label: "Raw JSON Schema" },
        ]}
        value={state.schemaMode}
        onValueChange={(schemaMode) => set({ schemaMode: schemaMode as FormState["schemaMode"] })}
        ariaLabel="Schema mode"
        className="w-48"
      />
      {state.schemaMode === "builder" ? (
        <RowList<SchemaField>
          rows={state.schemaFields}
          onChange={(schemaFields) => set({ schemaFields })}
          create={() => ({ name: "", type: "string", required: false, description: "" })}
          addLabel="Add field"
          render={(field, update) => (
            <>
              <Input
                className="w-40"
                placeholder="name"
                value={field.name}
                aria-label="Field name"
                onChange={(event) => update({ ...field, name: event.target.value })}
              />
              <SimpleSelect
                options={["string", "number", "boolean", "array", "object"].map((value) => ({ value, label: value }))}
                value={field.type}
                ariaLabel="Field type"
                className="w-32"
                onValueChange={(type) => update({ ...field, type: type as SchemaField["type"] })}
              />
              <Input
                className="min-w-40 flex-1"
                placeholder="description (optional)"
                value={field.description}
                aria-label="Field description"
                onChange={(event) => update({ ...field, description: event.target.value })}
              />
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox checked={field.required} onCheckedChange={(required) => update({ ...field, required: Boolean(required) })} />
                required
              </Label>
            </>
          )}
        />
      ) : (
        <AreaField label="JSON Schema" value={state.schemaRaw} onChange={(schemaRaw) => set({ schemaRaw })} rows={8} mono />
      )}
    </div>
  );
}

function ActionsBuilder({ state, set }: Omit<Props, "kind">) {
  return (
    <RowList<ActionRow>
      rows={state.actions}
      onChange={(actions) => set({ actions })}
      create={() => newAction("wait")}
      addLabel="Add action"
      render={(row, update) => (
        <>
          <SimpleSelect
            options={ACTION_TYPES}
            value={row.type}
            ariaLabel="Action type"
            className="w-40"
            onValueChange={(type) => update(newAction(type as ActionRow["type"]))}
          />
          {row.type === "wait" && (
            <>
              <Input className="w-28" placeholder="ms" value={row.milliseconds} aria-label="Milliseconds" onChange={(e) => update({ ...row, milliseconds: e.target.value })} />
              <Input className="flex-1" placeholder="or CSS selector" value={row.selector} aria-label="Selector" onChange={(e) => update({ ...row, selector: e.target.value })} />
            </>
          )}
          {row.type === "click" && (
            <>
              <Input className="flex-1" placeholder="CSS selector" value={row.selector} aria-label="Selector" onChange={(e) => update({ ...row, selector: e.target.value })} />
              <Label className="flex items-center gap-2 font-normal">
                <Checkbox checked={row.all} onCheckedChange={(all) => update({ ...row, all: Boolean(all) })} /> all matches
              </Label>
            </>
          )}
          {row.type === "write" && (
            <Input className="flex-1" placeholder="text" value={row.text} aria-label="Text" onChange={(e) => update({ ...row, text: e.target.value })} />
          )}
          {row.type === "press" && (
            <Input className="w-40" placeholder="Enter" value={row.key} aria-label="Key" onChange={(e) => update({ ...row, key: e.target.value })} />
          )}
          {row.type === "scroll" && (
            <>
              <SimpleSelect
                options={[
                  { value: "down", label: "down" },
                  { value: "up", label: "up" },
                ]}
                value={row.direction}
                ariaLabel="Direction"
                className="w-28"
                onValueChange={(direction) => update({ ...row, direction: direction as "up" | "down" })}
              />
              <Input className="flex-1" placeholder="selector (optional)" value={row.selector} aria-label="Selector" onChange={(e) => update({ ...row, selector: e.target.value })} />
            </>
          )}
          {row.type === "screenshot" && (
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox checked={row.fullPage} onCheckedChange={(fullPage) => update({ ...row, fullPage: Boolean(fullPage) })} /> full page
            </Label>
          )}
          {row.type === "executeJavascript" && (
            <Input className="flex-1 font-mono" placeholder="document.title" value={row.script} aria-label="Script" onChange={(e) => update({ ...row, script: e.target.value })} />
          )}
          {row.type === "pdf" && (
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox checked={row.landscape} onCheckedChange={(landscape) => update({ ...row, landscape: Boolean(landscape) })} /> landscape
            </Label>
          )}
        </>
      )}
    />
  );
}

export function ScrapeOptions({ state, set }: Omit<Props, "kind">) {
  return (
    <Accordion defaultValue={["formats"]} className="w-full">
      <AccordionItem value="formats">
        <AccordionTrigger>
          Formats <Badge variant="secondary">{state.formats.length}</Badge>
        </AccordionTrigger>
        <AccordionPanel className="flex flex-col gap-4">
          <CheckList label="Output formats" options={FORMAT_OPTIONS} value={state.formats} onChange={(formats) => set({ formats })} />
          {state.formats.includes("screenshot") && (
            <SwitchField label="Full-page screenshot" checked={state.screenshotFullPage} onChange={(screenshotFullPage) => set({ screenshotFullPage })} />
          )}
          {state.formats.includes("json") && (
            <>
              <TextField label="JSON prompt (optional)" value={state.jsonPrompt} onChange={(jsonPrompt) => set({ jsonPrompt })} />
              <SchemaBuilder state={state} set={set} />
            </>
          )}
          {state.formats.includes("highlights") && (
            <TextField label="Highlights query" value={state.highlightsQuery} onChange={(highlightsQuery) => set({ highlightsQuery })} />
          )}
          {state.formats.includes("question") && (
            <TextField label="Question" value={state.question} onChange={(question) => set({ question })} />
          )}
          {state.formats.includes("branding") && (
            <SelectField
              label="Branding mode"
              value={state.brandingMode}
              options={["auto", "fast", "standard"].map((value) => ({ value, label: value }))}
              onChange={(brandingMode) => set({ brandingMode })}
            />
          )}
        </AccordionPanel>
      </AccordionItem>
      <AccordionItem value="actions">
        <AccordionTrigger>
          Actions <Badge variant="secondary">{state.actions.length}</Badge>
        </AccordionTrigger>
        <AccordionPanel>
          <ActionsBuilder state={state} set={set} />
        </AccordionPanel>
      </AccordionItem>
      <AccordionItem value="page">
        <AccordionTrigger>Page and fetching</AccordionTrigger>
        <AccordionPanel className="grid gap-3 sm:grid-cols-2">
          <SwitchField label="Only main content" checked={state.onlyMainContent} onChange={(onlyMainContent) => set({ onlyMainContent })} />
          <SwitchField label="Mobile" checked={state.mobile} onChange={(mobile) => set({ mobile })} />
          <SwitchField label="Lockdown" description="Only use cached results; never fetch live." checked={state.lockdown} onChange={(lockdown) => set({ lockdown })} />
          <SwitchField label="Redact PII" checked={state.redactPII} onChange={(redactPII) => set({ redactPII })} />
          {state.redactPII && (
            <SelectField
              label="Redaction mode"
              value={state.redactMode}
              options={["accurate", "aggressive", "fast"].map((value) => ({ value, label: value }))}
              onChange={(redactMode) => set({ redactMode })}
            />
          )}
          <SelectField
            label="Proxy"
            value={state.proxy}
            options={["auto", "basic", "stealth", "enhanced"].map((value) => ({ value, label: value }))}
            onChange={(proxy) => set({ proxy })}
          />
          <TextField label="Max age (ms)" value={state.maxAge} onChange={(maxAge) => set({ maxAge })} placeholder="cache window" />
          <TextField label="Wait for (ms)" value={state.waitFor} onChange={(waitFor) => set({ waitFor })} />
          <TextField label="Timeout (ms)" value={state.timeout} onChange={(timeout) => set({ timeout })} />
          <TextField label="Include tags" value={state.includeTags} onChange={(includeTags) => set({ includeTags })} placeholder="article, main" />
          <TextField label="Exclude tags" value={state.excludeTags} onChange={(excludeTags) => set({ excludeTags })} placeholder="nav, footer" />
        </AccordionPanel>
      </AccordionItem>
      <AccordionItem value="location">
        <AccordionTrigger>Location</AccordionTrigger>
        <AccordionPanel className="grid gap-3 sm:grid-cols-2">
          <TextField label="Country (ISO-2)" value={state.country} onChange={(country) => set({ country })} placeholder="US" />
          <TextField label="Languages" value={state.languages} onChange={(languages) => set({ languages })} placeholder="en-US, de" />
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}

/** Fields specific to each endpoint, above the shared scrape options. */
export function KindFields({ kind, state, set }: Props) {
  switch (kind) {
    case "scrape":
      return <TextField label="URL" value={state.url} onChange={(url) => set({ url })} testId="pg-url" />;
    case "search":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Query" value={state.query} onChange={(query) => set({ query })} />
          <TextField label="Limit" value={state.limit} onChange={(limit) => set({ limit })} />
          <CheckList
            label="Sources"
            options={[
              { value: "web", label: "Web" },
              { value: "news", label: "News" },
              { value: "images", label: "Images" },
            ]}
            value={state.sources}
            onChange={(sources) => set({ sources })}
          />
          <SwitchField label="Scrape results" description="Adds scrapeOptions with the formats below." checked={state.searchScrape} onChange={(searchScrape) => set({ searchScrape })} />
        </div>
      );
    case "map":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="URL" value={state.url} onChange={(url) => set({ url })} />
          <TextField label="Search" value={state.mapSearch} onChange={(mapSearch) => set({ mapSearch })} placeholder="filter links" />
          <TextField label="Limit" value={state.limit} onChange={(limit) => set({ limit })} />
          <SelectField label="Sitemap" value={state.sitemap} options={["include", "only", "skip"].map((value) => ({ value, label: value }))} onChange={(sitemap) => set({ sitemap })} />
          <SwitchField label="Include subdomains" checked={state.includeSubdomains} onChange={(includeSubdomains) => set({ includeSubdomains })} />
        </div>
      );
    case "crawl":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="URL" value={state.url} onChange={(url) => set({ url })} />
          <TextField label="Page limit" value={state.limit} onChange={(limit) => set({ limit })} />
          <TextField label="Max discovery depth" value={state.maxDiscoveryDepth} onChange={(maxDiscoveryDepth) => set({ maxDiscoveryDepth })} />
          <SelectField label="Sitemap" value={state.sitemap} options={["include", "only", "skip"].map((value) => ({ value, label: value }))} onChange={(sitemap) => set({ sitemap })} />
          <TextField label="Include paths (regex)" value={state.includePaths} onChange={(includePaths) => set({ includePaths })} placeholder="^/blog/.*" />
          <TextField label="Exclude paths (regex)" value={state.excludePaths} onChange={(excludePaths) => set({ excludePaths })} />
          <SwitchField label="Crawl entire domain" checked={state.crawlEntireDomain} onChange={(crawlEntireDomain) => set({ crawlEntireDomain })} />
          <SwitchField label="Allow subdomains" checked={state.allowSubdomains} onChange={(allowSubdomains) => set({ allowSubdomains })} />
          <TextField label="Webhook URL" value={state.webhookUrl} onChange={(webhookUrl) => set({ webhookUrl })} />
        </div>
      );
    case "batch_scrape":
      return (
        <div className="flex flex-col gap-3">
          <AreaField label="URLs (one per line)" value={state.urls} onChange={(urls) => set({ urls })} />
          <TextField label="Webhook URL" value={state.webhookUrl} onChange={(webhookUrl) => set({ webhookUrl })} />
        </div>
      );
    case "extract":
      return (
        <div className="flex flex-col gap-3">
          <AreaField label="URLs (one per line, wildcards like example.com/* allowed)" value={state.urls} onChange={(urls) => set({ urls })} />
          <AreaField label="Prompt" value={state.prompt} onChange={(prompt) => set({ prompt })} />
          <SwitchField label="Enable web search" checked={state.enableWebSearch} onChange={(enableWebSearch) => set({ enableWebSearch })} />
          <SchemaBuilder state={state} set={set} />
        </div>
      );
    case "agent":
      return (
        <div className="flex flex-col gap-3">
          <AreaField label="Prompt" value={state.prompt} onChange={(prompt) => set({ prompt })} />
          <AreaField label="URLs (optional)" value={state.urls} onChange={(urls) => set({ urls })} rows={2} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Max credits" value={state.maxCredits} onChange={(maxCredits) => set({ maxCredits })} />
            <SelectField label="Effort" value={state.effort} options={["low", "medium", "high"].map((value) => ({ value, label: value }))} onChange={(effort) => set({ effort })} />
          </div>
          <SchemaBuilder state={state} set={set} />
        </div>
      );
  }
}
