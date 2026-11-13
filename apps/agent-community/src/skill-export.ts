import type { AgentRun, TraceEvent } from "./types.js";

/**
 * Distil a finished run into a reusable skill without another model call: a
 * SKILL.md describing the task and its sources, and a workflow script that
 * replays it through the operator's own Firecrawl /v2/agent endpoint.
 */
export function exportSkill(run: AgentRun, events: TraceEvent[]) {
  const name =
    run.prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 6)
      .join("-") || "agent-task";

  const toolCounts: Record<string, number> = {};
  for (const e of events) {
    if (e.type === "tool_call" && typeof e.tool === "string") toolCounts[e.tool] = (toolCounts[e.tool] ?? 0) + 1;
  }

  const spec = {
    prompt: run.prompt,
    ...(run.urls?.length ? { urls: run.urls } : {}),
    ...(run.schema !== undefined ? { schema: run.schema } : {}),
    mode: run.mode,
    ...(run.strictConstrainToURLs ? { strictConstrainToURLs: true } : {}),
  };
  const schema = JSON.stringify(run.schema ?? { type: "object" }, null, 2);

  const skillMd = `---
name: ${name}
description: Re-run the agent task "${run.prompt.slice(0, 120).replace(/"/g, "'")}" against a self-hosted Firecrawl API.
---

# ${name}

## Task
${run.prompt}

## Sources used
${run.sources.length ? run.sources.map(s => `- ${s}`).join("\n") : "- (none recorded)"}

## Approach
${Object.entries(toolCounts)
  .map(([tool, n]) => `- ${tool}: ${n} call(s)`)
  .join("\n") || "- No tool calls were recorded."}

## Output schema
\`\`\`json
${schema}
\`\`\`

Run \`workflow.mjs\` with FIRECRAWL_API_URL and FIRECRAWL_API_KEY set to repeat this task.
`;

  const workflow = `// Replays an agent task through a self-hosted Firecrawl API.
// Usage: FIRECRAWL_API_URL=http://localhost:3002 FIRECRAWL_API_KEY=... node workflow.mjs
const api = process.env.FIRECRAWL_API_URL;
if (!api) throw new Error("Set FIRECRAWL_API_URL");
const headers = {
  "Content-Type": "application/json",
  ...(process.env.FIRECRAWL_API_KEY ? { Authorization: \`Bearer \${process.env.FIRECRAWL_API_KEY}\` } : {}),
};
const spec = ${JSON.stringify(spec, null, 2)};
const start = await fetch(\`\${api}/v2/agent\`, { method: "POST", headers, body: JSON.stringify(spec) }).then(r => r.json());
if (!start.success) throw new Error(start.error ?? "agent start failed");
for (;;) {
  await new Promise(r => setTimeout(r, 3000));
  const status = await fetch(\`\${api}/v2/agent/\${start.id}\`, { headers }).then(r => r.json());
  if (status.status === "processing") continue;
  console.log(JSON.stringify(status.data ?? status, null, 2));
  break;
}
`;

  return {
    skill: { name, spec, skillMd, workflow, schema },
    blueprint: { sources: run.sources, tools: toolCounts, steps: run.steps },
  };
}
