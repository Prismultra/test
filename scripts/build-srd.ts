// Downloads the 5e SRD 5.1 data from the 5e-bits database and writes trimmed
// TypeScript modules to src/srd/data/. Run with `npm run build:srd`.
//
// Data: SRD 5.1 by Wizards of the Coast (CC-BY-4.0), structured by
// 5e-bits/5e-database (MIT). See NOTICE.md.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SrdAction,
  SrdArmor,
  SrdCondition,
  SrdFeature,
  SrdMagicItem,
  SrdMonster,
  SrdSpell,
  SrdWeapon,
} from "../src/srd/types.js";

const BASE = "https://raw.githubusercontent.com/5e-bits/5e-database/main/src/2014/en";
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(here, "..", "src", "srd", "data");

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

async function download(name: string): Promise<Raw[]> {
  const res = await fetch(`${BASE}/5e-SRD-${name}.json`);
  if (!res.ok) throw new Error(`Failed to download ${name}: ${res.status}`);
  return (await res.json()) as Raw[];
}

const joinDesc = (d: unknown): string =>
  Array.isArray(d) ? d.join("\n\n") : typeof d === "string" ? d : "";

const ABILITY_SHORT: Record<string, string> = {
  STR: "Str",
  DEX: "Dex",
  CON: "Con",
  INT: "Int",
  WIS: "Wis",
  CHA: "Cha",
};

const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

function speedText(speed: Record<string, string | boolean>): string {
  const parts: string[] = [];
  for (const [mode, value] of Object.entries(speed)) {
    if (mode === "hover") {
      if (value) parts.push("(hover)");
      continue;
    }
    parts.push(mode === "walk" ? String(value) : `${mode} ${value}`);
  }
  return parts.join(", ");
}

function sensesText(senses: Record<string, string | number>): string {
  return Object.entries(senses)
    .map(([k, v]) => (k === "passive_perception" ? `passive Perception ${v}` : `${k.replace(/_/g, " ")} ${v}`))
    .join(", ");
}

function damageText(damage: Raw[] | undefined): string | undefined {
  if (!Array.isArray(damage)) return undefined;
  const parts = damage
    .filter((d) => d && typeof d.damage_dice === "string")
    .map((d) => `${d.damage_dice.replace(/\s+/g, "")} ${d.damage_type?.name?.toLowerCase() ?? ""}`.trim());
  return parts.length ? parts.join(" + ") : undefined;
}

function features(list: Raw[] | undefined): SrdFeature[] {
  return (list ?? []).map((f) => ({ name: String(f.name), desc: joinDesc(f.desc) }));
}

function monster(m: Raw): SrdMonster {
  const ac = Array.isArray(m.armor_class) ? m.armor_class[0] : { value: m.armor_class };
  let acNote: string | undefined;
  if (ac?.type === "armor" && Array.isArray(ac.armor)) acNote = ac.armor.map((a: Raw) => a.name.toLowerCase()).join(", ");
  else if (ac?.type && ac.type !== "dex") acNote = String(ac.type);
  if (acNote && ac?.desc) acNote = `${acNote}; ${ac.desc}`;

  const saves: string[] = [];
  const skills: string[] = [];
  for (const p of m.proficiencies ?? []) {
    const name: string = p.proficiency?.name ?? "";
    if (name.startsWith("Saving Throw: ")) {
      const ab = name.slice("Saving Throw: ".length);
      saves.push(`${ABILITY_SHORT[ab] ?? ab} ${signed(p.value)}`);
    } else if (name.startsWith("Skill: ")) {
      skills.push(`${name.slice("Skill: ".length)} ${signed(p.value)}`);
    }
  }

  const list = (xs: Raw[] | undefined) => {
    const items = (xs ?? []).map((x) => (typeof x === "string" ? x : x.name)).filter(Boolean);
    return items.length ? items.join(", ") : undefined;
  };

  const actions: SrdAction[] = (m.actions ?? []).map((a: Raw) => {
    const out: SrdAction = { name: String(a.name), desc: joinDesc(a.desc) };
    if (typeof a.attack_bonus === "number") out.attackBonus = a.attack_bonus;
    const dmg = damageText(a.damage);
    if (dmg) out.damage = dmg;
    return out;
  });

  const result: SrdMonster = {
    id: m.index,
    name: m.name,
    size: m.size,
    type: m.subtype ? `${m.type} (${m.subtype})` : m.type,
    alignment: m.alignment,
    ac: Number(ac?.value ?? 10),
    hp: m.hit_points,
    hpRoll: String(m.hit_points_roll ?? m.hit_dice).replace(/\s+/g, ""),
    speed: speedText(m.speed ?? {}),
    abilities: [m.strength, m.dexterity, m.constitution, m.intelligence, m.wisdom, m.charisma],
    senses: sensesText(m.senses ?? {}),
    languages: m.languages || "—",
    cr: m.challenge_rating,
    xp: m.xp,
    profBonus: m.proficiency_bonus,
    traits: features(m.special_abilities),
    actions,
    reactions: features(m.reactions),
    legendary: features(m.legendary_actions),
  };
  if (acNote) result.acNote = acNote;
  if (saves.length) result.saves = saves.join(", ");
  if (skills.length) result.skills = skills.join(", ");
  const vuln = list(m.damage_vulnerabilities);
  if (vuln) result.vulnerabilities = vuln;
  const res = list(m.damage_resistances);
  if (res) result.resistances = res;
  const imm = list(m.damage_immunities);
  if (imm) result.immunities = imm;
  const cimm = list(m.condition_immunities);
  if (cimm) result.conditionImmunities = cimm;
  return result;
}

