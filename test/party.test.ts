import { describe, expect, it } from "vitest";
import type { Character } from "../src/game/character.js";
import { ALEX, SAM, ScriptedModel, command, fixedRng, makeDeps, opts, run, say, sub } from "./helpers.js";

const sheet = async (env: ReturnType<typeof makeDeps>, id: string) => (await env.deps.store.list<Character>(`char:guild1:${id}:`))[0]!.value;

async function game() {
  const env = makeDeps({ dm: new ScriptedModel([say("Opening.")]), rng: fixedRng(10) });
  await run(env.deps, command(ALEX, "char", sub("create", { name: "Mira", class: "wizard" })));
  await run(env.deps, command(SAM, "char", sub("create", { name: "Bran", class: "fighter", level: 20, ac: 40 })));
  await run(env.deps, command(ALEX, "dm", sub("start")));
  await env.flush();
  await run(env.deps, command(SAM, "dm", sub("join")));
  return env;
}

describe("DM-controlled sheets", () => {
  it("locks players out of HP, level, items and combat in a campaign", async () => {
    const env = await game();
    for (const [name, o] of [
      ["hp", sub("damage", { amount: 3 })],
      ["inv", sub("add", { item: "Rope" })],
      ["char", sub("set", { field: "level", value: "20" })],
      ["rest", opts({ type: "long" })],
      ["init", sub("monster", { name: "goblin" })],
    ] as const) {
      const res = await run(env.deps, command(SAM, name, o as unknown[]));
      expect(res.data.content, name).toContain("🔒");
    }
    expect((await run(env.deps, command(SAM, "char", sub("set", { field: "notes", value: "brave" })))).data.content).toContain("Notes updated");
    expect((await run(env.deps, command(SAM, "char", sub("create", { name: "Cheat", class: "rogue", level: 20 })))).data.content).toContain("level 1");
    expect((await run(env.deps, command(SAM, "hp", sub("show")))).data.flags).toBe(64);
  });

  it("/party lets the DM fix and reward players", async () => {
    const env = await game();
    expect((await run(env.deps, command(SAM, "party", sub("hp", { player: ALEX.id, action: "damage", amount: 1 })))).data.content).toContain("Only the Dungeon Master");
    const down = await run(env.deps, command(ALEX, "party", sub("set", { player: SAM.id, field: "level", value: "1" })));
    expect(down.data.content).toContain("Now level **1**");
    await run(env.deps, command(ALEX, "party", sub("set", { player: SAM.id, field: "ac", value: "16" })));
    let bran = await sheet(env, SAM.id);
    expect([bran.level, bran.maxHp, bran.ac]).toEqual([1, 10, 16]);
    await run(env.deps, command(ALEX, "party", sub("hp", { player: SAM.id, action: "damage", amount: 4 })));
    await run(env.deps, command(ALEX, "party", sub("give", { player: SAM.id, item: "Potion of Healing", qty: 2 })));
    await run(env.deps, command(ALEX, "party", sub("coins", { player: SAM.id, gp: 50 })));
    await run(env.deps, command(ALEX, "party", sub("condition", { player: SAM.id, condition: "Poisoned" })));
    const xp = await run(env.deps, command(ALEX, "party", sub("xp", { amount: 300 })));
    expect(xp.data.embeds[0].description).toContain("ready for level 2");
    bran = await sheet(env, SAM.id);
    expect(bran.hp).toBe(6);
    expect(bran.inventory).toEqual([{ name: "Potion of Healing", qty: 2 }]);
    expect(bran.coins.gp).toBe(50);
    expect(bran.conditions).toContain("Poisoned");
    await run(env.deps, command(ALEX, "party", sub("rest")));
    expect((await sheet(env, SAM.id)).hp).toBe(10);
  });
});
