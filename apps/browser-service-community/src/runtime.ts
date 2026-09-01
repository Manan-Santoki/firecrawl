import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  BrowserExecResult,
  BrowserRuntime,
  BrowserRuntimeFactoryOptions,
} from "./session-manager.js";

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForDevToolsFile(file: string, child: ChildProcess): Promise<string[]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chromium exited during startup (${child.exitCode})`);
    try {
      const lines = (await readFile(file, "utf8")).trim().split(/\r?\n/);
      if (lines.length >= 2) return lines;
    } catch {
      // Chromium creates this file after the debugging socket is ready.
    }
    await delay(50);
  }
  throw new Error("Timed out waiting for Chromium DevTools endpoint");
}

const RESULT_MARKER = "__FIRECRAWL_RESULT__";
const NODE_WRAPPER = `import { chromium } from "playwright";
const browser = await chromium.connectOverCDP(process.env.AGENT_BROWSER_CDP);
const context = browser.contexts()[0];
if (!context) throw new Error("Chromium did not expose a default context");
let page = context.pages().at(-1) ?? await context.newPage();
const source = Buffer.from(process.env.FIRECRAWL_NODE_CODE, "base64").toString("utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
try {
  const execute = new AsyncFunction("browser", "context", "page", "Buffer", "URL", "URLSearchParams", "TextEncoder", "TextDecoder", source);
  const value = await execute(browser, context, page, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder);
  let result;
  if (value === undefined) result = "undefined";
  else if (typeof value === "string") result = value;
  else { try { result = JSON.stringify(value); } catch { result = String(value); } }
  // The Playwright CDP connection intentionally remains open for the session,
  // but this one-shot executor must not keep its own event loop alive.
  process.stdout.write("\\n${RESULT_MARKER}" + result, () => process.exit(0));
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(message + "\\n", () => process.exit(1));
}`;

export class PlaywrightBrowserRuntime implements BrowserRuntime {
  readonly internalCdpUrl: string;
  private closed = false;

  private constructor(
    private readonly sessionId: string,
    private readonly child: ChildProcess,
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    page: Page,
    private readonly userDataDir: string,
    internalCdpUrl: string,
  ) {
    this.internalCdpUrl = internalCdpUrl;
    this.installPageGuards(page);
    context.on("page", nextPage => this.installPageGuards(nextPage));
  }

  static async create(options: BrowserRuntimeFactoryOptions): Promise<PlaywrightBrowserRuntime> {
    const profileRoot = process.env.BROWSER_PROFILE_ROOT ?? path.join(tmpdir(), "firecrawl-browser-profiles");
    await mkdir(profileRoot, { recursive: true });
    const persistentId = options.persistentStorage?.uniqueId.replace(/[^A-Za-z0-9_.-]/g, "_");
    const userDataDir = persistentId
      ? path.join(profileRoot, persistentId)
      : await mkdtemp(path.join(tmpdir(), "fc-browser-"));
    await mkdir(userDataDir, { recursive: true });

    const executable = process.env.CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--remote-debugging-address=0.0.0.0",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ];
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let startupStderr = "";
    child.stderr?.on("data", chunk => {
      startupStderr = `${startupStderr}${String(chunk)}`.slice(-8_000);
    });

    try {
      const [port, browserPath] = await waitForDevToolsFile(path.join(userDataDir, "DevToolsActivePort"), child);
      if (!port || !browserPath) throw new Error("Chromium returned an invalid DevTools endpoint");
      const internalCdpUrl = `ws://127.0.0.1:${port}${browserPath.startsWith("/") ? browserPath : `/${browserPath}`}`;
      const browser = await chromium.connectOverCDP(internalCdpUrl);
      const context = browser.contexts()[0];
      if (!context) throw new Error("Chromium did not expose a default context");
      const page = context.pages()[0] ?? (await context.newPage());
      return new PlaywrightBrowserRuntime(options.sessionId, child, browser, context, page, userDataDir, internalCdpUrl);
    } catch (error) {
      child.kill("SIGKILL");
      if (!persistentId) await rm(userDataDir, { recursive: true, force: true });
      throw new Error(`${error instanceof Error ? error.message : String(error)}${startupStderr ? `: ${startupStderr}` : ""}`);
    }
  }

  private installPageGuards(page: Page): void {
    page.on("dialog", dialog => void dialog.dismiss().catch(() => undefined));
  }

  async execute(language: string, code: string, timeoutSeconds: number): Promise<BrowserExecResult> {
    if (this.closed) return { stdout: "", result: "", stderr: "Browser session is closed", exitCode: 1, killed: false };
    if (language === "node") return this.executeNodeProcess(code, timeoutSeconds);
    if (language === "bash") return this.executeProcess(code, timeoutSeconds, false);
    if (language === "python") return this.executeProcess(code, timeoutSeconds, true);
    return { stdout: "", result: "", stderr: `Unsupported language: ${language}`, exitCode: 1, killed: false };
  }

  private async executeNodeProcess(code: string, timeoutSeconds: number): Promise<BrowserExecResult> {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", NODE_WRAPPER], {
      windowsHide: true,
      env: {
        ...process.env,
        NO_COLOR: "1",
        AGENT_BROWSER_CDP: this.internalCdpUrl,
        AGENT_BROWSER_SESSION: this.sessionId,
        FIRECRAWL_NODE_CODE: Buffer.from(code).toString("base64"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += String(chunk)));
    child.stderr.on("data", chunk => (stderr += String(chunk)));
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1_000);
    const exitCode = await new Promise<number>(resolve => {
      child.once("error", error => {
        stderr += `${stderr ? "\n" : ""}${error.message}`;
        resolve(1);
      });
      child.once("exit", code => resolve(code ?? (killed ? 124 : 1)));
    });
    clearTimeout(timer);

    let result = "";
    const markerIndex = stdout.lastIndexOf(RESULT_MARKER);
    if (markerIndex >= 0) {
      result = stdout.slice(markerIndex + RESULT_MARKER.length).trim();
      stdout = stdout.slice(0, markerIndex).trimEnd();
    }
    if (killed) {
      stderr = [stderr.trimEnd(), "Execution timed out; browser session command was terminated"]
        .filter(Boolean)
        .join("\n");
    }
    return { stdout: stdout.trimEnd(), result, stderr: stderr.trimEnd(), exitCode, killed };
  }

  private async executeProcess(code: string, timeoutSeconds: number, python: boolean): Promise<BrowserExecResult> {
    const command = python ? process.env.PYTHON_EXECUTABLE ?? "python3" : process.platform === "win32" ? "powershell.exe" : "/bin/bash";
    const pythonWrapper = `import asyncio, base64, json, os\nfrom playwright.async_api import async_playwright\nasync def main():\n    async with async_playwright() as p:\n        browser = await p.chromium.connect_over_cdp(os.environ["AGENT_BROWSER_CDP"])\n        context = browser.contexts[0]\n        page = context.pages[0] if context.pages else await context.new_page()\n        code = base64.b64decode(os.environ["FIRECRAWL_PYTHON_CODE"]).decode("utf-8")\n        namespace = {"browser": browser, "context": context, "page": page}\n        wrapped = "async def __firecrawl_user_code__():\\n" + "\\n".join("    " + line for line in code.splitlines())\n        exec(wrapped, namespace)\n        result = await namespace["__firecrawl_user_code__"]()\n        print("__FIRECRAWL_RESULT__" + json.dumps(result, default=str))\nasyncio.run(main())`;
    const args = python
      ? ["-c", pythonWrapper]
      : process.platform === "win32"
        ? ["-NoProfile", "-NonInteractive", "-Command", code]
        : ["-lc", code];
    const binDir = path.join(process.cwd(), "node_modules", ".bin");
    const child = spawn(command, args, {
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        NO_COLOR: "1",
        AGENT_BROWSER_CDP: this.internalCdpUrl,
        AGENT_BROWSER_SESSION: this.sessionId,
        FIRECRAWL_PYTHON_CODE: python ? Buffer.from(code).toString("base64") : "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += String(chunk)));
    child.stderr.on("data", chunk => (stderr += String(chunk)));
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1_000);
    const exitCode = await new Promise<number>(resolve => {
      child.once("error", error => {
        stderr += `${stderr ? "\n" : ""}${error.message}`;
        resolve(1);
      });
      child.once("exit", code => resolve(code ?? (killed ? 124 : 1)));
    });
    clearTimeout(timer);
    let result = "";
    if (python) {
      const marker = "__FIRECRAWL_RESULT__";
      const index = stdout.lastIndexOf(marker);
      if (index >= 0) {
        result = stdout.slice(index + marker.length).trim();
        stdout = stdout.slice(0, index).trimEnd();
      }
    }
    return { stdout: stdout.trimEnd(), result, stderr: stderr.trimEnd(), exitCode, killed };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // CDP shutdown can stall while Chromium is under memory or I/O pressure.
    // Give it a short graceful window, then kill the owned process so queued
    // cleanup cannot retain a browser slot indefinitely.
    await Promise.race([
      this.browser.close().catch(() => undefined),
      delay(2_000),
    ]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
    if (!this.userDataDir.startsWith(path.join(tmpdir(), "fc-browser-"))) return;
    await rm(this.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const createPlaywrightRuntime = (options: BrowserRuntimeFactoryOptions) =>
  PlaywrightBrowserRuntime.create(options);
