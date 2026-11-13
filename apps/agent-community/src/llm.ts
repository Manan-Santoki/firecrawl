/**
 * OpenAI-compatible Chat Completions client (OpenAI, LiteLLM, vLLM, Ollama,
 * llama.cpp server, ...). Plain fetch keeps the dependency tree small and the
 * wire format easy to mock in tests.
 */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ResponseFormat =
  | { type: "json_schema"; json_schema: { name: string; schema: unknown; strict?: boolean } }
  | { type: "json_object" };

export type ChatResult = {
  message: { content: string | null; tool_calls?: ToolCall[] };
  usage: { prompt: number; completion: number; total: number };
  finishReason?: string;
};

export class LlmError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export type LlmOptions = {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  timeoutMs: number;
  temperature: number;
};

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class LlmClient {
  constructor(readonly opts: LlmOptions) {}

  async chat(
    params: {
      messages: ChatMessage[];
      tools?: ToolDefinition[];
      responseFormat?: ResponseFormat;
      maxTokens?: number;
    },
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: params.messages,
      temperature: this.opts.temperature,
      ...(params.tools && params.tools.length > 0 ? { tools: params.tools, tool_choice: "auto" } : {}),
      ...(params.responseFormat ? { response_format: params.responseFormat } : {}),
      ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** attempt, signal);
      try {
        const timeout = AbortSignal.timeout(this.opts.timeoutMs);
        const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new LlmError(res.status, `Model endpoint returned ${res.status}: ${text.slice(0, 300)}`);
          if (RETRYABLE.has(res.status)) {
            lastError = err;
            continue;
          }
          throw err;
        }
        const json = JSON.parse(text);
        const choice = json?.choices?.[0];
        if (!choice?.message) throw new LlmError(502, "Model endpoint returned no choices");
        const usage = json.usage ?? {};
        return {
          message: {
            content: typeof choice.message.content === "string" ? choice.message.content : null,
            tool_calls: Array.isArray(choice.message.tool_calls)
              ? choice.message.tool_calls.map(normalizeToolCall)
              : undefined,
          },
          usage: {
            prompt: usage.prompt_tokens ?? 0,
            completion: usage.completion_tokens ?? 0,
            total: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
          },
          finishReason: choice.finish_reason,
        };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof LlmError && !RETRYABLE.has(error.status)) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

/** Some servers (Ollama, older vLLM) omit ids or send arguments as an object. */
export function normalizeToolCall(raw: any, index: number): ToolCall {
  const args = raw?.function?.arguments;
  return {
    id: typeof raw?.id === "string" && raw.id ? raw.id : `call_${index}_${Date.now().toString(36)}`,
    type: "function",
    function: {
      name: String(raw?.function?.name ?? ""),
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    },
  };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}
