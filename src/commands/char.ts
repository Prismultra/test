import {
  addCondition,
  clampScore,
  createCharacter,
  mod,
  profBonus,
  setLevel,
  type Character,
} from "../game/character.js";
import {
  ABILITIES,
  ABILITY_NAMES,
  CLASS_KEYS,
  CLASSES,
  SKILL_KEYS,
  SKILLS,
  SPECIES,
  classInfo,
  levelForXp,
  parseAbility,
  parseSkill,
  signed,
  type Ability,
} from "../game/rules.js";
import { findWeapon, searchByName, WEAPONS } from "../srd/index.js";
import { keys } from "../store/store.js";
import type { Ctx } from "../discord/context.js";
import { UserError, embed, COLORS, type Reply } from "../discord/ui.js";
import {
  characterKey,
  editCharacter,
  findOwnCharacter,
  getActive,
  getActiveId,
  listCharacters,
  newCharacterId,
  requireActive,
  setActive,
} from "./characters.js";
import { choice, type Choice, type CommandModule } from "./registry.js";
import { characterEmbed } from "./views.js";
import { parse } from "../game/dice.js";

const MAX_CHARACTERS = 25;

/** Fields settable with /char set: name -> [description, apply]. */
const FIELDS: Record<string, { label: string; apply: (c: Character, value: string) => string }> = {
  name: { label: "Name", apply: (c, v) => ((c.name = v.slice(0, 64)), `Name is now **${c.name}**.`) },
  species: { label: "Species", apply: (c, v) => ((c.species = v.slice(0, 40)), `Species is now **${c.species}**.`) },
  class: {
    label: "Class",
    apply: (c, v) => {
      const info = classInfo(v);
      c.className = info?.name ?? v.slice(0, 40);
      if (info) {
        c.classKey = v.trim().toLowerCase();
        c.saveProfs = [...info.saves];
      } else {
        // Homebrew classes don't get SRD spellcasting; clear what the old class had.
        delete c.classKey;
        c.spellSlotsMax = Array(9).fill(0);
        c.spellSlotsUsed = Array(9).fill(0);
        delete c.pact;
      }
      setLevel(c, c.level);
      return `Class is now **${c.className}**.`;
    },
  },
  level: {
    label: "Level",
    apply: (c, v) => {
      const before = c.maxHp;
      setLevel(c, intValue(v, 1, 20));
      const gained = c.maxHp - before;
      return `Now level **${c.level}**${gained > 0 ? ` (+${gained} max HP)` : ""}.`;
    },
  },
  ...Object.fromEntries(
    ABILITIES.map((a) => [
      a,
      {
        label: ABILITY_NAMES[a],
        apply: (c: Character, v: string) => {
          c.abilities[a] = clampScore(intValue(v, 1, 30));
          return `${ABILITY_NAMES[a]} is now **${c.abilities[a]}** (${signed(mod(c, a))}).`;
        },
      },
    ]),
  ),
  maxhp: {
    label: "Max HP",
    apply: (c, v) => {
      c.maxHp = intValue(v, 1, 9999);
      c.hp = Math.min(c.hp, c.maxHp);
      return `Max HP is now **${c.maxHp}**.`;
    },
  },
  hp: { label: "Current HP", apply: (c, v) => ((c.hp = Math.min(c.maxHp, intValue(v, 0, 9999))), `HP is now **${c.hp}/${c.maxHp}**.`) },
  ac: { label: "Armor Class", apply: (c, v) => ((c.ac = intValue(v, 1, 40)), `AC is now **${c.ac}**.`) },
  speed: { label: "Speed", apply: (c, v) => ((c.speed = intValue(v, 0, 300)), `Speed is now **${c.speed} ft**.`) },
  initiative: {
    label: "Extra initiative bonus",
    apply: (c, v) => ((c.initiativeBonus = intValue(v, -10, 20)), `Extra initiative bonus is now **${signed(c.initiativeBonus)}**.`),
  },
  xp: {
    label: "Experience points",
    apply: (c, v) => {
      const raw = v.trim();
      c.xp = Math.max(0, raw.startsWith("+") || raw.startsWith("-") ? c.xp + intValue(raw, -1e7, 1e7) : intValue(raw, 0, 1e7));
      const lvl = levelForXp(c.xp);
      return `XP is now **${c.xp}**.${lvl > c.level ? ` That's enough for level ${lvl}! Use \`/char set level ${lvl}\`.` : ""}`;
    },
  },
  inspiration: {
    label: "Inspiration (yes/no)",
    apply: (c, v) => ((c.inspiration = /^(y|yes|true|1|on)$/i.test(v.trim())), c.inspiration ? "Inspired! ★" : "Inspiration cleared."),
  },
  background: { label: "Background", apply: (c, v) => ((c.background = v.slice(0, 60)), "Background updated.") },
  alignment: { label: "Alignment", apply: (c, v) => ((c.alignment = v.slice(0, 40)), "Alignment updated.") },
  notes: { label: "Notes", apply: (c, v) => ((c.notes = v.slice(0, 1000)), "Notes updated.") },
  portrait: {
    label: "Portrait image URL",
    apply: (c, v) => {
      c.portraitUrl = imageUrl(v);
      return "Portrait updated.";
    },
  },
  condition: { label: "Add a condition", apply: (c, v) => (addCondition(c, v), `Added **${v}**.`) },
};

