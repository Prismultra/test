import { describe, expect, it } from "vitest";
import type { Campaign } from "../src/ai/campaign.js";
import { COMPACT_AT, compactIfNeeded } from "../src/ai/dm.js";
import type { Character } from "../src/game/character.js";
import type { Combat } from "../src/game/combat.js";
import { keys } from "../src/store/store.js";
import { ALEX, SAM, ScriptedModel, click, command, fixedRng, makeDeps, message, opts, run, say, sub, useTools } from "./helpers.js";

const DEFERRED = 5;
const MESSAGE = 4;
const UPDATE = 7;

const campaignOf = async (env: ReturnType<typeof makeDeps>) => (await env.deps.store.get<Campaign>(keys.campaign("chan1")))?.value;

async function setup(model: ScriptedModel, rng = fixedRng(15)) {
  const env = makeDeps({ dm: model, rng });
  await run(env.deps, command(ALEX, "char", sub("create", { name: "Mira", class: "wizard", dex: 14, int: 18 })));
  await run(env.deps, command(SAM, "char", sub("create", { name: "Bran", class: "fighter", str: 16 })));
  await run(env.deps, command(SAM, "char", sub("attack-add", { name: "Longsword" })));
  return env;
}

describe("AI Dungeon Master", () => {
  it("is disabled cleanly without an API key", async () => {
    const env = makeDeps();
    const res = await run(env.deps, command(ALEX, "dm", sub("start")));
    expect(res.type).toBe(MESSAGE);
    expect(res.data.content).toContain("ANTHROPIC_API_KEY");
  });

  it("opens a campaign, asks for rolls with buttons and continues after the roll", async () => {
    const model = new ScriptedModel([
      useTools(
        ["update_story", { title: "The Sunken Bell", scene: "Saltmarsh docks", quest: "Find the bell", remember: ["Harbormaster Oyelaran is nervous"] }],
        ["request_roll", { character: "Mira", type: "skill", name: "perception", dc: 12, reason: "spotting the figure in the fog" }],
      ),
      say("Fog rolls off the black water. **Mira**, something moves on the pier — roll Perception."),
    ]);
    const env = await setup(model);

    const start = await run(env.deps, command(ALEX, "dm", sub("start", { premise: "A drowned bell rings at night", tone: "mystery" })));
    expect(start.type).toBe(DEFERRED);
    await env.flush();

    // The opening narration replaced the "thinking" message, with a roll button.
    const opening = env.discord.calls.find((c) => c.kind === "edit")!.body!;
    expect(opening.embeds![0]!.description).toContain("Fog rolls off");
    expect(opening.embeds![0]!.author!.name).toContain("The Sunken Bell");
    const btn = (opening.components![0] as any).components[0];
    expect(btn.custom_id).toMatch(/^dm:roll:/);
    expect(btn.label).toBe("Mira: Perception");
    expect(opening.allowed_mentions).toEqual({ parse: [], users: [ALEX.id] });

    let campaign = (await campaignOf(env))!;
    expect(campaign.title).toBe("The Sunken Bell");
    expect(campaign.notes).toContain("Harbormaster Oyelaran is nervous");
    expect(campaign.party.map((p) => p.characterName)).toEqual(["Mira"]);
    expect(campaign.lock).toBeUndefined();
    expect(campaign.pendingRolls).toHaveLength(1);

    // The first request carries the whole state; the second appends the tool results.
    const [first, second] = model.requests;
    expect(first!.messages).toHaveLength(1);
    expect(String(first!.messages[0]!.content)).toContain("The adventure begins now");
    expect(second!.messages).toHaveLength(3);
    expect(second!.messages[0]).toEqual(first!.messages[0]);
    expect(JSON.stringify(second!.messages[2])).toContain("Requested a Perception");

    // Sam can't roll Mira's check.
    const wrong = await run(env.deps, click(SAM, btn.custom_id));
    expect(wrong.data.content).toContain("This roll is for **Mira**");

    // Alex rolls; the button updates in place, then the story continues.
    model.push(say("A hooded **stranger** stands at the end of the pier, dripping seawater."));
    const clicked = await run(env.deps, click(ALEX, btn.custom_id));
    expect(clicked.type).toBe(UPDATE);
    expect(clicked.data.components[0].components[0].disabled).toBe(true);
    expect(clicked.data.components[0].components[0].label).toBe("Mira: Perception → 15");
    await env.flush();

    const followups = env.discord.calls.filter((c) => c.kind === "followup").map((c) => c.body!);
    expect(followups[0]!.embeds![0]!.title).toContain("Mira — Perception");
    expect(followups[0]!.embeds![0]!.description).toContain("Success");
    expect(followups[1]!.embeds![0]!.description).toContain("hooded **stranger**");
    const rollTurn = model.requests[2]!;
    expect(String(rollTurn.messages[0]!.content)).toContain("Mira — Perception (spotting the figure in the fog): 15 (natural 15) vs DC 12 → success");

    // Clicking again is rejected.
    const again = await run(env.deps, click(ALEX, btn.custom_id));
    expect(again.data.content).toContain("isn't needed anymore");
    campaign = (await campaignOf(env))!;
    expect(campaign.turns).toBe(2);
    expect(campaign.transcript.map((e) => e.kind)).toEqual(["event", "dm", "roll", "dm"]);
  });

  it("auto-joins on /act, queues actions while busy, and runs combat tools", async () => {
    const model = new ScriptedModel([say("The tavern door bangs open.")]);
    const env = await setup(model);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();

    // While a turn is running, other actions queue up and run right after it.
    const store = env.deps.store;
    const c = (await store.get<Campaign>(keys.campaign("chan1")))!;
    await store.put(keys.campaign("chan1"), { ...c.value, lock: { id: "someone-else", since: new Date("2026-10-30T11:59:00Z").toISOString() } }, c.version);
    const queued = await run(env.deps, command(SAM, "act", opts({ action: "I draw my sword and step in front of Mira" })));
    expect(queued.type).toBe(MESSAGE);
    expect(queued.data.content).toContain("queued (#1)");
    let campaign = (await campaignOf(env))!;
    expect(campaign.party.map((p) => p.characterName).sort()).toEqual(["Bran", "Mira"]);

    // Release the fake lock; Alex's action picks up Sam's queued one in the same turn.
    const c2 = (await store.get<Campaign>(keys.campaign("chan1")))!;
    const { lock: _lock, ...rest } = c2.value;
    await store.put(keys.campaign("chan1"), rest, c2.version);

    model.push(
      useTools(["start_combat", { enemies: [{ name: "Goblin", srd_monster: "goblin", count: 2 }] }]),
      useTools(
        ["roll_dice", { expression: "1d20+4", reason: "Goblin A attacks Bran" }],
        ["update_character", { character: "Bran", hp_change: -5 }],
        ["update_combatant", { name: "Goblin A", damage: 3 }],
        ["request_roll", { character: "Bran", type: "attack", name: "longsword", dc: 15, reason: "strike back" }],
        ["lookup_rules", { kind: "monster", name: "goblin" }],
        ["request_roll", { character: "Nobody", type: "skill", name: "stealth", reason: "x" }],
      ),
      say("Two goblins leap from behind the bar! One slashes at **Bran**. Bran, strike back!"),
    );
    const act = await run(env.deps, command(ALEX, "act", opts({ action: "I duck behind the bar" })));
    expect(act.type).toBe(DEFERRED);
    await env.flush();

    const turnRequest = model.requests[1]!;
    const context = String(turnRequest.messages[0]!.content);
    expect(context).toContain("Sam as Bran: I draw my sword");
    expect(context).toContain("Alex as Mira: I duck behind the bar");
    const toolResults = JSON.stringify(model.requests[3]!.messages[4]);
    expect(toolResults).toContain("Goblin A attacks Bran: 19");
    expect(toolResults).toContain("Nimble Escape"); // the goblin stat block
    expect(toolResults).toContain('No party member called \\"Nobody\\"');

    const bran = (await store.list<Character>("char:guild1:222:"))[0]!.value;
    expect(bran.hp).toBe(bran.maxHp - 5);
    const combat = (await store.get<Combat>(keys.combat("chan1")))!.value;
    expect(combat.combatants.map((x) => x.name)).toEqual(expect.arrayContaining(["Mira", "Bran", "Goblin A", "Goblin B"]));
    expect(combat.combatants.find((x) => x.name === "Bran")!.hp).toBe(bran.hp);

    const edit = env.discord.calls.filter((c) => c.kind === "edit").pop()!.body!;
    expect(edit.content).toContain("**Bran**: I draw my sword");
    expect(edit.embeds![0]!.fields![0]!.value).toContain("Goblin A attacks Bran");
    // The tracker is posted as a follow-up with its buttons.
    const tracker = env.discord.calls.filter((c) => c.kind === "followup").pop()!.body!;
    expect(tracker.embeds![0]!.title).toContain("Combat");

    // Bran's attack roll: natural 15 + 5 = 20 vs AC 15 hits, damage included for the DM.
    campaign = (await campaignOf(env))!;
    const attackRoll = campaign.pendingRolls[0]!;
    expect(attackRoll.label).toBe("Longsword attack");
    model.push(say("Bran's blade bites deep."));
    await run(env.deps, click(SAM, `dm:roll:${attackRoll.id}`));
    await env.flush();
    expect(String(model.requests.at(-1)!.messages[0]!.content)).toMatch(/Longsword attack \(strike back\): 20 to hit \(natural 15\) vs AC 15 → hit for \d+ damage/);
  });

  it("handles refusals and stays usable", async () => {
    const model = new ScriptedModel([() => message([], "refusal")]);
    const env = await setup(model);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    const edit = env.discord.calls.find((c) => c.kind === "edit")!.body!;
    expect(edit.embeds![0]!.description).toContain("not a scene I can run");
    expect((await campaignOf(env))!.lock).toBeUndefined();
  });

  it("releases the lock when the model call fails", async () => {
    const model = new ScriptedModel([]);
    const env = await setup(model);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    const calls = env.discord.calls.map((c) => c.kind);
    expect(calls).toEqual(["delete", "followup"]);
    expect(env.discord.calls[1]!.body!.content).toContain("Something went wrong");
    expect((await campaignOf(env))!.lock).toBeUndefined();
  });

  it("answers out-of-character questions without changing the story", async () => {
    const model = new ScriptedModel([say("The tavern is quiet."), say("Yes — Shield is a reaction you can cast when hit.")]);
    const env = await setup(model);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    const before = (await campaignOf(env))!.transcript.length;
    const res = await run(env.deps, command(ALEX, "dm", sub("ask", { question: "Can I cast Shield when I get hit?" })));
    expect(res.type).toBe(DEFERRED);
    await env.flush();
    const edit = env.discord.calls.filter((c) => c.kind === "edit").pop()!.body!;
    expect(edit.embeds![0]!.description).toContain("Shield is a reaction");
    expect((await campaignOf(env))!.transcript.length).toBe(before);
    expect(model.requests[1]!.tools).toBeUndefined();
  });

  it("folds old transcript into the summary", async () => {
    const model = new ScriptedModel([say("Opening."), say("The party crossed the marsh and met a hag.")]);
    const env = await setup(model);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    const c = (await env.deps.store.get<Campaign>(keys.campaign("chan1")))!;
    const filler = Array.from({ length: COMPACT_AT }, (_, i) => ({ id: `f${i}`, kind: "dm" as const, text: `Beat ${i}`, at: "x" }));
    await env.deps.store.put(keys.campaign("chan1"), { ...c.value, transcript: filler }, c.version);
    const did = await compactIfNeeded({ store: env.deps.store, model, now: () => new Date() }, "chan1");
    expect(did).toBe(true);
    const after = (await campaignOf(env))!;
    expect(after.summary).toBe("The party crossed the marsh and met a hag.");
    expect(after.transcript.length).toBe(14);
    expect(after.transcript[0]!.text).toBe(`Beat ${COMPACT_AT - 14}`);
  });

  it("only lets the creator end a campaign", async () => {
    const model = new ScriptedModel([say("Opening.")]);
    const env = await setup(model);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    const denied = await run(env.deps, command(SAM, "dm", sub("end", { confirm: true })));
    expect(denied.data.content).toContain("Only the person who started");
    const status = await run(env.deps, command(SAM, "dm", sub("status")));
    expect(status.data.embeds[0].fields[0].value).toContain("Mira");
    const ended = await run(env.deps, command(ALEX, "dm", sub("end", { confirm: true })));
    expect(ended.data.embeds[0].title).toContain("The End");
    expect(await campaignOf(env)).toBeUndefined();
  });
});
