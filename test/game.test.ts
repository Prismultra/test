import { describe, expect, it } from "vitest";
import {
  addItem,
  adjustCoins,
  applyDamage,
  coinsText,
  createCharacter,
  heal,
  longRest,
  removeItem,
  rollCheck,
  rollDeathSave,
  saveBonus,
  setLevel,
  setTempHp,
  shortRest,
  skillBonus,
  spellAttackBonus,
  spellSaveDc,
  summarize,
  useSpellSlot,
} from "../src/game/character.js";
import {
  addCombatant,
  addMonsters,
  createCombat,
  current,
  damageCombatant,
  findCombatant,
  nextTurn,
  prevTurn,
  removeCombatant,
  renderOrder,
} from "../src/game/combat.js";
import type { Rng } from "../src/game/dice.js";
import { levelForXp, ordinal, pactSlots, parseAbility, parseSkill, proficiencyBonus, spellSlots } from "../src/game/rules.js";
import { findMonster, findSpell, searchByName, MONSTERS, SPELLS } from "../src/srd/index.js";

const fixed =
  (n: number): Rng =>
  () =>
    n;

const wizard = () =>
  createCharacter({
    id: "c1",
    guildId: "g",
    ownerId: "u",
    name: "Mira",
    className: "wizard",
    species: "Elf",
    level: 5,
    abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 12, cha: 10 },
    now: "2026-01-01T00:00:00.000Z",
  });

