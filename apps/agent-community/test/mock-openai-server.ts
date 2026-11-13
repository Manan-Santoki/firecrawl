/**
 * A deterministic OpenAI-compatible Chat Completions server for end-to-end
 * checks of the full stack without a real model:
 *   1. scrape the first <start_urls> entry (or search the task when none),
 *   2. answer with the first markdown heading of the scraped page,
 *   3. when asked for JSON, fill every string property of the schema with it.
 *
 *   PORT=39200 tsx test/mock-openai-server.ts
 */
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 39200);

function reply(message: Record<string, unknown>) {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion",
    model: "mock-model",
    choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", ...message } }],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  };
}

function heading(messages: any[]): string {
  for (const m of messages) {
    if (m.role !== "tool") continue;
    try {
      const md: string = JSON.parse(m.content).markdown ?? "";
      const h = /^#+\s+(.+)$/m.exec(md);
      if (h) return h[1]!.trim();
      const firstLine = md.split("\n").find(l => l.trim());
      if (firstLine) return firstLine.trim().slice(0, 120);
    } catch {
      // not a scrape result
    }
  }
  return "unknown";
}

function fill(schema: any, value: string): unknown {
  if (!schema || typeof schema !== "object") return value;
  if (schema.type === "object" || schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = fill(v, value);
    return out;
  }
  if (schema.type === "array") return [fill(schema.items, value)];
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return true;
  return value;
}

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const messages: any[] = body.messages ?? [];
  let out;
  if (!body.tools) {
    const h = heading(messages);
    const schema = body.response_format?.json_schema?.schema;
    const last = String(messages.at(-1)?.content ?? "");
    out = body.response_format || last.includes("JSON")
      ? reply({ content: JSON.stringify(schema ? fill(schema, h) : { heading: h }) })
      : reply({ content: `The main heading is "${h}".` });
  } else if (!messages.some(m => m.role === "tool")) {
    const task = messages.filter(m => m.role === "user").map(m => String(m.content)).join("\n");
    const url = /<start_urls>\s*(\S+)/.exec(task)?.[1];
    const call = url
      ? { name: "scrape", arguments: JSON.stringify({ url }) }
      : { name: "search", arguments: JSON.stringify({ query: task.slice(0, 100), limit: 3 }) };
    out = reply({ content: null, tool_calls: [{ id: "call_1", type: "function", function: call }] });
  } else {
    out = reply({ content: `The main heading is "${heading(messages)}".` });
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(out));
}).listen(port, "0.0.0.0", () => console.log(`mock model on :${port}`));