function spell(s: Raw): SrdSpell {
  const comps = (s.components ?? []).join(", ");
  const out: SrdSpell = {
    id: s.index,
    name: s.name,
    level: s.level,
    school: s.school?.name ?? "",
    castingTime: s.casting_time,
    range: s.range,
    components: s.material ? `${comps} (${String(s.material).replace(/\.$/, "")})` : comps,
    duration: s.duration,
    concentration: Boolean(s.concentration),
    ritual: Boolean(s.ritual),
    desc: joinDesc(s.desc),
    classes: (s.classes ?? []).map((c: Raw) => c.name),
  };
  const higher = joinDesc(s.higher_level);
  if (higher) out.higherLevel = higher;
  if (s.attack_type) out.attackType = s.attack_type;
  if (s.dc?.dc_type?.name) out.save = s.dc.dc_type.name;
  const dmg = Array.isArray(s.damage) ? s.damage[0] : s.damage;
  if (dmg?.damage_type?.name) out.damageType = dmg.damage_type.name.toLowerCase();
  if (dmg?.damage_at_slot_level) out.damageAtSlot = dmg.damage_at_slot_level;
  if (dmg?.damage_at_character_level) out.damageAtCharLevel = dmg.damage_at_character_level;
  if (s.heal_at_slot_level) out.healAtSlot = s.heal_at_slot_level;
  if (s.area_of_effect) out.area = `${s.area_of_effect.size} ft. ${s.area_of_effect.type}`;
  return out;
}

function condition(c: Raw): SrdCondition {
  return { id: c.index, name: c.name, desc: joinDesc(c.desc).replace(/\n\n/g, "\n") };
}

function magicItem(i: Raw): SrdMagicItem {
  return {
    id: i.index,
    name: i.name,
    category: i.equipment_category?.name ?? "",
    rarity: i.rarity?.name ?? "",
    desc: joinDesc(i.desc),
  };
}

const costText = (c: Raw) => (c ? `${c.quantity} ${c.unit}` : "—");

function weapon(e: Raw): SrdWeapon | undefined {
  if (e.equipment_category?.index !== "weapon" || !e.damage?.damage_dice) return undefined;
  const out: SrdWeapon = {
    id: e.index,
    name: e.name,
    category: e.category_range ?? e.weapon_category ?? "",
    damage: e.damage.damage_dice,
    damageType: e.damage.damage_type?.name?.toLowerCase() ?? "",
    properties: (e.properties ?? []).map((p: Raw) => p.name),
    cost: costText(e.cost),
  };
  if (e.two_handed_damage?.damage_dice) out.twoHanded = e.two_handed_damage.damage_dice;
  if (e.range?.long) out.range = `${e.range.normal}/${e.range.long}`;
  if (typeof e.weight === "number") out.weight = e.weight;
  return out;
}

function armor(e: Raw): SrdArmor | undefined {
  if (e.equipment_category?.index !== "armor" || !e.armor_class) return undefined;
  const out: SrdArmor = {
    id: e.index,
    name: e.name,
    category: e.armor_category ?? "",
    baseAc: e.armor_class.base,
    dexBonus: Boolean(e.armor_class.dex_bonus),
    stealthDisadvantage: Boolean(e.stealth_disadvantage),
    strMinimum: e.str_minimum ?? 0,
    cost: costText(e.cost),
  };
  if (typeof e.armor_class.max_bonus === "number") out.maxDexBonus = e.armor_class.max_bonus;
  return out;
}

async function writeModule(file: string, typeName: string, constName: string, data: unknown[]) {
  const body =
    `// Generated by scripts/build-srd.ts. Do not edit by hand.\n` +
    `// Contains SRD 5.1 material (CC-BY-4.0). See NOTICE.md.\n` +
    `import type { ${typeName} } from "../types.js";\n\n` +
    `export const ${constName}: ${typeName}[] = ${JSON.stringify(data)};\n`;
  await writeFile(path.join(OUT_DIR, file), body, "utf8");
  console.log(`wrote ${file} (${data.length} entries, ${(body.length / 1024).toFixed(0)} KB)`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const [monsters, spells, conditions, items, equipment] = await Promise.all([
    download("Monsters"),
    download("Spells"),
    download("Conditions"),
    download("Magic-Items"),
    download("Equipment"),
  ]);
  await writeModule("monsters.ts", "SrdMonster", "MONSTERS", monsters.map(monster));
  await writeModule("spells.ts", "SrdSpell", "SPELLS", spells.map(spell));
  await writeModule("conditions.ts", "SrdCondition", "CONDITIONS", conditions.map(condition));
  await writeModule("magic-items.ts", "SrdMagicItem", "MAGIC_ITEMS", items.map(magicItem));
  await writeModule(
    "weapons.ts",
    "SrdWeapon",
    "WEAPONS",
    equipment.map(weapon).filter((w): w is SrdWeapon => Boolean(w)),
  );
  await writeModule(
    "armor.ts",
    "SrdArmor",
    "ARMOR",
    equipment.map(armor).filter((a): a is SrdArmor => Boolean(a)),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
