import { describe, expect, it } from "vitest";
import { GroqDmModel, GroqRateLimitError, toBetaMessage, toChatMessages } from "../src/ai/groq.js";
import { loadConfig } from "../src/config.js";
import { createDmModel } from "../src/runtime.js";
import { ALEX, command, fixedRng, makeDeps, run, sub } from "./helpers.js";

interface Call {
  url: string;
  body: any;
  headers: Record<string, string>;
}

/** A fake Groq endpoint that replays canned responses. */
function fakeGroq(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const next = responses.shift();
    if (!next) throw new Error("fake Groq ran out of responses");
    return next();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const completion = (message: Record<string, unknown>, finish = "stop") => () =>
  Response.json({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 1200, completion_tokens: 80 } });
const toolCall = (id: string, name: string, args: unknown) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

describe("format conversion", () => {
  it("turns the DM conversation into chat messages", () => {
    const msgs = toChatMessages({
      system: [{ type: "text", text: "You are the DM." }],
      messages: [
        { role: "user", content: "The party enters." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "x" } as any,
            { type: "text", text: "Let me roll.", citations: null },
            { type: "tool_use", id: "t1", name: "roll_dice", input: { expression: "1d20", reason: "x" } },
            { type: "tool_use", id: "t2", name: "next_turn", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "x: 12" },
            { type: "tool_result", tool_use_id: "t2", content: "no combat", is_error: true },
          ],
        },
      ],
    });
    expect(msgs).toEqual([
      { role: "system", content: "You are the DM." },
      { role: "user", content: "The party enters." },
      {
        role: "assistant",
        content: "Let me roll.",
        tool_calls: [
          { id: "t1", type: "function", function: { name: "roll_dice", arguments: '{"expression":"1d20","reason":"x"}' } },
          { id: "t2", type: "function", function: { name: "next_turn", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "t1", name: "roll_dice", content: "x: 12" },
      { role: "tool", tool_call_id: "t2", name: "next_turn", content: "Error: no combat" },
    ]);
  });

  it("turns completions back into tool_use and text blocks", () => {
    const m = toBetaMessage(
      {
        choices: [
          {
            message: { content: "  Swords clash!  ", tool_calls: [toolCall("c1", "roll_dice", { expression: "1d6" }), { id: "c2", type: "function" as const, function: { name: "next_turn", arguments: "not json" } }] },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      "llama",
    );
    expect(m.stop_reason).toBe("tool_use");
    expect(m.content).toEqual([
      { type: "text", text: "Swords clash!", citations: null },
      { type: "tool_use", id: "c1", name: "roll_dice", input: { expression: "1d6" } },
      { type: "tool_use", id: "c2", name: "next_turn", input: {} },
    ]);
    expect(m.usage.input_tokens).toBe(10);
    expect(toBetaMessage({ choices: [{ message: { content: "Hi" }, finish_reason: "length" }] }, "x").stop_reason).toBe("max_tokens");
    expect(toBetaMessage({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] }, "x").stop_reason).toBe("refusal");
  });
});

describe("GroqDmModel", () => {
  const req = {
    system: [{ type: "text" as const, text: "DM" }],
    messages: [{ role: "user" as const, content: "Go" }],
    tools: [{ name: "next_turn", description: "Advance", input_schema: { type: "object" as const, properties: {} } }],
  };

  it("sends an OpenAI-style request", async () => {
    const g = fakeGroq([completion({ content: "Onward." })]);
    const model = new GroqDmModel("gsk_test", "llama-3.3-70b-versatile", g.fetchImpl, async () => {});
    const res = await model.create(req);
    expect(res.content).toEqual([{ type: "text", text: "Onward.", citations: null }]);
    const call = g.calls[0]!;
    expect(call.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer gsk_test");
    expect(call.body).toMatchObject({
      model: "llama-3.3-70b-versatile",
      tool_choice: "auto",
      max_completion_tokens: 4096,
      tools: [{ type: "function", function: { name: "next_turn", description: "Advance", parameters: { type: "object", properties: {} } } }],
    });
    expect(call.body.reasoning_effort).toBeUndefined();
  });

  it("sets reasoning options for gpt-oss", async () => {
    const g = fakeGroq([completion({ content: "Ok" })]);
    await new GroqDmModel("k", "openai/gpt-oss-120b", g.fetchImpl, async () => {}).create({ ...req, effort: "xhigh" });
    expect(g.calls[0]!.body).toMatchObject({ reasoning_effort: "high", include_reasoning: false });
  });

  it("waits out rate limits, then gives up with a friendly error", async () => {
    const waits: number[] = [];
    const limited = () => new Response("{}", { status: 429, headers: { "retry-after": "20" } });
    const g = fakeGroq([limited, limited, completion({ content: "Finally." })]);
    const model = new GroqDmModel("k", "m", g.fetchImpl, async (ms) => void waits.push(ms));
    expect((await model.create(req)).content[0]).toMatchObject({ text: "Finally." });
    expect(waits).toEqual([20000, 20000]);

    const g2 = fakeGroq([limited, limited, limited, limited]);
    await expect(new GroqDmModel("k", "m", g2.fetchImpl, async () => {}).create(req)).rejects.toBeInstanceOf(GroqRateLimitError);
  });

  it("recovers from malformed tool calls by retrying, then narrating without tools", async () => {
    const failed = () => new Response(JSON.stringify({ error: { code: "tool_use_failed", message: "bad" } }), { status: 400 });
    const g = fakeGroq([failed, failed, completion({ content: "The story goes on." })]);
    const res = await new GroqDmModel("k", "m", g.fetchImpl, async () => {}).create(req);
    expect(res.content[0]).toMatchObject({ text: "The story goes on." });
    expect(g.calls.map((c) => c.body.tool_choice)).toEqual(["auto", "auto", "none"]);
  });

  it("explains a bad key", async () => {
    const g = fakeGroq([() => new Response("unauthorized", { status: 401 })]);
    await expect(new GroqDmModel("k", "m", g.fetchImpl, async () => {}).create(req)).rejects.toThrow(/GROQ_API_KEY/);
  });
});

describe("provider selection", () => {
  const base = { DISCORD_PUBLIC_KEY: "00".repeat(32), DISCORD_APPLICATION_ID: "1" };
  it("prefers Claude, falls back to Groq, and respects DM_PROVIDER", () => {
    expect(createDmModel(loadConfig(base))).toBeUndefined();
    expect(createDmModel(loadConfig({ ...base, GROQ_API_KEY: "g" }))?.label).toBe("Groq (llama-3.3-70b-versatile)");
    expect(createDmModel(loadConfig({ ...base, GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "a" }))?.label).toBe("Claude (claude-opus-5-5)");
    expect(createDmModel(loadConfig({ ...base, GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "a", DM_PROVIDER: "groq", GROQ_MODEL: "openai/gpt-oss-120b" }))?.label).toBe(
      "Groq (openai/gpt-oss-120b)",
    );
  });
});

describe("a DM turn on Groq", () => {
  it("runs tools and posts narration with roll buttons", async () => {
    const g = fakeGroq([
      completion(
        {
          content: null,
          tool_calls: [
            toolCall("c1", "update_story", { title: "Free Tale" }),
            toolCall("c2", "request_roll", { character: "Mira", type: "skill", name: "insight", reason: "read the innkeeper" }),
          ],
        },
        "tool_calls",
      ),
      completion({ content: "The innkeeper smiles too widely. **Mira**, roll Insight." }),
    ]);
    const env = makeDeps({ dm: new GroqDmModel("k", "llama-3.3-70b-versatile", g.fetchImpl, async () => {}), rng: fixedRng(10) });
    await run(env.deps, command(ALEX, "char", sub("create", { name: "Mira", class: "wizard" })));
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    const edit = env.discord.calls.find((c) => c.kind === "edit")!.body!;
    expect(edit.embeds![0]!.description).toContain("smiles too widely");
    expect(edit.embeds![0]!.author!.name).toContain("Free Tale");
    expect((edit.components![0] as any).components[0].label).toBe("Mira: Insight");
    // The second call carries the tool results as role "tool" messages.
    const second = g.calls[1]!.body.messages;
    expect(second.filter((m: any) => m.role === "tool").map((m: any) => m.name)).toEqual(["update_story", "request_roll"]);

    const status = await run(env.deps, command(ALEX, "dm", sub("status")));
    expect(status.data.embeds[0].footer.text).toContain("AI: Groq (llama-3.3-70b-versatile)");
  });
});
