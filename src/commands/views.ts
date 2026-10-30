import type { APIEmbed } from "discord-api-types/v10";
import {
  coinsText,
  hpBar,
  initiativeMod,
  passivePerception,
  profBonus,
  saveBonus,
  skillBonus,
  spellAttackBonus,
  spellSaveDc,
  type Character,
} from "../game/character.js";
import { formatBreakdown, type RollResult } from "../game/dice.js";
import { ABILITIES, SKILLS, abilityMod, ordinal, signed } from "../game/rules.js";
import { COLORS, embed, truncate, type EmbedInput } from "../discord/ui.js";
import { crText, type SrdCondition, type SrdMagicItem, type SrdMonster, type SrdSpell } from "../srd/index.js";
import type { SrdArmor, SrdWeapon } from "../srd/types.js";

export const rollLine = (r: RollResult) => `${formatBreakdown(r)} = **${r.total}**`;

export function natNote(r: RollResult): string {
  if (r.natural === 20) return "✨ **Natural 20!**";
  if (r.natural === 1) return "💀 **Natural 1.**";
  return "";
}

export function rollColor(r: RollResult): number {
  if (r.natural === 20) return COLORS.crit;
  if (r.natural === 1) return COLORS.danger;
  return COLORS.brand;
}

export function dcLine(r: RollResult, dc: number | undefined): string {
  if (dc === undefined) return "";
  return r.total >= dc ? `✅ **Success** vs DC ${dc}` : `❌ **Failure** vs DC ${dc}`;
}

export function rollEmbed(opts: {
  title: string;
  result: RollResult;
  dc?: number;
  author?: string;
  footer?: string;
  extra?: string;
}): APIEmbed {
  const lines = [`\`${opts.result.notation}\` → ${rollLine(opts.result)}`, natNote(opts.result), dcLine(opts.result, opts.dc)];
  if (opts.extra) lines.push(opts.extra);
  const input: EmbedInput = { title: opts.title, description: lines.filter(Boolean).join("\n"), color: rollColor(opts.result) };
  if (opts.author) input.author = opts.author;
  if (opts.footer) input.footer = opts.footer;
  return embed(input);
}

const pips = (max: number, used: number) => "●".repeat(Math.max(0, max - used)) + "○".repeat(Math.min(max, used));

export function slotsText(c: Character): string {
  const lines: string[] = [];
  c.spellSlotsMax.forEach((max, i) => {
    if (max > 0) lines.push(`${ordinal(i + 1)} ${pips(max, c.spellSlotsUsed[i] ?? 0)}`);
  });
  if (c.pact) lines.push(`Pact (${ordinal(c.pact.level)}) ${pips(c.pact.max, c.pact.used)}`);
  return lines.join("  ·  ");
}

export function abilityGrid(scores: readonly number[]): string {
  const cells = ABILITIES.map((a, i) => {
    const s = scores[i] ?? 10;
    return `${a.toUpperCase()} ${String(s).padStart(2)} (${signed(abilityMod(s))})`;
  });
  return "```\n" + `${cells.slice(0, 3).join("  ")}\n${cells.slice(3).join("  ")}` + "\n```";
}

