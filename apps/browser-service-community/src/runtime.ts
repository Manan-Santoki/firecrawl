import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
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

function serializeResult(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class PlaywrightBrowserRuntime implements BrowserRuntime {
  readonly internalCdpUrl: string;
  private closed = false;
  private page: Page;
  private readonly sandbox: vm.Context;

  private constructor(
    private readonly sessionId: string,
    private readonly child: ChildProcess,
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    page: Page,
    private readonly userDataDir: string,
    internalCdpUrl: string,
  ) {
    this.page = page;
    this.internalCdpUrl = internalCdpUrl;
    this.sandbox = vm.createContext({ browser, context, page, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, setTimeout, clearTimeout });
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
    if (language === "node") return this.executeNode(code, timeoutSeconds);
    if (language === "bash") return this.executeProcess(code, timeoutSeconds, false);
    if (language === "python") return this.executeProcess(code, timeoutSeconds, true);
    return { stdout: "", result: "", stderr: `Unsupported language: ${language}`, exitCode: 1, killed: false };
  }

  private async executeNode(code: string, timeoutSeconds: number): Promise<BrowserExecResult> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    this.sandbox.page = this.page;
    this.sandbox.console = {
      log: (...values: unknown[]) => stdout.push(values.map(String).join(" ")),
      info: (...values: unknown[]) => stdout.push(values.map(String).join(" ")),
      warn: (...values: unknown[]) => stderr.push(values.map(String).join(" ")),
      error: (...values: unknown[]) => stderr.push(values.map(String).join(" ")),
    };

    try {
      const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: `browser-${this.sessionId}.mjs` });
      const execution = Promise.resolve(script.runInContext(this.sandbox, { timeout: timeoutSeconds * 1_000 }));
      const result = await Promise.race([
        execution,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("__FIRECRAWL_TIMEOUT__")), timeoutSeconds * 1_000)),
      ]);
      if (this.sandbox.page && this.sandbox.page !== this.page) this.page = this.sandbox.page as Page;
      return { stdout: stdout.join("\n"), result: serializeResult(result), stderr: stderr.join("\n"), exitCode: 0, killed: false };
    } catch (error) {
      if (error instanceof Error && error.message === "__FIRECRAWL_TIMEOUT__") {
        await this.close();
        return { stdout: stdout.join("\n"), result: "", stderr: "Execution timed out; browser session was terminated", exitCode: 124, killed: true };
      }
      return { stdout: stdout.join("\n"), result: "", stderr: [stderr.join("\n"), error instanceof Error ? error.stack ?? error.message : String(error)].filter(Boolean).join("\n"), exitCode: 1, killed: false };
    }
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
    await this.browser.close().catch(() => undefined);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
    if (!this.userDataDir.startsWith(path.join(tmpdir(), "fc-browser-"))) return;
    await rm(this.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const createPlaywrightRuntime = (options: BrowserRuntimeFactoryOptions) =>
  PlaywrightBrowserRuntime.create(options);
