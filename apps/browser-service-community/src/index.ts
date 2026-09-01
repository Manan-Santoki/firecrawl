import http from "node:http";
import HttpProxy from "http-proxy";
import { createApp } from "./server.js";
import { createPlaywrightRuntime } from "./runtime.js";
import { BrowserServiceError, SessionManager } from "./session-manager.js";

const port = Number.parseInt(process.env.PORT ?? "3006", 10);
const host = process.env.HOST ?? "0.0.0.0";
const apiKey = process.env.BROWSER_SERVICE_API_KEY ?? "";
const publicUrl = process.env.BROWSER_PUBLIC_URL ?? `http://127.0.0.1:${port}`;
const maxSessions = Number.parseInt(process.env.MAX_CONCURRENT_SESSIONS ?? "2", 10);

if (!apiKey && process.env.ALLOW_INSECURE_NO_AUTH !== "true") {
  throw new Error("BROWSER_SERVICE_API_KEY is required unless ALLOW_INSECURE_NO_AUTH=true");
}

const manager = new SessionManager({ maxSessions, publicUrl, runtimeFactory: createPlaywrightRuntime });
const server = http.createServer(createApp({ manager, apiKey }));
const proxy = HttpProxy.createProxyServer({ ws: true, changeOrigin: true, ignorePath: true });

proxy.on("error", (_error, _request, socket) => {
  if ("destroy" in socket) socket.destroy();
});

server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url ?? "/", publicUrl);
    const match = url.pathname.match(/^\/cdp\/([^/]+)$/);
    if (!match?.[1]) throw new BrowserServiceError(404, "Browser session not found");
    const target = manager.resolveCdpProxy(decodeURIComponent(match[1]), url.searchParams.get("token"));
    proxy.ws(request, socket, head, { target });
  } catch {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ level: "info", message: "Community browser service listening", host, port, maxSessions }));
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", message: "Browser service shutting down", signal }));
  server.close();
  await manager.close();
  proxy.close();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", error => {
  console.error(JSON.stringify({ level: "error", message: "Unhandled rejection isolated", error: String(error) }));
});