export function characterEmbed(c: Character, ownerName?: string): APIEmbed {
  const fields: EmbedInput["fields"] = [];
  const hpLine = `${c.hp}/${c.maxHp}${c.tempHp ? ` (+${c.tempHp} temp)` : ""}\n${hpBar(c.hp, c.maxHp)}`;
  fields.push({ name: "❤️ Hit Points", value: hpLine, inline: true });
  fields.push({ name: "🛡️ Armor Class", value: String(c.ac), inline: true });
  fields.push({ name: "🏃 Speed", value: `${c.speed} ft`, inline: true });
  fields.push({ name: "⚡ Initiative", value: signed(initiativeMod(c)), inline: true });
  fields.push({ name: "🎓 Proficiency", value: signed(profBonus(c)), inline: true });
  fields.push({ name: "👁️ Passive Perception", value: String(passivePerception(c)), inline: true });
  fields.push({ name: "Abilities", value: abilityGrid(ABILITIES.map((a) => c.abilities[a])) });
  fields.push({
    name: "Saving Throws",
    value: ABILITIES.map((a) => {
      const t = `${a.toUpperCase()} ${signed(saveBonus(c, a))}`;
      return c.saveProfs.includes(a) ? `**${t}**` : t;
    }).join(" · "),
  });
  const skills = (Object.keys(SKILLS) as (keyof typeof SKILLS)[])
    .filter((s) => c.skillProfs.includes(s) || c.expertise.includes(s))
    .map((s) => `${SKILLS[s].name} ${signed(skillBonus(c, s))}${c.expertise.includes(s) ? " ★" : ""}`);
  fields.push({ name: "Skills", value: skills.length ? skills.join(" · ") : "_None yet — add with `/char prof`_" });

  const dc = spellSaveDc(c);
  const slots = slotsText(c);
  if (dc !== undefined || slots) {
    const atk = spellAttackBonus(c);
    const head = dc !== undefined ? `Save DC **${dc}** · Spell attack **${signed(atk ?? 0)}**` : "";
    fields.push({ name: "✨ Spellcasting", value: [head, slots].filter(Boolean).join("\n") });
  }
  if (c.attacks.length) {
    fields.push({
      name: "⚔️ Attacks",
      value: c.attacks.map((a) => `**${a.name}** ${signed(a.toHit)} · ${a.damage}${a.notes ? ` · _${a.notes}_` : ""}`).join("\n"),
    });
  }
  if (c.hp === 0) {
    fields.push({
      name: "💀 Death Saves",
      value: `Successes ${"✅".repeat(c.deathSaves.successes)}${"▫️".repeat(3 - c.deathSaves.successes)}  Failures ${"❌".repeat(c.deathSaves.failures)}${"▫️".repeat(3 - c.deathSaves.failures)}`,
    });
  }
  if (c.conditions.length) fields.push({ name: "Conditions", value: c.conditions.join(", ") });
  const items = c.inventory.map((i) => (i.qty > 1 ? `${i.name} ×${i.qty}` : i.name));
  fields.push({
    name: "🎒 Inventory",
    value: `💰 ${coinsText(c.coins)}${items.length ? `\n${truncate(items.join(", "), 900)}` : ""}`,
  });
  if (c.notes) fields.push({ name: "📝 Notes", value: c.notes });

  const subtitle = [c.background, c.alignment].filter(Boolean).join(" · ");
  const input: EmbedInput = {
    title: c.name,
    author: `Level ${c.level} ${c.species} ${c.className}`,
    fields,
    color: c.hp === 0 ? COLORS.danger : COLORS.brand,
    footer: [ownerName ? `Played by ${ownerName}` : "", `XP ${c.xp}`, c.inspiration ? "★ Inspired" : ""]
      .filter(Boolean)
      .join(" · "),
  };
  if (subtitle) input.description = `_${subtitle}_`;
  if (c.portraitUrl) input.thumbnail = c.portraitUrl;
  return embed(input);
}

const featureLines = (features: { name: string; desc: string }[]) =>
  features.map((f) => `***${f.name}.*** ${f.desc}`).join("\n\n");

export type MonsterPage = "stats" | "actions";

