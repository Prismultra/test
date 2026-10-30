import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/app.js";
import { COMMANDS } from "../src/commands/definitions.js";
import type { Character } from "../src/game/character.js";
import type { Combat } from "../src/game/combat.js";
import { keys } from "../src/store/store.js";
import { MemoryStore } from "../src/store/memory.js";
import { ALEX, SAM, autocomplete, click, command, fixedRng, keypair, makeDeps, opts, run, sub } from "./helpers.js";

const MESSAGE = 4;
const DEFERRED = 5;
const UPDATE = 7;
const AUTOCOMPLETE = 8;
const EPHEMERAL = 64;

async function createMira(deps: ReturnType<typeof makeDeps>["deps"], user = ALEX, extra: Record<string, string | number> = {}) {
  return run(
    deps,
    command(user, "char", sub("create", { name: "Mira", class: "wizard", species: "Elf", level: 5, dex: 14, con: 12, int: 18, ...extra })),
  );
}

describe("HTTP endpoint", () => {
  it("verifies signatures and answers pings", async () => {
    const kp = keypair();
    const { deps } = makeDeps();
    deps.config.discordPublicKey = kp.publicHex;
    const body = JSON.stringify({ type: 1 });
    const ts = "1700000000";
    const ok = await handleRequest(
      new Request("https://x/api/interactions", {
        method: "POST",
        body,
        headers: { "x-signature-ed25519": kp.sign(ts, body), "x-signature-timestamp": ts },
      }),
      deps,
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ type: 1 });

    const bad = await handleRequest(
      new Request("https://x/api/interactions", {
        method: "POST",
        body,
        headers: { "x-signature-ed25519": kp.sign(ts, `${body} `), "x-signature-timestamp": ts },
      }),
      deps,
    );
    expect(bad.status).toBe(401);
    const get = await handleRequest(new Request("https://x/api/interactions"), deps);
    expect(get.status).toBe(200);
  });
});

describe("command definitions", () => {
  it("are valid for Discord", () => {
    const names = new Set<string>();
    const check = (o: any, path: string) => {
      expect(o.name, path).toMatch(/^[-_a-z0-9]{1,32}$/);
      expect(o.description.length, `${path} description`).toBeGreaterThan(0);
      expect(o.description.length, `${path} description`).toBeLessThanOrEqual(100);
      const children = o.options ?? [];
      expect(children.length, path).toBeLessThanOrEqual(25);
      let seenOptional = false;
      for (const child of children) {
        if (child.type > 2) {
          if (child.required) expect(seenOptional, `${path}.${child.name}: required after optional`).toBe(false);
          else seenOptional = true;
        }
        check(child, `${path}.${child.name}`);
      }
    };
    for (const c of COMMANDS) {
      expect(names.has(c.name)).toBe(false);
      names.add(c.name);
      check(c, c.name);
    }
    expect(JSON.stringify(COMMANDS).length).toBeLessThan(8000 * COMMANDS.length);
  });
});

describe("dice", () => {
  it("rolls with /roll", async () => {
    const { deps } = makeDeps({ rng: fixedRng(4) });
    const res = await run(deps, command(ALEX, "roll", opts({ dice: "2d6+3", reason: "Fireball? no" })));
    expect(res.type).toBe(MESSAGE);
    expect(res.data.embeds[0].description).toContain("= **11**");
    expect(res.data.allowed_mentions).toEqual({ parse: [] });
  });

  it("supports repeat and private rolls", async () => {
    const { deps } = makeDeps({ rng: fixedRng(5) });
    const res = await run(deps, command(ALEX, "roll", opts({ dice: "4d6dl1", repeat: 6, private: true })));
    expect(res.data.flags).toBe(EPHEMERAL);
    expect(res.data.embeds[0].description).toContain("Sum **90**");
  });

  it("explains bad dice", async () => {
    const { deps } = makeDeps();
    const res = await run(deps, command(ALEX, "roll", opts({ dice: "banana" })));
    expect(res.data.flags).toBe(EPHEMERAL);
    expect(res.data.content).toContain("❌");
  });
});

