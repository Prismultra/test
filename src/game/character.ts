import { roll, type Rng, type RollMode, type RollResult } from "./dice.js";
import {
  ABILITIES,
  SKILLS,
  abilityMod,
  classInfo,
  defaultMaxHp,
  pactSlots,
  proficiencyBonus,
  signed,
  spellSlots,
  type Ability,
  type Skill,
} from "./rules.js";

export interface Attack {
  name: string;
  toHit: number;
  /** Dice expression with optional damage types, e.g. "1d8+3 slashing" */
  damage: string;
  notes?: string;
}

export interface Item {
  name: string;
  qty: number;
}

export interface Coins {
  pp: number;
  gp: number;
  sp: number;
  cp: number;
}

export interface Character {
  id: string;
  guildId: string;
  ownerId: string;
  name: string;
  species: string;
  className: string;
  /** Set when className is one of the SRD classes; drives saves and spell slots. */
  classKey?: string;
  level: number;
  background?: string;
  alignment?: string;
  abilities: Record<Ability, number>;
  saveProfs: Ability[];
  skillProfs: Skill[];
  expertise: Skill[];
  maxHp: number;
  hp: number;
  tempHp: number;
  ac: number;
  speed: number;
  initiativeBonus: number;
  hitDiceUsed: number;
  spellSlotsMax: number[];
  spellSlotsUsed: number[];
  pact?: { max: number; used: number; level: number };
  conditions: string[];
  inventory: Item[];
  coins: Coins;
  attacks: Attack[];
  deathSaves: { successes: number; failures: number };
  inspiration: boolean;
  xp: number;
  notes: string;
  portraitUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewCharacterInput {
  id: string;
  guildId: string;
  ownerId: string;
  name: string;
  className: string;
  species?: string;
  level?: number;
  abilities?: Partial<Record<Ability, number>>;
  maxHp?: number;
  ac?: number;
  speed?: number;
  background?: string;
  alignment?: string;
  now?: string;
}

export const clampLevel = (level: number) => Math.min(20, Math.max(1, Math.round(level)));

export function createCharacter(input: NewCharacterInput): Character {
  const level = clampLevel(input.level ?? 1);
  const abilities = Object.fromEntries(
    ABILITIES.map((a) => [a, clampScore(input.abilities?.[a] ?? 10)]),
  ) as Record<Ability, number>;
  const cls = classInfo(input.className);
  const classKey = cls ? input.className.trim().toLowerCase() : undefined;
  const maxHp = input.maxHp ?? defaultMaxHp(classKey, level, abilities.con);
  const now = input.now ?? new Date().toISOString();
  const char: Character = {
    id: input.id,
    guildId: input.guildId,
    ownerId: input.ownerId,
    name: input.name.trim().slice(0, 64),
    species: input.species?.trim() || "Human",
    className: cls?.name ?? input.className.trim(),
    level,
    abilities,
    saveProfs: cls ? [...cls.saves] : [],
    skillProfs: [],
    expertise: [],
    maxHp,
    hp: maxHp,
    tempHp: 0,
    ac: input.ac ?? 10 + abilityMod(abilities.dex),
    speed: input.speed ?? 30,
    initiativeBonus: 0,
    hitDiceUsed: 0,
    spellSlotsMax: spellSlots(classKey, level),
    spellSlotsUsed: Array(9).fill(0),
    conditions: [],
    inventory: [],
    coins: { pp: 0, gp: 0, sp: 0, cp: 0 },
    attacks: [],
    deathSaves: { successes: 0, failures: 0 },
    inspiration: false,
    xp: 0,
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
  if (classKey) char.classKey = classKey;
  if (input.background) char.background = input.background;
  if (input.alignment) char.alignment = input.alignment;
  if (classKey === "warlock") {
    const p = pactSlots(level);
    char.pact = { max: p.count, used: 0, level: p.level };
  }
  return char;
}

export const clampScore = (n: number) => Math.min(30, Math.max(1, Math.round(n)));

export const profBonus = (c: Character) => proficiencyBonus(c.level);

export const mod = (c: Character, a: Ability) => abilityMod(c.abilities[a]);

export function skillBonus(c: Character, skill: Skill): number {
  const base = mod(c, SKILLS[skill].ability);
  if (c.expertise.includes(skill)) return base + 2 * profBonus(c);
  if (c.skillProfs.includes(skill)) return base + profBonus(c);
  return base;
}

export const saveBonus = (c: Character, a: Ability) => mod(c, a) + (c.saveProfs.includes(a) ? profBonus(c) : 0);

export const initiativeMod = (c: Character) => mod(c, "dex") + c.initiativeBonus;

export const passivePerception = (c: Character) => 10 + skillBonus(c, "perception");

export function spellcastingAbility(c: Character): Ability | undefined {
  return classInfo(c.classKey)?.caster?.ability;
}

export function spellSaveDc(c: Character): number | undefined {
  const a = spellcastingAbility(c);
  return a ? 8 + profBonus(c) + mod(c, a) : undefined;
}

export function spellAttackBonus(c: Character): number | undefined {
  const a = spellcastingAbility(c);
  return a ? profBonus(c) + mod(c, a) : undefined;
}

export const hitDie = (c: Character) => classInfo(c.classKey)?.hitDie ?? 8;

export const touch = (c: Character, now = new Date().toISOString()) => {
  c.updatedAt = now;
  return c;
};

export interface DamageOutcome {
  absorbedByTemp: number;
  taken: number;
  droppedToZero: boolean;
  instantDeath: boolean;
  deathSaveFailures: number;
}

/** Applies damage per the SRD: temp HP first, then HP; massive damage kills outright. */
export function applyDamage(c: Character, amount: number, opts: { critical?: boolean } = {}): DamageOutcome {
  const dmg = Math.max(0, Math.floor(amount));
  const absorbed = Math.min(c.tempHp, dmg);
  c.tempHp -= absorbed;
  const rest = dmg - absorbed;
  const out: DamageOutcome = {
    absorbedByTemp: absorbed,
    taken: rest,
    droppedToZero: false,
    instantDeath: false,
    deathSaveFailures: 0,
  };
  if (rest === 0) return out;

  if (c.hp === 0) {
    // Damage while at 0 HP causes death save failures (2 on a crit).
    if (rest >= c.maxHp) out.instantDeath = true;
    out.deathSaveFailures = opts.critical ? 2 : 1;
    c.deathSaves.failures = Math.min(3, c.deathSaves.failures + out.deathSaveFailures);
    return out;
  }

  const overflow = rest - c.hp;
  c.hp = Math.max(0, c.hp - rest);
  if (c.hp === 0) {
    out.droppedToZero = true;
    if (overflow >= c.maxHp) out.instantDeath = true;
    addCondition(c, "Unconscious");
  }
  return out;
}

export function heal(c: Character, amount: number): number {
  const before = c.hp;
  c.hp = Math.min(c.maxHp, c.hp + Math.max(0, Math.floor(amount)));
  if (before === 0 && c.hp > 0) {
    c.deathSaves = { successes: 0, failures: 0 };
    removeCondition(c, "Unconscious");
  }
  return c.hp - before;
}

export function setTempHp(c: Character, amount: number) {
  // Temporary hit points don't stack; keep the higher value.
  c.tempHp = Math.max(c.tempHp, Math.max(0, Math.floor(amount)));
}

export function addCondition(c: Character, condition: string) {
  const name = condition.trim();
  if (name && !c.conditions.some((x) => x.toLowerCase() === name.toLowerCase())) c.conditions.push(name);
}

export function removeCondition(c: Character, condition: string): boolean {
  const before = c.conditions.length;
  c.conditions = c.conditions.filter((x) => x.toLowerCase() !== condition.trim().toLowerCase());
  return c.conditions.length !== before;
}

export interface DeathSaveOutcome {
  roll: RollResult;
  result: "success" | "failure" | "stable" | "dead" | "revived";
}

export function rollDeathSave(c: Character, rng?: Rng): DeathSaveOutcome {
  const r = roll("1d20", rng ? { rng } : {});
  const nat = r.natural ?? r.total;
  if (nat === 20) {
    c.hp = 1;
    c.deathSaves = { successes: 0, failures: 0 };
    removeCondition(c, "Unconscious");
    return { roll: r, result: "revived" };
  }
  if (nat >= 10) c.deathSaves.successes++;
  else c.deathSaves.failures += nat === 1 ? 2 : 1;
  c.deathSaves.failures = Math.min(3, c.deathSaves.failures);
  if (c.deathSaves.failures >= 3) return { roll: r, result: "dead" };
  if (c.deathSaves.successes >= 3) {
    c.deathSaves = { successes: 0, failures: 0 };
    addCondition(c, "Stable");
    return { roll: r, result: "stable" };
  }
  return { roll: r, result: nat >= 10 ? "success" : "failure" };
}

export function longRest(c: Character) {
  c.hp = c.maxHp;
  c.tempHp = 0;
  c.spellSlotsUsed = Array(9).fill(0);
  if (c.pact) c.pact.used = 0;
  // Regain up to half of total hit dice (minimum 1).
  c.hitDiceUsed = Math.max(0, c.hitDiceUsed - Math.max(1, Math.floor(c.level / 2)));
  c.deathSaves = { successes: 0, failures: 0 };
  removeCondition(c, "Unconscious");
  removeCondition(c, "Stable");
}

export interface ShortRestOutcome {
  spent: number;
  healed: number;
  rolls: RollResult[];
}

export function shortRest(c: Character, hitDiceToSpend: number, rng?: Rng): ShortRestOutcome {
  const available = c.level - c.hitDiceUsed;
  const spend = Math.max(0, Math.min(available, Math.floor(hitDiceToSpend)));
  const rolls: RollResult[] = [];
  let healed = 0;
  for (let i = 0; i < spend; i++) {
    const r = roll(`1d${hitDie(c)}`, rng ? { rng } : {});
    rolls.push(r);
    healed += heal(c, Math.max(0, r.total + mod(c, "con")));
  }
  c.hitDiceUsed += spend;
  if (c.pact) c.pact.used = 0;
  return { spent: spend, healed, rolls };
}

/** Updates level-dependent values. Adds average HP per level gained. */
export function setLevel(c: Character, level: number) {
  const newLevel = clampLevel(level);
  const diff = newLevel - c.level;
  if (diff > 0) {
    const perLevel = Math.max(1, Math.floor(hitDie(c) / 2) + 1 + mod(c, "con"));
    c.maxHp += perLevel * diff;
    c.hp += perLevel * diff;
  }
  c.level = newLevel;
  c.hitDiceUsed = Math.min(c.hitDiceUsed, newLevel);
  if (c.classKey) {
    c.spellSlotsMax = spellSlots(c.classKey, newLevel);
    c.spellSlotsUsed = c.spellSlotsUsed.map((u, i) => Math.min(u, c.spellSlotsMax[i] ?? 0));
  }
  if (c.classKey === "warlock") {
    const p = pactSlots(newLevel);
    c.pact = { max: p.count, used: Math.min(c.pact?.used ?? 0, p.count), level: p.level };
  }
}

export type SlotOutcome = { ok: true; slotLevel: number; pact: boolean } | { ok: false; reason: string };

/** Spends a spell slot of the given level (1-9), preferring pact slots that fit. */
export function useSpellSlot(c: Character, level: number): SlotOutcome {
  if (level < 1 || level > 9) return { ok: false, reason: "Spell slot level must be 1-9." };
  if (c.pact && c.pact.level >= level && c.pact.used < c.pact.max) {
    c.pact.used++;
    return { ok: true, slotLevel: c.pact.level, pact: true };
  }
  const idx = level - 1;
  const max = c.spellSlotsMax[idx] ?? 0;
  const used = c.spellSlotsUsed[idx] ?? 0;
  if (max === 0) return { ok: false, reason: `${c.name} has no ${ordinalSlot(level)} slots.` };
  if (used >= max) return { ok: false, reason: `${c.name} is out of ${ordinalSlot(level)} slots.` };
  c.spellSlotsUsed[idx] = used + 1;
  return { ok: true, slotLevel: level, pact: false };
}

const ordinalSlot = (n: number) => `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}-level`;

export function addItem(c: Character, name: string, qty = 1): Item {
  const existing = c.inventory.find((i) => i.name.toLowerCase() === name.trim().toLowerCase());
  if (existing) {
    existing.qty += qty;
    return existing;
  }
  const item = { name: name.trim().slice(0, 80), qty };
  c.inventory.push(item);
  return item;
}

export function removeItem(c: Character, name: string, qty = 1): { removed: number; left: number } | undefined {
  const idx = c.inventory.findIndex((i) => i.name.toLowerCase() === name.trim().toLowerCase());
  if (idx < 0) return undefined;
  const item = c.inventory[idx]!;
  const removed = Math.min(item.qty, qty);
  item.qty -= removed;
  if (item.qty <= 0) c.inventory.splice(idx, 1);
  return { removed, left: Math.max(0, item.qty) };
}

const COIN_VALUE_CP: Record<keyof Coins, number> = { pp: 1000, gp: 100, sp: 10, cp: 1 };

export const coinsToCp = (coins: Coins) =>
  (Object.keys(COIN_VALUE_CP) as (keyof Coins)[]).reduce((s, k) => s + coins[k] * COIN_VALUE_CP[k], 0);

/**
 * Adds (positive) or spends (negative) coins. Spending makes change from larger
 * coins when needed. Returns false if the character can't afford it.
 */
export function adjustCoins(c: Character, delta: Partial<Coins>): boolean {
  const next = { ...c.coins };
  for (const k of Object.keys(delta) as (keyof Coins)[]) next[k] += delta[k] ?? 0;
  if (Object.values(next).every((v) => v >= 0)) {
    c.coins = next;
    return true;
  }
  const total = coinsToCp(next);
  if (total < 0) return false;
  // Re-denominate from the total value, keeping platinum as-is when possible.
  let rest = total;
  const pp = Math.min(Math.max(0, next.pp), Math.floor(rest / 1000));
  rest -= pp * 1000;
  const gp = Math.floor(rest / 100);
  rest -= gp * 100;
  const sp = Math.floor(rest / 10);
  rest -= sp * 10;
  c.coins = { pp, gp, sp, cp: rest };
  return true;
}

export function coinsText(coins: Coins): string {
  const parts = (["pp", "gp", "sp", "cp"] as const).filter((k) => coins[k] !== 0).map((k) => `${coins[k]} ${k}`);
  return parts.length ? parts.join(", ") : "0 gp";
}

export function hpBar(hp: number, max: number, width = 10): string {
  const ratio = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
  const filled = Math.round(ratio * width);
  const color = ratio > 0.5 ? "🟩" : ratio > 0.25 ? "🟨" : "🟥";
  return color.repeat(filled) + "⬛".repeat(width - filled);
}

/** Skill or ability check roll. */
export function rollCheck(
  c: Character,
  what: { skill: Skill } | { ability: Ability },
  opts: { mode?: RollMode; bonus?: number; rng?: Rng } = {},
): { roll: RollResult; modifier: number; label: string } {
  const modifier = ("skill" in what ? skillBonus(c, what.skill) : mod(c, what.ability)) + (opts.bonus ?? 0);
  const label = "skill" in what ? SKILLS[what.skill].name : `${what.ability.toUpperCase()} check`;
  const r = roll(`1d20${modifier >= 0 ? "+" : ""}${modifier}`, withOpts(opts));
  return { roll: r, modifier, label };
}

export function rollSave(
  c: Character,
  ability: Ability,
  opts: { mode?: RollMode; bonus?: number; rng?: Rng } = {},
): { roll: RollResult; modifier: number } {
  const modifier = saveBonus(c, ability) + (opts.bonus ?? 0);
  return { roll: roll(`1d20${modifier >= 0 ? "+" : ""}${modifier}`, withOpts(opts)), modifier };
}

function withOpts(opts: { mode?: RollMode; rng?: Rng }) {
  const o: { mode?: RollMode; rng?: Rng } = {};
  if (opts.mode) o.mode = opts.mode;
  if (opts.rng) o.rng = opts.rng;
  return o;
}

/** A compact one-paragraph summary, used by the AI DM. */
export function summarize(c: Character): string {
  const abil = ABILITIES.map((a) => `${a.toUpperCase()} ${c.abilities[a]}`).join(" ");
  const parts = [
    `${c.name} — level ${c.level} ${c.species} ${c.className}`,
    `HP ${c.hp}/${c.maxHp}${c.tempHp ? ` (+${c.tempHp} temp)` : ""}, AC ${c.ac}, speed ${c.speed} ft`,
    abil,
    c.skillProfs.length ? `proficient: ${c.skillProfs.map((s) => SKILLS[s].name).join(", ")}` : "",
    c.conditions.length ? `conditions: ${c.conditions.join(", ")}` : "",
    c.attacks.length ? `attacks: ${c.attacks.map((a) => `${a.name} (${signed(a.toHit)}, ${a.damage})`).join("; ")}` : "",
    c.inventory.length ? `carrying: ${c.inventory.map((i) => (i.qty > 1 ? `${i.name} x${i.qty}` : i.name)).join(", ")}` : "",
  ];
  return parts.filter(Boolean).join(". ");
}
