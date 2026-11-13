import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { ProxySettings } from "./config.js";

/**
 * Chromium answers an upstream proxy's 407 challenge through CDP auth
 * handling. Combined with request interception (context.route), that
 * handshake fails and pages surface net::ERR_HTTP_RESPONSE_CODE_FAILURE.
 * To keep Chrome out of proxy authentication entirely, credentialed proxies
 * are fronted by a loopback forwarder that adds Proxy-Authorization itself.
 * Chrome is pointed at http://127.0.0.1:<port> with no credentials.
 */
const forwarders = new Map<string, Promise<string>>();

export function localProxyFor(settings: ProxySettings): Promise<ProxySettings> | ProxySettings {
  if (!settings.username && !settings.password) return settings;
  const key = `${settings.server}\u0000${settings.username ?? ""}\u0000${settings.password ?? ""}`;
  let pending = forwarders.get(key);
  if (!pending) {
    pending = startForwarder(settings);
    forwarders.set(key, pending);
    pending.catch(() => forwarders.delete(key));
  }
  return pending.then(server => ({ server, bypass: settings.bypass }));
}

function upstreamOf(settings: ProxySettings) {
  const url = new URL(/^[a-z]+:\/\//i.test(settings.server) ? settings.server : `http://${settings.server}`);
  const secure = url.protocol === "https:";
  const port = Number(url.port || (secure ? 443 : 80));
  const auth = "Basic " + Buffer.from(`${settings.username ?? ""}:${settings.password ?? ""}`).toString("base64");
  return { host: url.hostname, port, secure, auth };
}

function connectUpstream(up: ReturnType<typeof upstreamOf>): Duplex {
  return up.secure
    ? tls.connect({ host: up.host, port: up.port, servername: up.host, ALPNProtocols: ["http/1.1"] })
    : net.connect({ host: up.host, port: up.port });
}

function startForwarder(settings: ProxySettings): Promise<string> {
  const up = upstreamOf(settings);
  const server = http.createServer((req, res) => {
    // Plain-HTTP requests arrive in absolute-URI form; relay them to the upstream proxy.
    const upstreamReq = http.request({
      createConnection: () => connectUpstream(up) as net.Socket,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, "proxy-authorization": up.auth },
    });
    upstreamReq.on("response", upstreamRes => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstreamReq);
  });

  server.on("connect", (req, client, head) => {
    const upstream = connectUpstream(up);
    let buffered = Buffer.alloc(0);
    const fail = () => {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstream.destroy();
    };
    upstream.once("error", fail);
    client.on("error", () => upstream.destroy());
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) return;
      upstream.off("data", onData);
      const status = buffered.subarray(0, buffered.indexOf("\r\n")).toString();
      if (!/^HTTP\/1\.[01] 200/.test(status)) {
        client.end(`${status}\r\n\r\n`);
        upstream.destroy();
        return;
      }
      upstream.off("error", fail);
      upstream.on("error", () => client.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = buffered.subarray(end + 4);
      if (rest.length) client.write(rest);
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    };
    upstream.on("data", onData);
    upstream.write(
      `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${up.auth}\r\nProxy-Connection: keep-alive\r\n\r\n`,
    );
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("proxy forwarder failed to bind"));
      server.unref();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