describe("characters", () => {
  it("creates, shows and edits a character", async () => {
    const { deps } = makeDeps({ rng: fixedRng(10) });
    const created = await createMira(deps);
    expect(created.data.embeds[0].title).toBe("Mira");
    expect(created.data.content).toContain("active character");

    await run(deps, command(ALEX, "char", sub("prof", { name: "arcana", type: "expertise" })));
    await run(deps, command(ALEX, "char", sub("set", { field: "ac", value: "15" })));
    const sheet = await run(deps, command(ALEX, "char", sub("sheet")));
    const text = JSON.stringify(sheet.data.embeds[0]);
    expect(text).toContain("Arcana +10 ★");
    expect(text).toContain('"value":"15"');
    expect(text).toContain("Save DC **15**");

    const check = await run(deps, command(ALEX, "check", opts({ skill: "arcana", dc: 20 })));
    expect(check.data.embeds[0].description).toContain("= **20**");
    expect(check.data.embeds[0].description).toContain("Success");

    const bad = await run(deps, command(ALEX, "char", sub("set", { field: "level", value: "99" })));
    expect(bad.data.content).toContain("between 1 and 20");
  });

  it("keeps characters per user and supports switching", async () => {
    const { deps } = makeDeps();
    await createMira(deps);
    await run(deps, command(ALEX, "char", sub("create", { name: "Bran", class: "fighter" })));
    const list = await run(deps, command(ALEX, "char", sub("list")));
    expect(list.data.embeds[0].description).toMatch(/▶️ \*\*Bran\*\*/);
    await run(deps, command(ALEX, "char", sub("use", { name: "mira" })));
    const sheet = await run(deps, command(ALEX, "char", sub("sheet")));
    expect(sheet.data.embeds[0].title).toBe("Mira");
    const other = await run(deps, command(SAM, "char", sub("sheet")));
    expect(other.data.content).toContain("/char create");
    const dup = await createMira(deps);
    expect(dup.data.content).toContain("already have");
  });

  it("adds SRD weapons automatically and attacks", async () => {
    const { deps } = makeDeps({ rng: fixedRng(20) });
    await run(deps, command(ALEX, "char", sub("create", { name: "Bran", class: "fighter", str: 16, dex: 12 })));
    const added = await run(deps, command(ALEX, "char", sub("attack-add", { name: "Longsword" })));
    expect(added.data.content).toContain("+5, 1d8+3 slashing");
    const atk = await run(deps, command(ALEX, "attack", opts({ name: "longsword" })));
    const desc = atk.data.embeds[0].description;
    expect(desc).toContain("Natural 20");
    expect(desc).toContain("critical");
    expect(desc).toContain("2d8 + 3");
  });

  it("tracks HP, rests, slots and inventory", async () => {
    const { deps } = makeDeps({ rng: fixedRng(3) });
    await createMira(deps);
    const hit = await run(deps, command(ALEX, "hp", sub("damage", { amount: 100 })));
    expect(hit.data.embeds[0].description).toContain("Massive damage");
    await run(deps, command(ALEX, "hp", sub("set", { amount: 0 })));
    const save = await run(deps, command(ALEX, "deathsave"));
    expect(save.data.embeds[0].description).toContain("Failure");
    await run(deps, command(ALEX, "rest", opts({ type: "long" })));
    const cast = await run(deps, command(ALEX, "spell", sub("cast", { level: 3, name: "Fireball" })));
    expect(cast.data.embeds[0].description).toContain("DEX** save vs DC **15**");
    expect(cast.data.embeds[0].description).toContain("8d6 fire");
    const cast2 = await run(deps, command(ALEX, "spell", sub("cast", { level: 1, name: "Fireball" })));
    expect(cast2.data.content).toContain("3rd-level slot");
    await run(deps, command(ALEX, "inv", sub("add", { item: "Potion of Healing", qty: 2 })));
    await run(deps, command(ALEX, "inv", sub("coins", { gp: 12 })));
    const spend = await run(deps, command(ALEX, "inv", sub("coins", { gp: -20 })));
    expect(spend.data.content).toContain("can't afford");
    const inv = await run(deps, command(ALEX, "inv", sub("list")));
    expect(inv.data.embeds[0].description).toContain("Potion of Healing ×2");
    expect(inv.data.embeds[0].description).toContain("12 gp");
  });
});