export function monsterEmbed(m: SrdMonster, page: MonsterPage = "stats"): APIEmbed {
  const head = `_${m.size} ${m.type}, ${m.alignment}_`;
  const core = [
    `**Armor Class** ${m.ac}${m.acNote ? ` (${m.acNote})` : ""}`,
    `**Hit Points** ${m.hp} (${m.hpRoll})`,
    `**Speed** ${m.speed}`,
  ].join("\n");
  const footer = `CR ${crText(m.cr)} (${m.xp.toLocaleString("en-US")} XP) · Proficiency +${m.profBonus} · SRD 5.1`;

  if (page === "actions") {
    const parts = [`**Actions**\n${featureLines(m.actions)}`];
    if (m.reactions.length) parts.push(`**Reactions**\n${featureLines(m.reactions)}`);
    if (m.legendary.length) parts.push(`**Legendary Actions**\n${featureLines(m.legendary)}`);
    return embed({ title: `${m.name} — Actions`, description: parts.join("\n\n"), color: COLORS.danger, footer });
  }

  const details = [
    m.saves && `**Saving Throws** ${m.saves}`,
    m.skills && `**Skills** ${m.skills}`,
    m.vulnerabilities && `**Damage Vulnerabilities** ${m.vulnerabilities}`,
    m.resistances && `**Damage Resistances** ${m.resistances}`,
    m.immunities && `**Damage Immunities** ${m.immunities}`,
    m.conditionImmunities && `**Condition Immunities** ${m.conditionImmunities}`,
    `**Senses** ${m.senses}`,
    `**Languages** ${m.languages}`,
  ]
    .filter(Boolean)
    .join("\n");
  const description = [head, core, abilityGrid(m.abilities), details, m.traits.length ? featureLines(m.traits) : ""]
    .filter(Boolean)
    .join("\n\n");
  return embed({ title: m.name, description, color: COLORS.danger, footer });
}

export function spellEmbed(s: SrdSpell): APIEmbed {
  const kind = s.level === 0 ? `${s.school} cantrip` : `${ordinal(s.level)}-level ${s.school.toLowerCase()}`;
  const tags = [s.ritual ? "ritual" : "", s.concentration ? "concentration" : ""].filter(Boolean);
  const fields: EmbedInput["fields"] = [
    { name: "Casting Time", value: s.castingTime, inline: true },
    { name: "Range", value: s.range + (s.area ? ` (${s.area})` : ""), inline: true },
    { name: "Duration", value: s.duration, inline: true },
    { name: "Components", value: s.components },
  ];
  if (s.higherLevel) fields.push({ name: "At Higher Levels", value: s.higherLevel });
  if (s.classes.length) fields.push({ name: "Classes", value: s.classes.join(", ") });
  return embed({
    title: s.name,
    description: `_${kind}${tags.length ? ` (${tags.join(", ")})` : ""}_\n\n${s.desc}`,
    fields,
    color: COLORS.info,
    footer: "SRD 5.1",
  });
}

export function conditionEmbed(c: SrdCondition): APIEmbed {
  return embed({ title: c.name, description: c.desc, color: COLORS.warning, footer: "SRD 5.1" });
}

export function magicItemEmbed(i: SrdMagicItem): APIEmbed {
  return embed({ title: i.name, description: i.desc, color: COLORS.crit, footer: `${i.rarity} · SRD 5.1` });
}

export function weaponEmbed(w: SrdWeapon): APIEmbed {
  const fields: EmbedInput["fields"] = [
    { name: "Damage", value: `${w.damage} ${w.damageType}${w.twoHanded ? ` (${w.twoHanded} two-handed)` : ""}`, inline: true },
    { name: "Cost", value: w.cost, inline: true },
  ];
  if (w.weight !== undefined) fields.push({ name: "Weight", value: `${w.weight} lb`, inline: true });
  if (w.range) fields.push({ name: "Range", value: `${w.range} ft`, inline: true });
  if (w.properties.length) fields.push({ name: "Properties", value: w.properties.join(", ") });
  return embed({ title: w.name, description: `_${w.category} weapon_`, fields, color: COLORS.brand, footer: "SRD 5.1" });
}

export function armorEmbed(a: SrdArmor): APIEmbed {
  const ac =
    a.category === "Shield"
      ? `+${a.baseAc}`
      : `${a.baseAc}${a.dexBonus ? ` + Dex modifier${a.maxDexBonus !== undefined ? ` (max ${a.maxDexBonus})` : ""}` : ""}`;
  const fields: EmbedInput["fields"] = [
    { name: "Armor Class", value: ac, inline: true },
    { name: "Cost", value: a.cost, inline: true },
  ];
  if (a.strMinimum) fields.push({ name: "Strength", value: `Str ${a.strMinimum}`, inline: true });
  if (a.stealthDisadvantage) fields.push({ name: "Stealth", value: "Disadvantage", inline: true });
  return embed({ title: a.name, description: `_${a.category} armor_`, fields, color: COLORS.brand, footer: "SRD 5.1" });
}
