import { describe, expect, it } from "vitest";
import type { Campaign } from "../src/ai/campaign.js";
import { GroqDmModel } from "../src/ai/groq.js";
import { AiQuotaError } from "../src/ai/model.js";
import type { Rng } from "../src/game/dice.js";
import { keys } from "../src/store/store.js";
import { ALEX, SAM, ScriptedModel, click, command, fixedRng, makeDeps, opts, run, say, sub, type User } from "./helpers.js";

const DEFERRED = 5;
const UPDATE = 7;
const EPHEMERAL = 64;
const KAI: User = { id: "333", name: "Kai" };

const campaignOf = async (env: ReturnType<typeof makeDeps>) => (await env.deps.store.get<Campaign>(keys.campaign("chan1")))!.value;
const outOfQuota = () => {
  throw new AiQuotaError("The free AI Dungeon Master (Groq) has used up today's limit.");
};

async function party(env: ReturnType<typeof makeDeps>, users: User[]) {
  for (const [i, u] of users.entries()) {
    await run(env.deps, command(u, "char", sub("create", { name: ["Mira", "Bran", "Zed"][i]!, class: ["wizard", "fighter", "rogue"][i]! })));
  }
}

describe("voting for a human DM", () => {
  it("starts a vote when the AI runs out, saves the action, and elects by majority", async () => {
    const model = new ScriptedModel([say("Opening.")]);
    const env = makeDeps({ dm: model, rng: fixedRng(10) });
    await party(env, [ALEX, SAM, KAI]);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    await run(env.deps, command(SAM, "dm", sub("join")));
    await run(env.deps, command(KAI, "dm", sub("join")));

    model.push(outOfQuota);
    const act = await run(env.deps, command(ALEX, "act", opts({ action: "I pick the lock" })));
    expect(act.type).toBe(DEFERRED);
    await env.flush();
    const voteMsg = env.discord.calls.filter((c) => c.kind === "edit").pop()!.body!;
    expect(voteMsg.content).toContain("used up today's limit");
    expect(voteMsg.embeds![0]!.title).toContain("Who should be the Dungeon Master");
    const buttons = (voteMsg.components as any[]).flatMap((r) => r.components);
    expect(buttons.map((b) => b.label)).toEqual(["Alex", "Sam", "Kai", "Close vote now"]);
    let c = await campaignOf(env);
    expect(c.lock).toBeUndefined();
    expect(c.transcript.some((e) => e.kind === "player" && e.text === "I pick the lock")).toBe(true);

    // While voting, actions are saved for whoever wins.
    const waiting = await run(env.deps, command(SAM, "act", opts({ action: "I keep watch" })));
    expect(waiting.data.content).toContain("voting for a DM");

    const voteFor = (who: User) => `vote:${c.vote!.id}:${who.id}`;
    const outsider: User = { id: "999", name: "Lurker" };
    expect((await run(env.deps, click(outsider, voteFor(SAM)))).data.content).toContain("Only party members");

    const first = await run(env.deps, click(ALEX, voteFor(SAM)));
    expect(first.type).toBe(UPDATE);
    expect(first.data.embeds[0].description).toContain("**Sam** (Bran) — 1 vote");
    const second = await run(env.deps, click(KAI, voteFor(SAM)));
    expect(second.data.embeds[0].title).toContain("Sam runs the game");
    expect(second.data.components).toEqual([]);
    await env.flush();
    expect(env.discord.text()).toContain("the party chose you as Dungeon Master");

    c = await campaignOf(env);
    expect(c.mode).toBe("human");
    expect(c.humanDm?.userId).toBe(SAM.id);
    expect(c.vote).toBeUndefined();
  });

  it("settles ties with a d20 roll-off", async () => {
    const faces = [5, 18];
    const rng: Rng = () => faces.shift() ?? 10;
    const env = makeDeps({ dm: new ScriptedModel([say("Opening.")]), rng });
    await party(env, [ALEX, SAM]);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    await run(env.deps, command(SAM, "dm", sub("join")));
    await run(env.deps, command(ALEX, "dm", sub("vote")));
    const id = (await campaignOf(env)).vote!.id;
    await run(env.deps, click(ALEX, `vote:${id}:${ALEX.id}`));
    const done = await run(env.deps, click(SAM, `vote:${id}:${SAM.id}`));
    expect(done.data.content).toContain("Tie! Roll-off: Alex 🎲5 · Sam 🎲18");
    expect((await campaignOf(env)).humanDm?.userId).toBe(SAM.id);
  });

  it("makes a solo player the DM straight away", async () => {
    const model = new ScriptedModel([say("Opening."), outOfQuota]);
    const env = makeDeps({ dm: model });
    await party(env, [ALEX]);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    await run(env.deps, command(ALEX, "act", opts({ action: "I wait" })));
    await env.flush();
    expect(env.discord.calls.filter((c) => c.kind === "edit").pop()!.body!.embeds![0]!.title).toContain("Alex runs the game");
  });
});

