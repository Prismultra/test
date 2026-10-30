// Regression tests for issues found in code review.
import { describe, expect, it } from "vitest";
import type { Campaign } from "../src/ai/campaign.js";
import type { Character } from "../src/game/character.js";
import type { Combat } from "../src/game/combat.js";
import { MAX_COMBATANTS } from "../src/game/combat.js";
import { embed } from "../src/discord/ui.js";
import { keys } from "../src/store/store.js";
import { ALEX, SAM, ScriptedModel, click, command, fixedRng, makeDeps, opts, run, say, sub, useTools } from "./helpers.js";

const campaignOf = async (env: ReturnType<typeof makeDeps>) => (await env.deps.store.get<Campaign>(keys.campaign("chan1")))?.value;
const chars = async (env: ReturnType<typeof makeDeps>, user = ALEX) =>
  (await env.deps.store.list<Character>(`char:guild1:${user.id}:`)).map((e) => e.value);

describe("character names in any script", () => {
  it("switches to and deletes the right character", async () => {
    const env = makeDeps();
    await run(env.deps, command(ALEX, "char", sub("create", { name: "Иван", class: "fighter" })));
    await run(env.deps, command(ALEX, "char", sub("create", { name: "Ольга", class: "wizard" })));
    const use = await run(env.deps, command(ALEX, "char", sub("use", { name: "Иван" })));
    expect(use.data.content).toContain("Иван");
    const del = await run(env.deps, command(ALEX, "char", sub("delete", { name: "Ольга", confirm: true })));
    expect(del.data.content).toContain("Ольга");
    expect((await chars(env)).map((c) => c.name)).toEqual(["Иван"]);
    const none = await run(env.deps, command(ALEX, "char", sub("use", { name: "さくら" })));
    expect(none.data.content).toContain("don't have a character");
  });

  it("autocompletes characters by id", async () => {
    const env = makeDeps();
    await run(env.deps, command(ALEX, "char", sub("create", { name: "Иван", class: "fighter" })));
    const [c] = await chars(env);
    const res = await run(env.deps, {
      ...command(ALEX, "char", [{ type: 1, name: "use", options: [{ type: 3, name: "name", value: "", focused: true }] }]),
      type: 4,
    } as any);
    expect(res.data.choices[0].value).toBe(c!.id);
  });
});

describe("campaign turns", () => {
  async function setup(model: ScriptedModel) {
    const env = makeDeps({ dm: model, rng: fixedRng(15) });
    await run(env.deps, command(ALEX, "char", sub("create", { name: "Mira", class: "wizard" })));
    await run(env.deps, command(SAM, "char", sub("create", { name: "Bran", class: "fighter" })));
    return env;
  }

  it("drops a turn whose campaign was ended and replaced meanwhile", async () => {
    const model = new ScriptedModel([say("Opening.")]);
    const env = await setup(model);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    const oldId = (await campaignOf(env))!.id;

    model.push(
      async () => {
        // While the DM is thinking, the campaign is ended and a new one started.
        await run(env.deps, command(ALEX, "dm", sub("end", { confirm: true })));
        await run(env.deps, command(ALEX, "dm", sub("start", { premise: "A new tale" })));
        return useTools(["update_story", { title: "Old Title", remember: ["old fact"] }])();
      },
      // One of these is the new campaign's opening, the other the old turn's narration.
      say("Narration."),
      say("Narration."),
    );
    await run(env.deps, command(ALEX, "act", opts({ action: "I look around" })));
    await env.flush();

    const c = (await campaignOf(env))!;
    expect(c.id).not.toBe(oldId);
    expect(c.premise).toBe("A new tale");
    expect(c.title).toBeUndefined();
    expect(c.notes).toEqual([]);
    expect(c.transcript.map((e) => e.kind)).toEqual(["event", "dm"]);
    expect(c.lock).toBeUndefined();
    expect(env.discord.text()).toContain("campaign changed while the DM was thinking");
  });

  it("releases the lock even if Discord rejects the narration", async () => {
    const model = new ScriptedModel([say("Opening.")]);
    const env = await setup(model);
    env.discord.editOriginal = async () => {
      throw new Error("Discord PATCH /webhooks/app failed: 404");
    };
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush().catch(() => undefined);
    expect((await campaignOf(env))!.lock).toBeUndefined();
  });

  it("keeps roll results when a player acts before everyone rolled", async () => {
    const model = new ScriptedModel([say("Opening.")]);
    const env = await setup(model);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    await run(env.deps, command(SAM, "dm", sub("join")));
    model.push(
      useTools(
        ["request_roll", { character: "Mira", type: "skill", name: "perception", reason: "look" }],
        ["request_roll", { character: "Bran", type: "skill", name: "athletics", reason: "climb" }],
      ),
      say("Roll, both of you."),
    );
    await run(env.deps, command(ALEX, "act", opts({ action: "We approach the wall" })));
    await env.flush();
    const rolls = (await campaignOf(env))!.pendingRolls;
    expect(rolls.map((r) => r.characterName)).toEqual(["Mira", "Bran"]);
    await run(env.deps, click(ALEX, `dm:roll:${rolls[0]!.id}`)); // batch not done yet: no DM turn
    await env.flush();
    expect(model.requests).toHaveLength(3);

    model.push(say("Bran skips the climb."));
    await run(env.deps, command(SAM, "act", opts({ action: "I skip the climb and wait" })));
    await env.flush();
    const prompt = String(model.requests.at(-1)!.messages[0]!.content);
    expect(prompt).toContain("Mira — Perception (look): 15");
    expect(prompt).toContain("weren't made");
    expect(prompt).toContain("Bran: Athletics");
    const c = (await campaignOf(env))!;
    expect(c.transcript.some((e) => e.kind === "roll" && e.text.includes("Perception"))).toBe(true);
    expect(c.pendingRolls).toEqual([]);
  });

  it("carries a roll made while a turn was running into the next turn", async () => {
    const model = new ScriptedModel([
      useTools(["request_roll", { character: "Mira", type: "skill", name: "stealth", reason: "sneak" }]),
      say("Mira, roll Stealth."),
    ]);
    const env = await setup(model);
    await run(env.deps, command(ALEX, "dm", sub("start")));
    await env.flush();
    const [stealth] = (await campaignOf(env))!.pendingRolls;

    model.push(
      async () => {
        // Mira clicks her button while Sam's turn is being generated.
        await run(env.deps, click(ALEX, `dm:roll:${stealth!.id}`));
        return say("Bran waits.")();
      },
      say("Mira slips past the guard."),
    );
    await run(env.deps, command(SAM, "act", opts({ action: "I wait" })));
    await env.flush();
    const last = String(model.requests.at(-1)!.messages[0]!.content);
    expect(last).toContain("Mira — Stealth (sneak): 15 (natural 15)");
    expect((await campaignOf(env))!.lock).toBeUndefined();
  });
});

