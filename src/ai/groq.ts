// A free(-tier) alternative to Claude for the Dungeon Master: Groq's
// OpenAI-compatible chat completions API, adapted to the same DmModel
// interface so the rest of the DM code doesn't change.
import type { Config } from "../config.js";
import { UserError } from "../discord/ui.js";
import type { BetaMessage, DmModel, ModelRequest } from "./model.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/** Longest total time one call will spend waiting out rate limits. */
const MAX_RATE_LIMIT_WAIT_MS = 65_000;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_COMPLETION_TOKENS = 4096;

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

interface ChatResponse {
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The model wrote a tool call Groq couldn't parse (HTTP 400 "tool_use_failed"). */
class ToolCallFailed extends Error {}

export class GroqRateLimitError extends UserError {
  constructor() {
    super("The free AI Dungeon Master (Groq) has hit its rate limit. Give it a minute and try again.");
  }
}

type Block = { type: string; [k: string]: unknown };

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocksOf(content)
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n");
}

/** Converts an Anthropic-shaped request into OpenAI-style chat messages. */
export function toChatMessages(req: ModelRequest): ChatMessage[] {
  const out: ChatMessage[] = [];
  const system = req.system.map((b) => b.text).join("\n\n");
  if (system) out.push({ role: "system", content: system });
  const toolNames = new Map<string, string>();

  for (const m of req.messages) {
    if (typeof m.content === "string") {
      out.push(m.role === "assistant" ? { role: "assistant", content: m.content } : { role: "user", content: m.content });
      continue;
    }
    const blocks = blocksOf(m.content);
    if (m.role === "assistant") {
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("\n\n");
      const calls: ToolCall[] = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          toolNames.set(String(b.id), String(b.name));
          return { id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } };
        });
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results must come right after the assistant message that made the calls.
    const texts: string[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        const id = String(b.tool_use_id);
        const body = toolResultText(b.content);
        out.push({ role: "tool", tool_call_id: id, name: toolNames.get(id) ?? "tool", content: b.is_error ? `Error: ${body}` : body });
      } else if (b.type === "text") {
        texts.push(String(b.text ?? ""));
      }
    }
    if (texts.length) out.push({ role: "user", content: texts.join("\n\n") });
  }
  return out;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Converts a chat completion back into the Anthropic message shape the DM loop expects. */
export function toBetaMessage(data: ChatResponse, model: string): BetaMessage {
  const choice = data.choices?.[0];
  const msg = choice?.message ?? {};
  const content: Record<string, unknown>[] = [];
  const text = (msg.content ?? "").trim();
  if (text) content.push({ type: "text", text, citations: null });
  for (const call of msg.tool_calls ?? []) {
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseArgs(call.function.arguments) });
  }
  const finish = choice?.finish_reason;
  const stop_reason = msg.tool_calls?.length
    ? "tool_use"
    : finish === "length"
      ? "max_tokens"
      : finish === "content_filter"
        ? "refusal"
        : "end_turn";
  return {
    id: `groq_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as BetaMessage;
}

function reasoningParams(model: string, effort: Config["dmEffort"] | undefined): Record<string, unknown> {
  if (model.includes("gpt-oss")) {
    // gpt-oss accepts low/medium/high; reasoning text isn't needed in the response.
    const level = effort === "low" ? "low" : effort === "medium" || effort === undefined ? "medium" : "high";
    return { reasoning_effort: level, include_reasoning: false };
  }
  // Other reasoning models need a non-raw format when tools are used.
  if (/qwen|minimax|muse/.test(model)) return { reasoning_format: "hidden" };
  return {};
}

function retryAfterMs(header: string | null): number {
  const secs = Number(header);
  return Number.isFinite(secs) && secs > 0 ? Math.ceil(secs * 1000) : 5000;
}

export class GroqDmModel implements DmModel {
  /** Groq's free tier allows few tokens per minute, so send less context. */
  readonly lean = true;
  readonly label: string;

  constructor(
    private apiKey: string,
    private model: string,
    private fetchImpl: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.label = `Groq (${model})`;
  }

  async create(req: ModelRequest): Promise<BetaMessage> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: toChatMessages(req),
      max_completion_tokens: Math.min(req.maxTokens ?? MAX_COMPLETION_TOKENS, MAX_COMPLETION_TOKENS),
      ...reasoningParams(this.model, req.effort),
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description ?? "", parameters: t.input_schema },
      }));
      body.tool_choice = "auto";
    }
    const budget = { waitedMs: 0 };
    try {
      return toBetaMessage(await this.post(body, budget), this.model);
    } catch (err) {
      if (!(err instanceof ToolCallFailed)) throw err;
    }
    // Open models sometimes write a malformed tool call. Try once more, then settle for narration only.
    try {
      return toBetaMessage(await this.post(body, budget), this.model);
    } catch (err) {
      if (!(err instanceof ToolCallFailed) || !body.tools) throw err;
    }
    return toBetaMessage(await this.post({ ...body, tool_choice: "none" }, budget), this.model);
  }

  private async post(body: Record<string, unknown>, budget: { waitedMs: number }): Promise<ChatResponse> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return (await res.json()) as ChatResponse;

      if (res.status === 429) {
        // Free-tier limits are per minute; waiting briefly usually works.
        const wait = retryAfterMs(res.headers.get("retry-after"));
        if (budget.waitedMs + wait > MAX_RATE_LIMIT_WAIT_MS) throw new GroqRateLimitError();
        budget.waitedMs += wait;
        await this.sleep(wait);
        continue;
      }
      const text = await res.text().catch(() => "");
      if (res.status === 400 && text.includes("tool_use_failed")) throw new ToolCallFailed();
      if (res.status >= 500 && attempt < 2) {
        await this.sleep(1000 * (attempt + 1));
        continue;
      }
      if (res.status === 401) throw new UserError("The Groq API key was rejected. Check `GROQ_API_KEY` in the bot's settings.");
      throw new Error(`Groq ${res.status}: ${text.slice(0, 300)}`);
    }
  }
}