describe("the human DM's tools", () => {
  async function humanGame() {
    const env = makeDeps({ dm: new ScriptedModel([say("Opening.")]), rng: fixedRng(10) });
    await party(env, [ALEX, SAM]);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    await run(env.deps, command(SAM, "dm", sub("join")));
    await run(env.deps, command(SAM, "init", sub("start")));
    await run(env.deps, command(SAM, "init", sub("join")));
    await run(env.deps, command(ALEX, "init", sub("monster", { name: "goblin", count: 2 })));
    await run(env.deps, command(ALEX, "dm", sub("vote")));
    const id = (await campaignOf(env)).vote!.id;
    await run(env.deps, click(ALEX, `vote:${id}:${ALEX.id}`));
    await run(env.deps, click(SAM, `vote:${id}:${ALEX.id}`));
    expect((await campaignOf(env)).humanDm?.userId).toBe(ALEX.id);
    return env;
  }

  it("/group-status shows the DM everything, privately", async () => {
    const env = await humanGame();
    await env.flush();
    const before = env.discord.calls.length;
    const res = await run(env.deps, command(ALEX, "group-status"));
    expect(res.data.flags).toBe(EPHEMERAL);
    const overview = JSON.stringify(res.data.embeds[0]);
    expect(overview).toContain("DM view");
    expect(overview).toContain("Bran — Sam");
    expect(overview).toContain("AC **10**");
    await env.flush();
    const extra = env.discord.calls.slice(before).filter((c) => c.kind === "followup").map((c) => c.body!);
    expect(extra.every((b) => b.flags === EPHEMERAL)).toBe(true);
    const text = JSON.stringify(extra);
    expect(text).toContain("Story so far");
    expect(text).toContain("Goblin A");
    expect(text).toMatch(/Goblin A · \d+\/\d+ HP · AC 15/); // exact monster HP and AC for the DM

    const denied = await run(env.deps, command(SAM, "group-status"));
    expect(denied.data.content).toContain("Only the Dungeon Master");
  });

  it("routes /act to the DM and saves /narrate to the story", async () => {
    const env = await humanGame();
    const act = await run(env.deps, command(SAM, "act", opts({ action: "I charge the goblins" })));
    expect(act.data.content).toContain(`<@${ALEX.id}>, your call`);
    expect(act.data.allowed_mentions).toEqual({ parse: [], users: [ALEX.id] });

    const notDm = await run(env.deps, command(SAM, "narrate", opts({ text: "I win" })));
    expect(notDm.data.content).toContain("Only the Dungeon Master");
    const told = await run(env.deps, command(ALEX, "narrate", opts({ text: "The goblins scatter!", scene: "The old mill", ping: true })));
    expect(told.data.embeds[0].description).toBe("The goblins scatter!");
    expect(told.data.content).toBe(`<@${SAM.id}>`);
    const c = await campaignOf(env);
    expect(c.scene).toBe("The old mill");
    expect(c.transcript.at(-1)).toMatchObject({ kind: "dm", text: "The goblins scatter!" });

    const ask = await run(env.deps, command(SAM, "dm", sub("ask", { question: "Can I dash?" })));
    expect(ask.data.content).toContain("Ask your Dungeon Master");
  });

  it("/request-roll gives the player a button that uses their sheet", async () => {
    const env = await humanGame();
    await run(env.deps, command(SAM, "char", sub("prof", { name: "athletics" })));
    const ask = await run(env.deps, command(ALEX, "request-roll", opts({ player: SAM.id, check: "athletics", dc: 12, reason: "Climb the mill wall" })));
    expect(ask.data.content).toContain(`<@${SAM.id}>, roll **Athletics** for **Bran**`);
    expect(ask.data.content).toContain("Climb the mill wall");
    expect(ask.data.allowed_mentions.users).toEqual([SAM.id]);
    const btn = ask.data.components[0].components[0];
    expect(btn.custom_id).toMatch(/^dm:roll:/);

    expect((await run(env.deps, command(SAM, "request-roll", opts({ player: ALEX.id, check: "stealth" })))).data.content).toContain(
      "Only the Dungeon Master",
    );
    expect((await run(env.deps, click({ id: "999", name: "Lurker" }, btn.custom_id))).data.content).toContain("This roll is for **Bran**");

    const before = env.discord.calls.length;
    const rolled = await run(env.deps, click(SAM, btn.custom_id));
    expect(rolled.type).toBe(UPDATE);
    // fixedRng(10): d20 10 + Athletics (STR 10, proficient +2) = 12 vs DC 12
    expect(rolled.data.components[0].components[0].label).toBe("Bran: Athletics → 12");
    await env.flush();
    const result = env.discord.calls.slice(before).find((c) => c.kind === "followup")!.body!;
    expect(result.embeds![0]!.description).toContain("Success");
    // No AI turn while a human runs the game.
    expect((env.deps.dm as ScriptedModel).requests).toHaveLength(1);
    const status = await run(env.deps, command(ALEX, "group-status"));
    await env.flush();
    expect(env.discord.text()).toContain("Bran — Athletics (Climb the mill wall): 12");
    expect(status.data.flags).toBe(EPHEMERAL);
  });

  it("autocompletes checks, including the chosen player's attacks", async () => {
    const env = await humanGame();
    await run(env.deps, command(SAM, "char", sub("attack-add", { name: "Longsword" })));
    const res = await run(env.deps, {
      ...command(ALEX, "request-roll", [
        { type: 6, name: "player", value: SAM.id },
        { type: 3, name: "check", value: "long", focused: true },
      ]),
      type: 4,
    } as any);
    expect(res.data.choices[0]).toEqual({ name: "Longsword attack (+2)", value: "attack:Longsword" });
  });

  it("hands back to the AI, which picks up the story", async () => {
    const env = await humanGame();
    const model = env.deps.dm as ScriptedModel;
    await run(env.deps, command(ALEX, "narrate", opts({ text: "A dragon lands on the mill roof." })));
    expect((await run(env.deps, command(SAM, "dm", sub("ai")))).data.content).toContain("Only the current Dungeon Master");
    expect((await run(env.deps, command(ALEX, "dm", sub("ai")))).data.content).toContain("AI Dungeon Master is back");
    model.push(say("The dragon roars."));
    await run(env.deps, command(SAM, "act", opts({ action: "I hide" })));
    await env.flush();
    expect(String(model.requests.at(-1)!.messages[0]!.content)).toContain("A dragon lands on the mill roof.");
    expect((await campaignOf(env)).mode).toBe("ai");
  });
});

describe("Groq daily limit", () => {
  it("is reported as the AI being out for the day", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: "Rate limit reached ... on tokens per day (TPD): Limit 200000, Used 199999" } }), {
        status: 429,
        headers: { "retry-after": "3600" },
      })) as unknown as typeof fetch;
    const model = new GroqDmModel("k", "openai/gpt-oss-120b", fetchImpl, async () => {});
    await expect(model.create({ system: [], messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(AiQuotaError);
  });
});