describe("lookups and autocomplete", () => {
  it("shows monsters with page buttons", async () => {
    const { deps } = makeDeps();
    const res = await run(deps, command(ALEX, "monster", opts({ name: "adult red dragon" })));
    expect(res.data.embeds[0].title).toBe("Adult Red Dragon");
    expect(res.data.components[0].components[1].custom_id).toBe("mon:adult-red-dragon:actions");
    const page = await run(deps, click(ALEX, "mon:adult-red-dragon:actions"));
    expect(page.type).toBe(UPDATE);
    expect(page.data.embeds[0].description).toContain("Fire Breath");
    expect(JSON.stringify(page.data).length).toBeLessThan(7000);
  });

  it("autocompletes", async () => {
    const { deps } = makeDeps();
    const res = await run(deps, autocomplete(ALEX, "spell", [{ type: 1, name: "info", options: [{ type: 3, name: "name", value: "fireb", focused: true }] }]));
    expect(res.type).toBe(AUTOCOMPLETE);
    expect(res.data.choices[0].value).toBe("Fireball");
    const classes = await run(deps, autocomplete(ALEX, "char", [{ type: 1, name: "create", options: [{ type: 3, name: "class", value: "wiz", focused: true }] }]));
    expect(classes.data.choices.map((c: any) => c.value)).toContain("wizard");
  });

  it("looks up spells, conditions and items", async () => {
    const { deps } = makeDeps();
    const spell = await run(deps, command(ALEX, "spell", sub("info", { name: "cure wounds" })));
    expect(spell.data.embeds[0].title).toBe("Cure Wounds");
    const cond = await run(deps, command(ALEX, "condition", opts({ name: "prone" })));
    expect(cond.data.embeds[0].title).toBe("Prone");
    const item = await run(deps, command(ALEX, "item", opts({ name: "bag of holding" })));
    expect(item.data.embeds[0].title).toBe("Bag of Holding");
  });
});

describe("combat tracker", () => {
  it("runs a fight with buttons and keeps sheets in sync", async () => {
    const { deps } = makeDeps({ rng: fixedRng(10) });
    await createMira(deps);
    await run(deps, command(ALEX, "init", sub("start")));
    await run(deps, command(ALEX, "init", sub("join")));
    const goblins = await run(deps, command(ALEX, "init", sub("monster", { name: "goblin", count: 2 })));
    expect(goblins.data.embeds[0].description).toContain("Goblin A");
    expect(goblins.data.embeds[0].description).not.toContain("/7 HP"); // monster HP hidden by default

    const next = await run(deps, click(ALEX, "init:next"));
    expect(next.type).toBe(UPDATE);
    expect(next.data.embeds[0].fields[0].value).toContain("Goblin A");

    await run(deps, command(ALEX, "init", sub("damage", { target: "Mira", amount: 5 })));
    const mira = (await deps.store.list<Character>("char:guild1:111:"))[0]!.value;
    expect(mira.hp).toBe(mira.maxHp - 5);

    await run(deps, command(ALEX, "char", sub("attack-add", { name: "Dagger" })));
    const attack = await run(deps, command(ALEX, "attack", opts({ name: "dagger", target: "Goblin B" })));
    expect(attack.data.embeds[0].description).toContain("vs **Goblin B**: **Hit!**");
    const combat = (await deps.store.get<Combat>(keys.combat("chan1")))!.value;
    const goblinB = combat.combatants.find((x) => x.name === "Goblin B")!;
    expect(goblinB.hp).toBeLessThan(goblinB.maxHp!);

    const end = await run(deps, click(ALEX, "init:end"));
    expect(end.data.embeds[0].title).toContain("Combat over");
    expect(await deps.store.get(keys.combat("chan1"))).toBeUndefined();
  });
});

describe("slow responses", () => {
  it("defers when the store is slow and edits the original later", async () => {
    const slow = new MemoryStore();
    const get = slow.get.bind(slow);
    slow.get = async (k) => {
      await new Promise((r) => setTimeout(r, 2600));
      return get(k);
    };
    const { deps, discord, flush } = makeDeps({ store: slow });
    const res = await run(deps, command(ALEX, "char", sub("sheet")));
    expect(res.type).toBe(DEFERRED);
    await flush();
    // The reply is an ephemeral error, so the public "thinking" message is swapped for a private one.
    expect(discord.calls.map((c) => c.kind)).toEqual(["delete", "followup"]);
    expect(discord.calls[1]!.body!.content).toContain("/char create");
  }, 10_000);
});