describe("rules", () => {
  it("computes proficiency bonus by level", () => {
    expect([1, 4, 5, 8, 9, 13, 17, 20].map(proficiencyBonus)).toEqual([2, 2, 3, 3, 4, 5, 6, 6]);
  });

  it("knows spell slot tables", () => {
    expect(spellSlots("wizard", 1)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlots("cleric", 5)).toEqual([4, 3, 2, 0, 0, 0, 0, 0, 0]);
    expect(spellSlots("wizard", 20)).toEqual([4, 3, 3, 3, 3, 2, 2, 1, 1]);
    expect(spellSlots("paladin", 1)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlots("paladin", 5)).toEqual([4, 2, 0, 0, 0, 0, 0, 0, 0]);
    expect(spellSlots("ranger", 17)).toEqual([4, 3, 3, 3, 1, 0, 0, 0, 0]);
    expect(spellSlots("fighter", 10)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(pactSlots(1)).toEqual({ count: 1, level: 1 });
    expect(pactSlots(5)).toEqual({ count: 2, level: 3 });
    expect(pactSlots(11)).toEqual({ count: 3, level: 5 });
    expect(pactSlots(20)).toEqual({ count: 4, level: 5 });
  });

  it("parses abilities and skills loosely", () => {
    expect(parseAbility("Strength")).toBe("str");
    expect(parseAbility("dex")).toBe("dex");
    expect(parseSkill("Sleight of Hand")).toBe("sleight-of-hand");
    expect(parseSkill("animal_handling")).toBe("animal-handling");
    expect(parseSkill("flying")).toBeUndefined();
  });

  it("maps XP to level and formats ordinals", () => {
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(299)).toBe(1);
    expect(levelForXp(300)).toBe(2);
    expect(levelForXp(400000)).toBe(20);
    expect([1, 2, 3, 4, 11, 12, 13, 21].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st"]);
  });
});

describe("characters", () => {
  it("creates a character with class defaults", () => {
    const c = wizard();
    expect(c.className).toBe("Wizard");
    expect(c.classKey).toBe("wizard");
    expect(c.saveProfs).toEqual(["int", "wis"]);
    expect(c.maxHp).toBe(6 + 1 + 4 * (3 + 1 + 1)); // d6: 7 at 1st, 5 per level after
    expect(c.ac).toBe(12);
    expect(c.spellSlotsMax.slice(0, 3)).toEqual([4, 3, 2]);
    expect(spellSaveDc(c)).toBe(15);
    expect(spellAttackBonus(c)).toBe(7);
  });

  it("supports homebrew classes", () => {
    const c = createCharacter({ id: "x", guildId: "g", ownerId: "u", name: "Zed", className: "Gunslinger" });
    expect(c.className).toBe("Gunslinger");
    expect(c.classKey).toBeUndefined();
    expect(c.saveProfs).toEqual([]);
    expect(c.maxHp).toBe(8);
  });

  it("computes skill and save bonuses with proficiency and expertise", () => {
    const c = wizard();
    expect(skillBonus(c, "arcana")).toBe(4);
    c.skillProfs.push("arcana");
    expect(skillBonus(c, "arcana")).toBe(7);
    c.expertise.push("arcana");
    expect(skillBonus(c, "arcana")).toBe(10);
    expect(saveBonus(c, "int")).toBe(7);
    expect(saveBonus(c, "str")).toBe(-1);
    const check = rollCheck(c, { skill: "arcana" }, { rng: fixed(10) });
    expect(check.roll.total).toBe(20);
    expect(check.label).toBe("Arcana");
  });

  it("applies damage through temp HP and handles dropping to 0", () => {
    const c = wizard();
    setTempHp(c, 5);
    setTempHp(c, 3); // doesn't stack
    expect(c.tempHp).toBe(5);
    let out = applyDamage(c, 8);
    expect(out.absorbedByTemp).toBe(5);
    expect(c.hp).toBe(c.maxHp - 3);
    out = applyDamage(c, 100);
    expect(out.droppedToZero).toBe(true);
    expect(out.instantDeath).toBe(true);
    expect(c.conditions).toContain("Unconscious");
  });

  it("tracks death saves and healing from 0", () => {
    const c = wizard();
    applyDamage(c, c.hp);
    expect(c.hp).toBe(0);
    applyDamage(c, 3, { critical: true });
    expect(c.deathSaves.failures).toBe(2);
    expect(rollDeathSave(c, fixed(12)).result).toBe("success");
    expect(rollDeathSave(c, fixed(1)).result).toBe("dead");
    const d = wizard();
    applyDamage(d, d.hp);
    expect(rollDeathSave(d, fixed(20)).result).toBe("revived");
    expect(d.hp).toBe(1);
    const e = wizard();
    applyDamage(e, e.hp);
    heal(e, 4);
    expect(e.hp).toBe(4);
    expect(e.conditions).not.toContain("Unconscious");
  });

  it("spends and restores spell slots", () => {
    const c = wizard();
    expect(useSpellSlot(c, 3)).toEqual({ ok: true, slotLevel: 3, pact: false });
    expect(useSpellSlot(c, 3)).toEqual({ ok: true, slotLevel: 3, pact: false });
    expect(useSpellSlot(c, 3).ok).toBe(false);
    expect(useSpellSlot(c, 4).ok).toBe(false);
    longRest(c);
    expect(c.spellSlotsUsed[2]).toBe(0);

    const w = createCharacter({ id: "w", guildId: "g", ownerId: "u", name: "Hex", className: "Warlock", level: 5 });
    expect(useSpellSlot(w, 1)).toEqual({ ok: true, slotLevel: 3, pact: true });
    expect(useSpellSlot(w, 2)).toEqual({ ok: true, slotLevel: 3, pact: true });
    expect(useSpellSlot(w, 1).ok).toBe(false);
    shortRest(w, 0);
    expect(w.pact?.used).toBe(0);
  });

  it("spends hit dice on a short rest", () => {
    const c = wizard();
    applyDamage(c, 10);
    const out = shortRest(c, 2, fixed(4));
    expect(out.spent).toBe(2);
    expect(out.healed).toBe(10); // (4 + 1 con) x2
    expect(c.hitDiceUsed).toBe(2);
    longRest(c);
    expect(c.hitDiceUsed).toBe(0);
  });

  it("levels up with more HP and slots", () => {
    const c = wizard();
    const hp = c.maxHp;
    setLevel(c, 7);
    expect(c.maxHp).toBe(hp + 2 * 5);
    expect(c.spellSlotsMax.slice(0, 4)).toEqual([4, 3, 3, 1]);
  });

  it("manages inventory and coins", () => {
    const c = wizard();
    addItem(c, "Rope (50 ft)");
    addItem(c, "Potion of Healing", 2);
    addItem(c, "potion of healing", 1);
    expect(c.inventory.find((i) => i.name === "Potion of Healing")?.qty).toBe(3);
    expect(removeItem(c, "potion of healing", 5)).toEqual({ removed: 3, left: 0 });
    expect(c.inventory).toHaveLength(1);
    expect(adjustCoins(c, { gp: 10 })).toBe(true);
    expect(adjustCoins(c, { sp: -15 })).toBe(true);
    expect(coinsText(c.coins)).toBe("8 gp, 5 sp");
    expect(adjustCoins(c, { gp: -100 })).toBe(false);
    expect(summarize(c)).toContain("Mira — level 5 Elf Wizard");
  });
});

describe("combat", () => {
  it("orders by initiative and keeps the turn when adding mid-round", () => {
    const c = createCombat({ channelId: "ch", guildId: "g", createdBy: "u" });
    addCombatant(c, { name: "Mira", initBonus: 2, isPlayer: true, initiative: 15 });
    addCombatant(c, { name: "Bran", initBonus: 1, isPlayer: true, initiative: 10 });
    expect(current(c)?.name).toBe("Mira");
    nextTurn(c);
    expect(current(c)?.name).toBe("Bran");
    addCombatant(c, { name: "Ogre", initBonus: -1, isPlayer: false, initiative: 20, hp: 59, maxHp: 59 });
    expect(c.combatants.map((x) => x.name)).toEqual(["Ogre", "Mira", "Bran"]);
    expect(current(c)?.name).toBe("Bran");
    nextTurn(c);
    expect(current(c)?.name).toBe("Ogre");
    expect(c.round).toBe(2);
    prevTurn(c);
    expect(current(c)?.name).toBe("Bran");
    expect(c.round).toBe(1);
  });

  it("breaks ties by bonus then players first", () => {
    const c = createCombat({ channelId: "ch", guildId: "g", createdBy: "u" });
    addCombatant(c, { name: "Goblin", initBonus: 2, isPlayer: false, initiative: 12 });
    addCombatant(c, { name: "Mira", initBonus: 2, isPlayer: true, initiative: 12 });
    addCombatant(c, { name: "Bran", initBonus: 3, isPlayer: true, initiative: 12 });
    expect(c.combatants.map((x) => x.name)).toEqual(["Bran", "Mira", "Goblin"]);
  });

  it("adds SRD monsters with letters, skips downed monsters and handles removal", () => {
    const c = createCombat({ channelId: "ch", guildId: "g", createdBy: "u" });
    const goblin = findMonster("goblin")!;
    addMonsters(c, goblin, 3, { rng: fixed(10) });
    addCombatant(c, { name: "Mira", initBonus: 2, isPlayer: true, initiative: 5 });
    expect(c.combatants.map((x) => x.name)).toEqual(["Goblin A", "Goblin B", "Goblin C", "Mira"]);
    expect(c.combatants[0]!.hp).toBe(7);
    damageCombatant(findCombatant(c, "goblin b")!, 50);
    expect(nextTurn(c)?.name).toBe("Goblin C");
    removeCombatant(c, findCombatant(c, "Goblin A")!.id);
    expect(current(c)?.name).toBe("Goblin C");
    const text = renderOrder(c);
    expect(text).toContain("Down");
    expect(text).not.toContain("7/7");
    expect(renderOrder(c, { revealHp: true })).toContain("7/7");
  });
});

describe("srd", () => {
  it("has the expected data", () => {
    expect(MONSTERS.length).toBeGreaterThan(300);
    expect(SPELLS.length).toBeGreaterThan(300);
    expect(findSpell("fireball")?.level).toBe(3);
    expect(findMonster("Adult Red Dragon")?.cr).toBe(17);
  });

  it("ranks search results sensibly", () => {
    expect(searchByName(SPELLS, "fire", 3).map((s) => s.name)).toEqual(expect.arrayContaining(["Fireball", "Fire Bolt"]));
    expect(searchByName(MONSTERS, "red drag", 5).map((m) => m.name)).toContain("Adult Red Dragon");
    expect(searchByName(SPELLS, "cure wnds", 1)[0]?.name).toBe("Cure Wounds");
  });
});
