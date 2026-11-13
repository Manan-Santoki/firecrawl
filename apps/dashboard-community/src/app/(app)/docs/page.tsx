import { BookOpenIcon, ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import Link from "next/link";
import { CodeSnippets } from "@/components/operate/code-snippets";
import { PageHeader } from "@/components/page-header";
import { CopyButton } from "@/components/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { listApiKeys } from "@/lib/server/api-keys";
import { env } from "@/lib/server/env";
import { requireViewer } from "@/lib/server/session";

export const metadata = { title: "API docs and quick start" };

export default async function DocsPage() {
  const viewer = await requireViewer();
  const config = env();
  const base = (config.FIRECRAWL_PUBLIC_API_URL ?? config.FIRECRAWL_API_URL).replace(/\/$/, "");
  const mcp = config.DASHBOARD_MCP_URL ?? `${base}/mcp`;
  const keys = (await listApiKeys(viewer, viewer.teamId)).filter((key) => key.teamId === viewer.teamId);
  const keyHint = keys[0]?.masked ?? "fc-YOUR-KEY";

  const snippets = {
    curl: `curl -X POST '${base}/v2/scrape' \\\n  -H 'Authorization: Bearer $FIRECRAWL_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"url": "https://example.com", "formats": ["markdown"]}'`,
    python: `pip install firecrawl-py\n\nfrom firecrawl import Firecrawl\n\nfirecrawl = Firecrawl(api_key="fc-YOUR-KEY", api_url="${base}")\ndoc = firecrawl.scrape("https://example.com", formats=["markdown"])\nprint(doc.markdown)`,
    javascript: `npm install @mendable/firecrawl-js\n\nimport Firecrawl from "@mendable/firecrawl-js";\n\nconst firecrawl = new Firecrawl({ apiKey: "fc-YOUR-KEY", apiUrl: "${base}" });\nconst doc = await firecrawl.scrape("https://example.com", { formats: ["markdown"] });\nconsole.log(doc.markdown);`,
    mcp: `{\n  "mcpServers": {\n    "firecrawl": {\n      "url": "${mcp}",\n      "headers": { "Authorization": "Bearer fc-YOUR-KEY" }\n    }\n  }\n}`,
    "mcp (local)": `{\n  "mcpServers": {\n    "firecrawl": {\n      "command": "npx",\n      "args": ["-y", "firecrawl-mcp"],\n      "env": {\n        "FIRECRAWL_API_KEY": "fc-YOUR-KEY",\n        "FIRECRAWL_API_URL": "${base}"\n      }\n    }\n  }\n}`,
  };

  return (
    <>
      <PageHeader title="API docs and quick start" description="Everything you need to call this deployment from code, an SDK or an MCP client." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Base URL</CardTitle>
            <CardDescription>Use it in place of https://api.firecrawl.dev in SDKs and tools.</CardDescription>
          </CardHeader>
          <CardPanel className="flex gap-2">
            <Input readOnly value={base} className="font-mono" data-testid="docs-base-url" />
            <CopyButton value={base} iconOnly label="Copy base URL" />
          </CardPanel>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRoundIcon className="size-4" /> Your API key
            </CardTitle>
            <CardDescription>
              {keys.length ? `You have ${keys.length} key${keys.length === 1 ? "" : "s"}, e.g. ${keyHint}. Full keys are shown only when created.` : "You have no key yet."}
            </CardDescription>
          </CardHeader>
          <CardPanel className="flex flex-wrap gap-2">
            <Button render={<Link href="/keys" />}>{keys.length ? "Manage keys" : "Create a key"}</Button>
            <Button variant="outline" render={<Link href="/playground" />}>
              Open the playground
            </Button>
          </CardPanel>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Quick start</CardTitle>
          <CardDescription>Replace fc-YOUR-KEY with your key. The MCP endpoint is served at /mcp on the gateway.</CardDescription>
        </CardHeader>
        <CardPanel>
          <CodeSnippets snippets={snippets} />
        </CardPanel>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpenIcon className="size-4" /> Reference
          </CardTitle>
        </CardHeader>
        <CardPanel className="flex flex-wrap gap-2">
          {config.DASHBOARD_API_DOCS_URL ? (
            <Button variant="outline" render={<a href={config.DASHBOARD_API_DOCS_URL} target="_blank" rel="noreferrer" />}>
              Swagger UI for this deployment <ExternalLinkIcon />
            </Button>
          ) : (
            <Alert variant="info" className="w-full">
              <AlertTitle>No Swagger link configured</AlertTitle>
              <AlertDescription>Set DASHBOARD_API_DOCS_URL to the gateway&apos;s Swagger UI (it serves /openapi.json).</AlertDescription>
            </Alert>
          )}
          <Button variant="outline" render={<a href="https://docs.firecrawl.dev/api-reference/v2-introduction" target="_blank" rel="noreferrer" />}>
            Firecrawl v2 reference <ExternalLinkIcon />
          </Button>
          <Button variant="outline" render={<Link href="/features" />}>
            What works on this deployment
          </Button>
        </CardPanel>
      </Card>
    </>
  );
}