describe("rules fixes", () => {
  it("keeps the tracker in sync with temp HP", async () => {
    const env = makeDeps({ rng: fixedRng(10) });
    await run(env.deps, command(ALEX, "char", sub("create", { name: "Bran", class: "fighter", hp: 20 })));
    await run(env.deps, command(ALEX, "hp", sub("temp", { amount: 10 })));
    await run(env.deps, command(ALEX, "init", sub("start")));
    await run(env.deps, command(ALEX, "init", sub("join")));
    const res = await run(env.deps, command(ALEX, "init", sub("damage", { target: "Bran", amount: 15 })));
    expect(res.data.embeds[0].description).toContain("10 absorbed by temp HP");
    const [bran] = await chars(env);
    const combat = (await env.deps.store.get<Combat>(keys.combat("chan1")))!.value;
    expect(bran!.hp).toBe(15);
    expect(combat.combatants[0]!.hp).toBe(15);
  });

  it("doesn't cast leveled spells for free", async () => {
    const env = makeDeps();
    await run(env.deps, command(ALEX, "char", sub("create", { name: "Mira", class: "wizard", level: 5 })));
    const res = await run(env.deps, command(ALEX, "spell", sub("cast", { level: 0, name: "Fireball" })));
    expect(res.data.content).toContain("needs a spell slot");
  });

  it("clears spellcasting when switching to a homebrew class", async () => {
    const env = makeDeps();
    await run(env.deps, command(ALEX, "char", sub("create", { name: "Hex", class: "warlock", level: 5 })));
    await run(env.deps, command(ALEX, "char", sub("set", { field: "class", value: "Gunslinger" })));
    const [c] = await chars(env);
    expect(c!.pact).toBeUndefined();
    expect(c!.spellSlotsMax.every((n) => n === 0)).toBe(true);
    await run(env.deps, command(ALEX, "char", sub("set", { field: "class", value: "fighter" })));
    expect((await chars(env))[0]!.pact).toBeUndefined();
  });

  it("handles Stable and dead characters", async () => {
    const env = makeDeps({ rng: fixedRng(12) });
    await run(env.deps, command(ALEX, "char", sub("create", { name: "Bran", class: "fighter", hp: 20 })));
    await run(env.deps, command(ALEX, "hp", sub("set", { amount: 0 })));
    for (let i = 0; i < 3; i++) await run(env.deps, command(ALEX, "deathsave"));
    expect((await chars(env))[0]!.conditions).toContain("Stable");
    const again = await run(env.deps, command(ALEX, "deathsave"));
    expect(again.data.content).toContain("stable");
    await run(env.deps, command(ALEX, "hp", sub("damage", { amount: 1 })));
    expect((await chars(env))[0]!.conditions).not.toContain("Stable");
    await run(env.deps, command(ALEX, "hp", sub("heal", { amount: 5 })));
    const healed = (await chars(env))[0]!;
    expect(healed.conditions).not.toContain("Stable");
    expect(healed.conditions).not.toContain("Unconscious");
  });

  it("rejects odd field names and full combats cleanly", async () => {
    const env = makeDeps({ rng: fixedRng(10) });
    await run(env.deps, command(ALEX, "char", sub("create", { name: "Bran", class: "fighter" })));
    for (const field of ["constructor", "__proto__", "toString"]) {
      const res = await run(env.deps, command(ALEX, "char", sub("set", { field, value: "x" })));
      expect(res.data.content).toContain("Unknown field");
    }
    await run(env.deps, command(ALEX, "init", sub("start")));
    for (let i = 0; i < MAX_COMBATANTS / 20; i++) await run(env.deps, command(ALEX, "init", sub("add", { name: `Orc${i}`, count: 20 })));
    const full = await run(env.deps, command(ALEX, "init", sub("monster", { name: "goblin" })));
    expect(full.data.content).toContain(`at most ${MAX_COMBATANTS}`);
    const bad = await run(env.deps, command(ALEX, "char", sub("set", { field: "portrait", value: "https://not a url" })));
    expect(bad.data.content).toContain("image link");
  });

  it("never builds an embed over 6000 characters", () => {
    const big = "x".repeat(5000);
    const e = embed({ title: big, description: big, footer: big, fields: Array.from({ length: 25 }, () => ({ name: big, value: big })) });
    const total = [e.title, e.description, e.footer?.text, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])].join("").length;
    expect(total).toBeLessThanOrEqual(6000);
  });
});
