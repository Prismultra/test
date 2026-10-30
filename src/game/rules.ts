// 5e rules tables from the SRD 5.1.

export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export type Ability = (typeof ABILITIES)[number];

export const ABILITY_NAMES: Record<Ability, string> = {
  str: "Strength",
  dex: "Dexterity",
  con: "Constitution",
  int: "Intelligence",
  wis: "Wisdom",
  cha: "Charisma",
};

export const SKILLS = {
  acrobatics: { name: "Acrobatics", ability: "dex" },
  "animal-handling": { name: "Animal Handling", ability: "wis" },
  arcana: { name: "Arcana", ability: "int" },
  athletics: { name: "Athletics", ability: "str" },
  deception: { name: "Deception", ability: "cha" },
  history: { name: "History", ability: "int" },
  insight: { name: "Insight", ability: "wis" },
  intimidation: { name: "Intimidation", ability: "cha" },
  investigation: { name: "Investigation", ability: "int" },
  medicine: { name: "Medicine", ability: "wis" },
  nature: { name: "Nature", ability: "int" },
  perception: { name: "Perception", ability: "wis" },
  performance: { name: "Performance", ability: "cha" },
  persuasion: { name: "Persuasion", ability: "cha" },
  religion: { name: "Religion", ability: "int" },
  "sleight-of-hand": { name: "Sleight of Hand", ability: "dex" },
  stealth: { name: "Stealth", ability: "dex" },
  survival: { name: "Survival", ability: "wis" },
} as const satisfies Record<string, { name: string; ability: Ability }>;

export type Skill = keyof typeof SKILLS;
export const SKILL_KEYS = Object.keys(SKILLS) as Skill[];

export const isAbility = (s: string): s is Ability => (ABILITIES as readonly string[]).includes(s);
export const isSkill = (s: string): s is Skill => s in SKILLS;

/** Accepts "str", "Strength", "stealth", "Sleight of Hand", "sleight_of_hand"... */
export function parseAbility(input: string): Ability | undefined {
  const s = input.trim().toLowerCase();
  if (isAbility(s)) return s;
  return ABILITIES.find((a) => ABILITY_NAMES[a].toLowerCase() === s);
}

export function parseSkill(input: string): Skill | undefined {
  const s = input.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (isSkill(s)) return s;
  return SKILL_KEYS.find((k) => SKILLS[k].name.toLowerCase().replace(/\s+/g, "-") === s);
}

export const abilityMod = (score: number) => Math.floor((score - 10) / 2);

export const proficiencyBonus = (level: number) => 2 + Math.floor((Math.max(1, level) - 1) / 4);

export const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

export type CasterType = "full" | "half" | "pact";

export interface ClassInfo {
  name: string;
  hitDie: number;
  saves: [Ability, Ability];
  caster?: { type: CasterType; ability: Ability };
}

export const CLASSES = {
  barbarian: { name: "Barbarian", hitDie: 12, saves: ["str", "con"] },
  bard: { name: "Bard", hitDie: 8, saves: ["dex", "cha"], caster: { type: "full", ability: "cha" } },
  cleric: { name: "Cleric", hitDie: 8, saves: ["wis", "cha"], caster: { type: "full", ability: "wis" } },
  druid: { name: "Druid", hitDie: 8, saves: ["int", "wis"], caster: { type: "full", ability: "wis" } },
  fighter: { name: "Fighter", hitDie: 10, saves: ["str", "con"] },
  monk: { name: "Monk", hitDie: 8, saves: ["str", "dex"] },
  paladin: { name: "Paladin", hitDie: 10, saves: ["wis", "cha"], caster: { type: "half", ability: "cha" } },
  ranger: { name: "Ranger", hitDie: 10, saves: ["str", "dex"], caster: { type: "half", ability: "wis" } },
  rogue: { name: "Rogue", hitDie: 8, saves: ["dex", "int"] },
  sorcerer: { name: "Sorcerer", hitDie: 6, saves: ["con", "cha"], caster: { type: "full", ability: "cha" } },
  warlock: { name: "Warlock", hitDie: 8, saves: ["wis", "cha"], caster: { type: "pact", ability: "cha" } },
  wizard: { name: "Wizard", hitDie: 6, saves: ["int", "wis"], caster: { type: "full", ability: "int" } },
} as const satisfies Record<string, ClassInfo>;

export type ClassKey = keyof typeof CLASSES;
export const CLASS_KEYS = Object.keys(CLASSES) as ClassKey[];

export function classInfo(key: string | undefined): ClassInfo | undefined {
  if (!key) return undefined;
  const k = key.trim().toLowerCase();
  return k in CLASSES ? (CLASSES[k as ClassKey] as ClassInfo) : undefined;
}

export const SPECIES = [
  "Dragonborn",
  "Dwarf",
  "Elf",
  "Gnome",
  "Half-Elf",
  "Half-Orc",
  "Halfling",
  "Human",
  "Tiefling",
];

/** Spell slots per spell level (index 0 = 1st level) for a full caster. */
const FULL_CASTER_SLOTS: number[][] = [
  [2],
  [3],
  [4, 2],
  [4, 3],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 3, 2, 2, 1, 1],
];

const pad9 = (xs: number[]) => [...xs, ...Array(9 - xs.length).fill(0)] as number[];

/** Regular (non-pact) spell slots for a class at a level, as 9 numbers. */
export function spellSlots(classKey: string | undefined, level: number): number[] {
  const caster = classInfo(classKey)?.caster;
  const lvl = Math.min(20, Math.max(1, level));
  if (caster?.type === "full") return pad9(FULL_CASTER_SLOTS[lvl - 1]!);
  if (caster?.type === "half") return lvl < 2 ? pad9([]) : pad9(FULL_CASTER_SLOTS[Math.ceil(lvl / 2) - 1]!);
  return pad9([]);
}

/** Warlock Pact Magic slots. */
export function pactSlots(level: number): { count: number; level: number } {
  const lvl = Math.min(20, Math.max(1, level));
  const count = lvl === 1 ? 1 : lvl <= 10 ? 2 : lvl <= 16 ? 3 : 4;
  const slotLevel = Math.min(5, Math.ceil(lvl / 2));
  return { count, level: slotLevel };
}

export const XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000,
  225000, 265000, 305000, 355000,
];

export const levelForXp = (xp: number) => {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) if (xp >= XP_THRESHOLDS[i]!) level = i + 1;
  return level;
};

/** Max HP using the fixed (average) value per level after 1st. */
export function defaultMaxHp(classKey: string | undefined, level: number, conScore: number): number {
  const die = classInfo(classKey)?.hitDie ?? 8;
  const con = abilityMod(conScore);
  const first = die + con;
  const perLevel = Math.floor(die / 2) + 1 + con;
  return Math.max(1, first + Math.max(0, level - 1) * Math.max(1, perLevel));
}

export const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
