import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type BrowserLanguage = "node" | "bash" | "python";

export interface BrowserExecResult {
  stdout: string;
  result: string;
  stderr: string;
  exitCode: number;
  killed: boolean;
}

export interface BrowserRuntime {
  readonly internalCdpUrl: string;
  execute(language: string, code: string, timeoutSeconds: number): Promise<BrowserExecResult>;
  close(): Promise<void>;
}

export interface BrowserRuntimeFactoryOptions {
  sessionId: string;
  persistentStorage?: { uniqueId: string; write: boolean };
}

export type BrowserRuntimeFactory = (options: BrowserRuntimeFactoryOptions) => Promise<BrowserRuntime>;

export interface CreateSessionRequest {
  ttl: number;
  activityTtl?: number;
  record?: boolean;
  persistentStorage?: { uniqueId: string; write: boolean };
}

export interface CreateSessionResponse {
  sessionId: string;
  cdpUrl: string;
  viewUrl: string;
  iframeUrl: string;
  interactiveIframeUrl: string;
  expiresAt: string;
}

export interface ExecuteRequest {
  language: BrowserLanguage;
  code: string;
  timeout: number;
  origin?: string;
}

export interface DeleteSessionResponse {
  ok: true;
  sessionDurationMs: number;
  cleanupQueued: true;
}

interface Session {
  id: string;
  token: string;
  runtime: BrowserRuntime;
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
  activityTtlMs?: number;
  profileWriterId?: string;
  queue: Promise<void>;
}

export class BrowserServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionManagerOptions {
  maxSessions: number;
  publicUrl: string;
  runtimeFactory: BrowserRuntimeFactory;
  now?: () => number;
  sweepIntervalMs?: number;
  tombstoneTtlMs?: number;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly tombstones = new Map<string, { response: DeleteSessionResponse; expiresAt: number }>();
  private readonly deletions = new Map<string, Promise<DeleteSessionResponse>>();
  private readonly cleanups = new Set<Promise<void>>();
  private readonly profileWriters = new Set<string>();
  private readonly now: () => number;
  private readonly tombstoneTtlMs: number;
  private readonly sweepTimer: NodeJS.Timeout;
  private closing = false;

  constructor(private readonly options: SessionManagerOptions) {
    this.now = options.now ?? Date.now;
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? 15 * 60_000;
    this.sweepTimer = setInterval(
      () => void this.sweepExpired(),
      options.sweepIntervalMs ?? 5_000,
    );
    this.sweepTimer.unref();
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  async create(request: CreateSessionRequest): Promise<CreateSessionResponse> {
    if (this.closing) throw new BrowserServiceError(503, "Browser service is shutting down");
    if (this.sessions.size >= this.options.maxSessions) {
      throw new BrowserServiceError(429, `Maximum concurrent browser sessions reached (${this.options.maxSessions})`);
    }

    const writerId = request.persistentStorage?.write ? request.persistentStorage.uniqueId : undefined;
    if (writerId && this.profileWriters.has(writerId)) {
      throw new BrowserServiceError(409, "Another session is already writing to this profile");
    }
    if (writerId) this.profileWriters.add(writerId);

    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    let runtime: BrowserRuntime;
    try {
      runtime = await this.options.runtimeFactory({ sessionId: id, persistentStorage: request.persistentStorage });
    } catch (error) {
      if (writerId) this.profileWriters.delete(writerId);
      throw error;
    }

    const createdAt = this.now();
    const session: Session = {
      id,
      token,
      runtime,
      createdAt,
      lastActivity: createdAt,
      expiresAt: createdAt + request.ttl * 1_000,
      activityTtlMs: request.activityTtl ? request.activityTtl * 1_000 : undefined,
      profileWriterId: writerId,
      queue: Promise.resolve(),
    };
    this.sessions.set(id, session);

    const publicUrl = this.options.publicUrl.replace(/\/$/, "");
    const wsBase = publicUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const query = `token=${encodeURIComponent(token)}`;
    return {
      sessionId: id,
      cdpUrl: `${wsBase}/cdp/${id}?${query}`,
      viewUrl: `${publicUrl}/view/${id}?${query}`,
      iframeUrl: `${publicUrl}/view/${id}?${query}`,
      interactiveIframeUrl: `${publicUrl}/view/${id}?${query}&interactive=1`,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  async execute(id: string, request: ExecuteRequest): Promise<BrowserExecResult> {
    const session = this.sessions.get(id);
    if (!session) throw new BrowserServiceError(404, "Browser session not found");

    const operation = session.queue.then(async () => {
      if (!this.sessions.has(id)) throw new BrowserServiceError(404, "Browser session not found");
      session.lastActivity = this.now();
      const result = await session.runtime.execute(request.language, request.code, request.timeout);
      session.lastActivity = this.now();
      return result;
    });
    session.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async delete(id: string): Promise<DeleteSessionResponse> {
    const existingDeletion = this.deletions.get(id);
    if (existingDeletion) return existingDeletion;

    const tombstone = this.tombstones.get(id);
    if (tombstone && tombstone.expiresAt > this.now()) return tombstone.response;

    const session = this.sessions.get(id);
    if (!session) throw new BrowserServiceError(404, "Browser session not found");

    const deletion = this.finalizeDelete(session);
    this.deletions.set(id, deletion);
    try {
      return await deletion;
    } finally {
      this.deletions.delete(id);
    }
  }

  private async finalizeDelete(session: Session): Promise<DeleteSessionResponse> {
    this.sessions.delete(session.id);

    const response: DeleteSessionResponse = {
      ok: true,
      sessionDurationMs: Math.max(0, this.now() - session.createdAt),
      cleanupQueued: true,
    };
    this.tombstones.set(session.id, { response, expiresAt: this.now() + this.tombstoneTtlMs });

    // The public contract reports that cleanup was queued, so acknowledge the
    // logical release immediately. Waiting for Chromium to exit here made the
    // DELETE request inherit any slow browser shutdown and surface as a 502 at
    // the API gateway even though the session slot had already been released.
    const cleanup = session.queue
      .catch(() => undefined)
      .then(() => session.runtime.close())
      .catch(() => undefined);
    this.cleanups.add(cleanup);
    void cleanup.finally(() => {
      this.cleanups.delete(cleanup);
      if (session.profileWriterId) this.profileWriters.delete(session.profileWriterId);
    });
    return response;
  }

  resolveCdpProxy(id: string, token: string | null): string {
    const session = this.sessions.get(id);
    if (!session || !token || !secureEqual(session.token, token)) {
      throw new BrowserServiceError(404, "Browser session not found");
    }
    session.lastActivity = this.now();
    return session.runtime.internalCdpUrl;
  }

  authorizeView(id: string, token: string | null): void {
    this.resolveCdpProxy(id, token);
  }

  async sweepExpired(): Promise<void> {
    const now = this.now();
    for (const [id, tombstone] of this.tombstones) {
      if (tombstone.expiresAt <= now) this.tombstones.delete(id);
    }
    const expired = [...this.sessions.values()].filter(session =>
      now >= session.expiresAt ||
      (session.activityTtlMs !== undefined && now - session.lastActivity >= session.activityTtlMs),
    );
    await Promise.allSettled(expired.map(session => this.delete(session.id)));
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.sweepTimer);
    await Promise.allSettled([...this.sessions.keys()].map(id => this.delete(id)));
    await Promise.allSettled([...this.cleanups]);
  }
}
