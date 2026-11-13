#!/usr/bin/env node
// Path-normalizing gateway in front of fake-gcs-server.
//
// When STORAGE_EMULATOR_HOST is set, @google-cloud/storage (v7) uses the
// variable verbatim as its JSON API base URL, so object reads and metadata
// calls arrive as "/b/{bucket}/o/{object}", while uploads arrive as
// "/upload/storage/v1/b/{bucket}/o". fake-gcs-server only routes the
// "/storage/v1/..." form, so object reads 404. This gateway prefixes the
// missing "/storage/v1" and streams everything else through unchanged, so the
// API, the highlight service and gsutil-style clients can share one
// STORAGE_EMULATOR_HOST without source changes. It adds no authentication and
// must only be reachable on the private Compose network.
import http from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

const passthroughPrefixes = ["/storage/v1/", "/upload/", "/download/", "/_internal/"];

export function rewritePath(rawPath) {
  const path = rawPath || "/";
  if (passthroughPrefixes.some(prefix => path.startsWith(prefix)) || path === "/storage/v1") {
    return path;
  }
  if (path === "/b" || path.startsWith("/b/") || path.startsWith("/b?")) {
    return `/storage/v1${path}`;
  }
  return path;
}

const hopByHop = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

export function createGateway({ backend }) {
  const target = new URL(backend);
  return http.createServer((request, response) => {
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!hopByHop.has(name.toLowerCase())) headers[name] = value;
    }
    headers.host = target.host;
    const upstream = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: rewritePath(request.url),
      headers,
    }, upstreamResponse => {
      const responseHeaders = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (!hopByHop.has(name.toLowerCase())) responseHeaders[name] = value;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", error => {
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "text/plain" });
      }
      response.end(`gateway error: ${error.message}`);
    });
    request.pipe(upstream);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const backend = process.env.GCS_BACKEND_URL ?? "http://firecrawl-index-storage-backend:4443";
  const port = Number(process.env.PORT ?? 4443);
  const server = createGateway({ backend });
  server.keepAliveTimeout = 65_000;
  server.listen(port, "0.0.0.0", () => {
    console.log(`gcs json gateway listening on ${port} -> ${backend}`);
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