/** Validates an image link strictly enough that Discord will accept it as an embed thumbnail. */
function imageUrl(v: string): string {
  let url: URL;
  try {
    url = new URL(v.trim());
  } catch {
    throw new UserError("Portrait must be an https:// image link.");
  }
  if (url.protocol !== "https:" || !url.hostname.includes(".") || url.username || url.password || url.href.length > 1000) {
    throw new UserError("Portrait must be an https:// image link.");
  }
  return url.href;
}

function intValue(v: string, min: number, max: number): number {
  const n = Number(v.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new UserError(`"${v}" isn't a whole number.`);
  if (n < min || n > max) throw new UserError(`That must be between ${min} and ${max}.`);
  return n;
}

async function create(ctx: Ctx): Promise<Reply> {
  const existing = await listCharacters(ctx.store, ctx.guildId, ctx.userId);
  if (existing.length >= MAX_CHARACTERS) throw new UserError(`You already have ${MAX_CHARACTERS} characters here.`);
  const name = ctx.requireString("name");
  if (findOwnCharacter(existing, name)?.name.toLowerCase() === name.toLowerCase()) {
    throw new UserError(`You already have a character named **${name}**.`);
  }
  const abilities: Partial<Record<Ability, number>> = {};
  for (const a of ABILITIES) {
    const v = ctx.integer(a);
    if (v !== undefined) abilities[a] = v;
  }
  const input: Parameters<typeof createCharacter>[0] = {
    id: newCharacterId(),
    guildId: ctx.guildId,
    ownerId: ctx.userId,
    name,
    className: ctx.requireString("class"),
    abilities,
    now: ctx.now().toISOString(),
  };
  const species = ctx.string("species");
  if (species) input.species = species;
  const level = ctx.integer("level");
  if (level !== undefined) input.level = level;
  const hp = ctx.integer("hp");
  if (hp !== undefined) input.maxHp = hp;
  const ac = ctx.integer("ac");
  if (ac !== undefined) input.ac = ac;
  const c = createCharacter(input);
  await ctx.store.put(characterKey(c), c, "create");
  await setActive(ctx.store, ctx.guildId, ctx.userId, c.id);

  const tips = [
    "Next steps:",
    "• `/char prof` to add skill proficiencies",
    "• `/char attack-add` to add weapons (SRD weapons auto-fill)",
    "• `/char set` to change anything else",
  ];
  if (!classInfo(c.classKey)) tips.push(`• _${c.className}_ isn't an SRD class, so add saving throws with \`/char prof\`.`);
  return {
    content: `🎉 **${c.name}** is ready and is now your active character.\n${tips.join("\n")}`,
    embeds: [characterEmbed(c, ctx.userName)],
  };
}

async function sheet(ctx: Ctx): Promise<Reply> {
  const ephemeral = ctx.boolean("private") ?? false;
  const other = ctx.user_("user");
  if (other && other.id !== ctx.userId) {
    const c = await getActive(ctx.store, ctx.guildId, other.id);
    if (!c) throw new UserError(`${other.global_name ?? other.username} doesn't have an active character here.`);
    return { embeds: [characterEmbed(c, other.global_name ?? other.username)], ephemeral };
  }
  const name = ctx.string("name");
  let c: Character | undefined;
  if (name) {
    c = findOwnCharacter(await listCharacters(ctx.store, ctx.guildId, ctx.userId), name);
    if (!c) throw new UserError(`You don't have a character called **${name}**.`);
  } else {
    c = await requireActive(ctx.store, ctx.guildId, ctx.userId);
  }
  return { embeds: [characterEmbed(c, ctx.userName)], ephemeral };
}

async function list(ctx: Ctx): Promise<Reply> {
  const chars = await listCharacters(ctx.store, ctx.guildId, ctx.userId);
  if (!chars.length) return { content: "You don't have any characters here yet. Try `/char create`.", ephemeral: true };
  const activeId = (await getActiveId(ctx.store, ctx.guildId, ctx.userId)) ?? (chars.length === 1 ? chars[0]!.id : "");
  const lines = chars.map(
    (c) => `${c.id === activeId ? "▶️" : "▫️"} **${c.name}** — level ${c.level} ${c.species} ${c.className} · ${c.hp}/${c.maxHp} HP`,
  );
  return {
    embeds: [embed({ title: "Your characters", description: lines.join("\n"), footer: "Switch with /char use", color: COLORS.brand })],
    ephemeral: true,
  };
}

async function use(ctx: Ctx): Promise<Reply> {
  const name = ctx.requireString("name");
  const c = findOwnCharacter(await listCharacters(ctx.store, ctx.guildId, ctx.userId), name);
  if (!c) throw new UserError(`You don't have a character called **${name}**.`);
  await setActive(ctx.store, ctx.guildId, ctx.userId, c.id);
  return { content: `▶️ You're now playing **${c.name}**.`, ephemeral: true };
}

async function set(ctx: Ctx): Promise<Reply> {
  const field = ctx.requireString("field").toLowerCase().replace(/\s+/g, "");
  const def = Object.hasOwn(FIELDS, field) ? FIELDS[field] : undefined;
  if (!def) throw new UserError(`Unknown field "${field}". Pick one from the list.`);
  const value = ctx.requireString("value");
  const active = await requireActive(ctx.store, ctx.guildId, ctx.userId);
  const { char, result } = await editCharacter(ctx.store, active, (c) => def.apply(c, value), ctx.now());
  return { content: `✏️ **${char.name}**: ${result}`, ephemeral: false };
}

async function prof(ctx: Ctx): Promise<Reply> {
  const name = ctx.requireString("name");
  const type = ctx.string("type") ?? "proficient";
  const active = await requireActive(ctx.store, ctx.guildId, ctx.userId);
  const saveAbility = name.toLowerCase().startsWith("save:") ? parseAbility(name.slice(5)) : undefined;
  const skill = saveAbility ? undefined : parseSkill(name);
  const ability = saveAbility ?? (skill ? undefined : parseAbility(name));
  if (!skill && !ability) throw new UserError(`"${name}" isn't a skill or saving throw.`);

  const { char, result } = await editCharacter(
    ctx.store,
    active,
    (c) => {
      if (ability) {
        const label = `${ABILITY_NAMES[ability]} saving throws`;
        if (type === "remove") {
          c.saveProfs = c.saveProfs.filter((a) => a !== ability);
          return `no longer proficient in ${label}.`;
        }
        if (type === "expertise") throw new UserError("Expertise only applies to skills.");
        if (!c.saveProfs.includes(ability)) c.saveProfs.push(ability);
        return `proficient in ${label}.`;
      }
      const s = skill!;
      const label = SKILLS[s].name;
      c.skillProfs = c.skillProfs.filter((x) => x !== s);
      c.expertise = c.expertise.filter((x) => x !== s);
      if (type === "remove") return `no longer proficient in ${label}.`;
      c.skillProfs.push(s);
      if (type === "expertise") {
        c.expertise.push(s);
        return `has expertise in ${label}.`;
      }
      return `proficient in ${label}.`;
    },
    ctx.now(),
  );
  return { content: `🎓 **${char.name}** is ${result}` };
}

/** Builds an attack from an SRD weapon: finesse uses the better of STR/DEX, ranged uses DEX. */
export function weaponAttack(c: Character, weaponName: string) {
  const w = findWeapon(weaponName);
  if (!w || w.name.toLowerCase() !== weaponName.trim().toLowerCase()) return undefined;
  const finesse = w.properties.includes("Finesse");
  const ranged = w.category.includes("Ranged");
  const abilityMod = finesse ? Math.max(mod(c, "str"), mod(c, "dex")) : ranged ? mod(c, "dex") : mod(c, "str");
  const dmgMod = abilityMod === 0 ? "" : abilityMod > 0 ? `+${abilityMod}` : `${abilityMod}`;
  const notes = [w.range ? `range ${w.range}` : "", ...w.properties].filter(Boolean).join(", ");
  return {
    name: w.name,
    toHit: abilityMod + profBonus(c),
    damage: `${w.damage}${dmgMod} ${w.damageType}`,
    notes: w.twoHanded ? `${notes}; ${w.twoHanded}${dmgMod} two-handed` : notes,
  };
}

async function attackAdd(ctx: Ctx): Promise<Reply> {
  const name = ctx.requireString("name");
  const active = await requireActive(ctx.store, ctx.guildId, ctx.userId);
  const auto = weaponAttack(active, name);
  const toHit = ctx.integer("to_hit") ?? auto?.toHit;
  const damage = ctx.string("damage") ?? auto?.damage;
  if (toHit === undefined || !damage) {
    throw new UserError("Give `to_hit` and `damage` (e.g. `1d8+3 slashing`), or pick an SRD weapon from the list.");
  }
  try {
    parse(damage);
  } catch {
    throw new UserError(`I can't roll "${damage}". Use dice like \`1d8+3 slashing\`.`);
  }
  const notes = ctx.string("notes") ?? auto?.notes;
  const { char } = await editCharacter(
    ctx.store,
    active,
    (c) => {
      if (c.attacks.length >= 15) throw new UserError("That's a lot of attacks! Remove one first.");
      c.attacks = c.attacks.filter((a) => a.name.toLowerCase() !== name.toLowerCase());
      c.attacks.push({ name: auto?.name ?? name, toHit, damage, ...(notes ? { notes } : {}) });
    },
    ctx.now(),
  );
  return { content: `⚔️ **${char.name}** can now attack with **${auto?.name ?? name}** (${signed(toHit)}, ${damage}).` };
}

async function attackRemove(ctx: Ctx): Promise<Reply> {
  const name = ctx.requireString("name").toLowerCase();
  const active = await requireActive(ctx.store, ctx.guildId, ctx.userId);
  const { char, result } = await editCharacter(
    ctx.store,
    active,
    (c) => {
      const before = c.attacks.length;
      c.attacks = c.attacks.filter((a) => a.name.toLowerCase() !== name);
      return before !== c.attacks.length;
    },
    ctx.now(),
  );
  if (!result) throw new UserError(`${char.name} has no attack called "${name}".`);
  return { content: `🗑️ Removed that attack from **${char.name}**.`, ephemeral: true };
}

async function remove(ctx: Ctx): Promise<Reply> {
  if (!ctx.boolean("confirm")) throw new UserError("Set `confirm` to True to delete a character.");
  const name = ctx.requireString("name");
  const c = findOwnCharacter(await listCharacters(ctx.store, ctx.guildId, ctx.userId), name);
  if (!c) throw new UserError(`You don't have a character called **${name}**.`);
  await ctx.store.delete(characterKey(c));
  if ((await getActiveId(ctx.store, ctx.guildId, ctx.userId)) === c.id) {
    await ctx.store.delete(keys.activeCharacter(ctx.guildId, ctx.userId));
  }
  return { content: `🪦 Deleted **${c.name}**. Farewell, adventurer.`, ephemeral: true };
}

const SUBCOMMANDS: Record<string, (ctx: Ctx) => Promise<Reply>> = {
  create,
  sheet,
  list,
  use,
  set,
  prof,
  "attack-add": attackAdd,
  "attack-remove": attackRemove,
  delete: remove,
};

export async function characterNameChoices(ctx: Ctx, query: string): Promise<Choice[]> {
  const chars = await listCharacters(ctx.store, ctx.guildId, ctx.userId);
  const q = query.toLowerCase();
  return chars
    .filter((c) => c.name.toLowerCase().includes(q))
    .slice(0, 25)
    .map((c) => choice(`${c.name} (level ${c.level} ${c.className})`, c.id));
}

export const charCommand: CommandModule = {
  names: ["char"],
  async run(ctx) {
    const handler = SUBCOMMANDS[ctx.subcommand];
    if (!handler) throw new UserError("Unknown subcommand.");
    return handler(ctx);
  },
  async autocomplete(ctx) {
    const f = ctx.focused;
    if (!f) return [];
    const q = f.value.toLowerCase();
    switch (`${ctx.subcommand}.${f.name}`) {
      case "create.class":
        return CLASS_KEYS.filter((k) => k.includes(q) || !q)
          .map((k) => choice(CLASSES[k].name, k))
          .concat(q && !CLASS_KEYS.some((k) => k === q) ? [choice(`${f.value} (custom)`, f.value)] : []);
      case "create.species":
        return SPECIES.filter((s) => s.toLowerCase().includes(q))
          .map((s) => choice(s))
          .concat(q && !SPECIES.some((s) => s.toLowerCase() === q) ? [choice(`${f.value} (custom)`, f.value)] : []);
      case "sheet.name":
      case "use.name":
      case "delete.name":
        return characterNameChoices(ctx, q);
      case "set.field":
        return Object.entries(FIELDS)
          .filter(([k, d]) => k.includes(q) || d.label.toLowerCase().includes(q))
          .slice(0, 25)
          .map(([k, d]) => choice(`${d.label}`, k));
      case "prof.name": {
        const skills = SKILL_KEYS.map((k) => choice(`${SKILLS[k].name} (${SKILLS[k].ability.toUpperCase()})`, k));
        const saves = ABILITIES.map((a) => choice(`${ABILITY_NAMES[a]} saving throw`, `save:${a}`));
        return [...skills, ...saves].filter((c) => c.name.toLowerCase().includes(q)).slice(0, 25);
      }
      case "attack-add.name":
        return searchByName(WEAPONS, f.value, 25).map((w) => choice(`${w.name} (${w.damage} ${w.damageType})`, w.name));
      case "attack-remove.name": {
        const c = await getActive(ctx.store, ctx.guildId, ctx.userId);
        return (c?.attacks ?? []).filter((a) => a.name.toLowerCase().includes(q)).map((a) => choice(a.name));
      }
      default:
        return [];
    }
  },
};
