import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { BrowserServiceError, type SessionManager } from "./session-manager.js";

const createSchema = z.object({
  ttl: z.number().int().min(30).max(3600).default(600),
  activityTtl: z.number().int().min(10).max(3600).optional(),
  record: z.boolean().default(true),
  persistentStorage: z
    .object({ uniqueId: z.string().min(1).max(256), write: z.boolean().default(true) })
    .optional(),
});

const executeSchema = z.object({
  code: z.string().min(1).max(100_000),
  language: z.enum(["python", "node", "bash"]).default("node"),
  timeout: z.number().int().min(1).max(300).default(30),
  origin: z.string().max(128).optional(),
});

function sameSecret(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface CreateAppOptions {
  manager: SessionManager;
  apiKey: string;
}

export function createApp({ manager, apiKey }: CreateAppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/health/liveness", (_req, res) => res.status(200).json({ ok: true }));
  app.get("/health/readiness", (_req, res) =>
    res.status(200).json({ ok: true, activeSessions: manager.activeCount }),
  );

  app.get("/view/:id", (req, res, next) => {
    try {
      const token = typeof req.query.token === "string" ? req.query.token : null;
      manager.authorizeView(req.params.id, token);
      const interactive = req.query.interactive === "1";
      res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ws: wss:");
      res.setHeader("Cache-Control", "no-store");
      res.type("html").send(renderViewer(req.params.id, token!, interactive));
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res, next) => {
    const authorization = req.headers.authorization;
    const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!apiKey || !provided || !sameSecret(provided, apiKey)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  });

  app.post("/browsers", async (req, res, next) => {
    try {
      const body = createSchema.parse(req.body);
      res.status(201).json(await manager.create(body));
    } catch (error) {
      next(error);
    }
  });

  app.post("/browsers/:id/exec", async (req, res, next) => {
    try {
      const body = executeSchema.parse(req.body);
      res.status(200).json(await manager.execute(req.params.id, body));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/browsers/:id", async (req, res, next) => {
    try {
      res.status(200).json(await manager.delete(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get("/browsers/:id/recording", (_req, res) =>
    res.status(404).json({ error: "Session recording is not enabled in this community release" }),
  );
  app.get("/browsers/:id/recording/:pageId", (_req, res) =>
    res.status(404).json({ error: "Session recording is not enabled in this community release" }),
  );

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid request", details: error.issues });
    }
    if (error instanceof BrowserServiceError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error("Unhandled browser service request error", error);
    return res.status(500).json({ error: "Internal browser service error" });
  });

  return app;
}

function renderViewer(id: string, token: string, interactive: boolean): string {
  const wsPath = `/cdp/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Browser session</title>
<style>html,body{margin:0;width:100%;height:100%;background:#111;color:#eee;font:14px system-ui}#screen{width:100%;height:100%;object-fit:contain;display:block}#status{position:fixed;left:8px;top:8px;background:#000b;padding:6px 9px;border-radius:5px}</style></head>
<body><img id="screen" alt="Live browser view"><div id="status">Connecting…</div><script>
const interactive=${JSON.stringify(interactive)}; const path=${JSON.stringify(wsPath)};
const socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+path);
const image=document.getElementById('screen'); const status=document.getElementById('status'); let sequence=0; let targetSession=null; const pending=new Map();
function send(method,params={},sessionId){const id=++sequence;socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));}
socket.onopen=async()=>{try{const targets=await send('Target.getTargets');const target=targets.targetInfos.find(x=>x.type==='page');if(!target)throw new Error('No page target');const attached=await send('Target.attachToTarget',{targetId:target.targetId,flatten:true});targetSession=attached.sessionId;await send('Page.enable',{},targetSession);await send('Page.startScreencast',{format:'jpeg',quality:70,maxWidth:1600,maxHeight:1000,everyNthFrame:1},targetSession);status.textContent=interactive?'Interactive live view':'Live view';}catch(error){status.textContent=String(error)}};
socket.onmessage=event=>{const msg=JSON.parse(event.data);if(msg.id&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result);return}if(msg.method==='Page.screencastFrame'){image.src='data:image/jpeg;base64,'+msg.params.data;send('Page.screencastFrameAck',{sessionId:msg.params.sessionId},msg.sessionId)}};
socket.onclose=()=>status.textContent='Session ended'; socket.onerror=()=>status.textContent='Connection error';
if(interactive){image.style.cursor='default';image.addEventListener('click',async event=>{if(!targetSession||!image.naturalWidth)return;const rect=image.getBoundingClientRect();const scale=Math.min(rect.width/image.naturalWidth,rect.height/image.naturalHeight);const shownW=image.naturalWidth*scale,shownH=image.naturalHeight*scale;const x=(event.clientX-(rect.left+(rect.width-shownW)/2))/scale;const y=(event.clientY-(rect.top+(rect.height-shownH)/2))/scale;await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1},targetSession);await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1},targetSession)});window.addEventListener('keydown',event=>{if(!targetSession)return;event.preventDefault();if(event.key.length===1)send('Input.insertText',{text:event.key},targetSession);else send('Input.dispatchKeyEvent',{type:'keyDown',key:event.key,code:event.code},targetSession).then(()=>send('Input.dispatchKeyEvent',{type:'keyUp',key:event.key,code:event.code},targetSession));});}
</script></body></html>`;
}
