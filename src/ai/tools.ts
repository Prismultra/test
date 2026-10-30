import {
  addCondition,
  addItem,
  adjustCoins,
  applyDamage,
  coinsText,
  heal,
  initiativeMod,
  removeCondition,
  removeItem,
  setTempHp,
  type Character,
  type Coins,
} from "../game/character.js";
import {
  MAX_COMBATANTS,
  addCombatant,
  addMonsters,
  createCombat,
  current,
  damageCombatant,
  findCombatant,
  healCombatant,
  isDown,
  nextTurn,
  pushLog,
  removeCombatant,
  renderOrder,
} from "../game/combat.js";
import { DiceError, formatBreakdown, roll, type Rng, type RollMode } from "../game/dice.js";
import { ABILITY_NAMES, SKILLS, abilityMod, parseAbility, parseSkill, signed } from "../game/rules.js";
import { crText, findCondition, findMagicItem, findMonster, findSpell, findWeapon, normalize } from "../srd/index.js";
import { keys, type Store } from "../store/store.js";
import { editCharacter } from "../commands/characters.js";
import { editCombat, getCombat, syncCharacterToCombat } from "../commands/combat-store.js";
import { MAX_NOTES, newId, type Campaign, type PendingRoll, type RollKind } from "./campaign.js";
import type { BetaTool } from "./model.js";
import type { PartySheet } from "./prompt.js";

const characterProp = { type: "string", description: "Character name, exactly as on the party list" };

export const DM_TOOLS: BetaTool[] = [
  {
    name: "roll_dice",
    description:
      "Roll dice for NPCs, monsters or random outcomes (attacks, damage, saves, checks, tables). Players see the result. Supports NdS, + and -, kh/kl (keep highest/lowest), e.g. 1d20+4, 2d6+3, 2d20kh1+5.",
    input_schema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Dice expression, e.g. 1d20+4" },
        reason: { type: "string", description: "Short label shown to players, e.g. 'Goblin A scimitar attack vs Mira'" },
      },
      required: ["expression", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "request_roll",
    description:
      "Ask a player to roll for their character. They get a button and their sheet's modifiers apply. You receive the result on your next turn, so stop narrating at the moment of the roll. For attacks, set dc to the target's AC.",
    input_schema: {
      type: "object",
      properties: {
        character: characterProp,
        type: { type: "string", enum: ["skill", "ability", "save", "attack"] },
        name: {
          type: "string",
          description: "Skill (e.g. stealth, perception), ability (str, dex, con, int, wis, cha) or the attack's name from the sheet",
        },
        dc: { type: "integer", description: "Hidden DC, or the target's AC for attacks" },
        advantage: { type: "string", enum: ["normal", "advantage", "disadvantage"] },
        reason: { type: "string", description: "What the roll is for, shown to the player" },
      },
      required: ["character", "type", "name", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "update_character",
    description:
      "Change a party member's sheet: HP (negative for damage, positive for healing), temp HP, conditions, items, coins, XP, inspiration. Always use this so the sheets stay accurate.",
    input_schema: {
      type: "object",
      properties: {
        character: characterProp,
        hp_change: { type: "integer", description: "Negative = damage (temp HP absorbs first), positive = healing" },
        critical: { type: "boolean", description: "The damage came from a critical hit (matters at 0 HP)" },
        temp_hp: { type: "integer", description: "Grant temporary hit points (doesn't stack; keeps the higher)" },
        add_conditions: { type: "array", items: { type: "string" } },
        remove_conditions: { type: "array", items: { type: "string" } },
        add_items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, qty: { type: "integer" } },
            required: ["name"],
            additionalProperties: false,
          },
        },
        remove_items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, qty: { type: "integer" } },
            required: ["name"],
            additionalProperties: false,
          },
        },
        coins: {
          type: "object",
          description: "Coins gained (positive) or spent (negative)",
          properties: { pp: { type: "integer" }, gp: { type: "integer" }, sp: { type: "integer" }, cp: { type: "integer" } },
          additionalProperties: false,
        },
        xp: { type: "integer", description: "XP to award" },
        inspiration: { type: "boolean" },
      },
      required: ["character"],
      additionalProperties: false,
    },
  },
  {
    name: "lookup_rules",
    description: "Look up exact SRD 5.1 rules text: a monster stat block, spell, condition or item.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["monster", "spell", "condition", "item"] },
        name: { type: "string" },
      },
      required: ["kind", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "start_combat",
    description:
      "Start a fight (or add enemies to the current one). Adds every party member, rolls initiative and shows the tracker. Use SRD monster names where they fit; for custom foes give hp, ac and initiative_bonus.",
    input_schema: {
      type: "object",
      properties: {
        enemies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Display name, e.g. 'Bandit' or 'Captain Vex'" },
              srd_monster: { type: "string", description: "SRD monster to use for stats, e.g. 'bandit', 'goblin', 'ogre'" },
              count: { type: "integer" },
              hp: { type: "integer" },
              ac: { type: "integer" },
              initiative_bonus: { type: "integer" },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      required: ["enemies"],
      additionalProperties: false,
    },
  },
  {
    name: "update_combatant",
    description: "Damage, heal, add/remove a condition on, or remove a combatant in the current fight (usually an enemy).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Combatant name as in the initiative order, e.g. 'Goblin B'" },
        damage: { type: "integer" },
        heal: { type: "integer" },
        add_condition: { type: "string" },
        remove_condition: { type: "string" },
        remove: { type: "boolean", description: "Take them out of the initiative order (fled, surrendered, gone)" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "next_turn",
    description: "Advance the initiative tracker to the next combatant. Returns whose turn it is.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "end_combat",
    description: "End the current fight and remove the tracker.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "update_story",
    description:
      "Record long-term memory: set the adventure title, current scene/location and quest, and add short notes about facts you'll need later (NPCs, clues, promises, loot).",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        scene: { type: "string" },
        quest: { type: "string" },
        remember: { type: "array", items: { type: "string" }, description: "New short notes to keep" },
        forget: { type: "array", items: { type: "string" }, description: "Notes that are no longer true (exact text)" },
      },
      additionalProperties: false,
    },
  },
];

/** State shared by the tools during one DM turn. */
export interface ToolContext {
  store: Store;
  campaign: Campaign;
  party: PartySheet[];
  batch: string;
  now: Date;
  /** Rolls the DM made, shown under the narration. */
  dmRolls: string[];
  requestedRolls: PendingRoll[];
  combatChanged: boolean;
  rng?: Rng;
}

type Input = Record<string, unknown>;

const str = (i: Input, k: string) => (typeof i[k] === "string" ? (i[k] as string).trim() : undefined);
const int = (i: Input, k: string) => (typeof i[k] === "number" && Number.isFinite(i[k]) ? Math.trunc(i[k] as number) : undefined);
const bool = (i: Input, k: string) => (typeof i[k] === "boolean" ? (i[k] as boolean) : undefined);
const strArray = (i: Input, k: string) =>
  Array.isArray(i[k]) ? (i[k] as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
const itemArray = (i: Input, k: string) =>
  Array.isArray(i[k])
    ? (i[k] as unknown[]).flatMap((x) => {
        if (!x || typeof x !== "object") return [];
        const o = x as Input;
        const name = str(o, "name");
        return name ? [{ name, qty: Math.max(1, int(o, "qty") ?? 1) }] : [];
      })
    : [];

export class ToolError extends Error {}

function findPartyMember(ctx: ToolContext, name: string | undefined): PartySheet {
  if (!name) throw new ToolError("Missing character name.");
  const raw = name.trim().toLowerCase();
  const q = normalize(name);
  const norm = (x: string) => normalize(x);
  const hit =
    ctx.party.find((p) => p.character.name.trim().toLowerCase() === raw) ??
    (q
      ? (ctx.party.find((p) => norm(p.character.name) === q) ??
        ctx.party.find((p) => {
          const n = norm(p.character.name);
          return n !== "" && (n.startsWith(q) || q.startsWith(n));
        }) ??
        ctx.party.find((p) => norm(p.playerName) === q))
      : undefined);
  if (!hit) {
    throw new ToolError(`No party member called "${name}". Party: ${ctx.party.map((p) => p.character.name).join(", ") || "(empty)"}.`);
  }
  return hit;
}

export async function runTool(ctx: ToolContext, name: string, input: Input): Promise<string> {
  switch (name) {
    case "roll_dice":
      return rollDice(ctx, input);
    case "request_roll":
      return requestRoll(ctx, input);
    case "update_character":
      return updateCharacter(ctx, input);
    case "lookup_rules":
      return lookupRules(input);
    case "start_combat":
      return startCombat(ctx, input);
    case "update_combatant":
      return updateCombatant(ctx, input);
    case "next_turn":
      return advanceTurn(ctx);
    case "end_combat":
      return endCombat(ctx);
    case "update_story":
      return updateStory(ctx, input);
    default:
      throw new ToolError(`Unknown tool ${name}.`);
  }
}

function rollDice(ctx: ToolContext, input: Input): string {
  const expression = str(input, "expression");
  const reason = str(input, "reason") ?? "Roll";
  if (!expression) throw new ToolError("Missing expression.");
  try {
    const r = roll(expression, ctx.rng ? { rng: ctx.rng } : {});
    ctx.dmRolls.push(`**${reason}:** \`${r.notation}\` → ${formatBreakdown(r)} = **${r.total}**${r.natural === 20 ? " ✨" : r.natural === 1 ? " 💀" : ""}`);
    const nat = r.natural !== undefined ? ` (natural ${r.natural})` : "";
    return `${reason}: ${r.total}${nat} [${formatBreakdown(r).replace(/\*|~/g, "")}]`;
  } catch (err) {
    if (err instanceof DiceError) throw new ToolError(err.message);
    throw err;
  }
}

function requestRoll(ctx: ToolContext, input: Input): string {
  const member = findPartyMember(ctx, str(input, "character"));
  const c = member.character;
  const type = str(input, "type") as RollKind | undefined;
  const what = str(input, "name") ?? "";
  const reason = str(input, "reason") ?? "";
  const dc = int(input, "dc");
  const adv = str(input, "advantage");
  const mode: RollMode = adv === "advantage" || adv === "disadvantage" ? adv : "normal";

  let key: string;
  let label: string;
  if (type === "skill") {
    const skill = parseSkill(what);
    if (!skill) {
      const ability = parseAbility(what);
      if (!ability) throw new ToolError(`"${what}" isn't a skill.`);
      return requestRoll(ctx, { ...input, type: "ability" });
    }
    key = skill;
    label = SKILLS[skill].name;
  } else if (type === "ability" || type === "save") {
    const ability = parseAbility(what);
    if (!ability) throw new ToolError(`"${what}" isn't an ability (use str, dex, con, int, wis or cha).`);
    key = ability;
    label = type === "save" ? `${ABILITY_NAMES[ability]} save` : `${ABILITY_NAMES[ability]} check`;
  } else if (type === "attack") {
    const q = normalize(what);
    const atk =
      c.attacks.find((a) => normalize(a.name) === q) ??
      c.attacks.find((a) => normalize(a.name).includes(q) || q.includes(normalize(a.name)));
    if (atk) {
      key = atk.name;
      label = `${atk.name} attack`;
    } else {
      // No matching attack on the sheet: fall back to an SRD weapon, or the character's best ability.
      const weapon = findWeapon(what);
      key = weapon && normalize(weapon.name) === q ? `weapon:${weapon.name}` : `improvised:${what || "attack"}`;
      label = `${weapon && normalize(weapon.name) === q ? weapon.name : what || "Attack"} attack`;
    }
  } else {
    throw new ToolError('type must be "skill", "ability", "save" or "attack".');
  }

  if (ctx.requestedRolls.length >= 10) throw new ToolError("Too many roll requests in one turn.");
  const pending: PendingRoll = {
    id: newId(),
    batch: ctx.batch,
    userId: ctx.campaign.party.find((p) => p.characterId === c.id)?.userId ?? c.ownerId,
    characterId: c.id,
    characterName: c.name,
    kind: type,
    key,
    label,
    mode,
    reason,
  };
  if (dc !== undefined) pending.dc = dc;
  ctx.requestedRolls.push(pending);
  return `Requested a ${label}${mode !== "normal" ? ` with ${mode}` : ""} from ${c.name}. Stop at the moment of the roll; you'll get the result next turn.`;
}

async function updateCharacter(ctx: ToolContext, input: Input): Promise<string> {
  const member = findPartyMember(ctx, str(input, "character"));
  const changes: string[] = [];
  const { char } = await editCharacter(
    ctx.store,
    member.character,
    (c) => {
      changes.length = 0; // The edit may be retried after a conflict.
      const hp = int(input, "hp_change");
      if (hp !== undefined && hp < 0) {
        const out = applyDamage(c, -hp, { critical: bool(input, "critical") ?? false });
        changes.push(`took ${-hp} damage${out.absorbedByTemp ? ` (${out.absorbedByTemp} to temp HP)` : ""}`);
        if (out.instantDeath) changes.push("massive damage: instant death");
        else if (out.droppedToZero) changes.push("dropped to 0 HP and is unconscious");
        if (out.deathSaveFailures) changes.push(`${out.deathSaveFailures} death save failure(s)`);
      } else if (hp !== undefined && hp > 0) {
        changes.push(`healed ${heal(c, hp)}`);
      }
      const temp = int(input, "temp_hp");
      if (temp !== undefined) {
        setTempHp(c, temp);
        changes.push(`temp HP now ${c.tempHp}`);
      }
      for (const cond of strArray(input, "add_conditions")) {
        addCondition(c, cond);
        changes.push(`now ${cond}`);
      }
      for (const cond of strArray(input, "remove_conditions")) {
        if (removeCondition(c, cond)) changes.push(`no longer ${cond}`);
      }
      for (const item of itemArray(input, "add_items")) {
        if (c.inventory.length < 100) {
          addItem(c, item.name, item.qty);
          changes.push(`gained ${item.qty > 1 ? `${item.qty}× ` : ""}${item.name}`);
        }
      }
      for (const item of itemArray(input, "remove_items")) {
        const out = removeItem(c, item.name, item.qty);
        changes.push(out ? `lost ${out.removed}× ${item.name}` : `doesn't have ${item.name}`);
      }
      const coins = input.coins && typeof input.coins === "object" ? (input.coins as Input) : undefined;
      if (coins) {
        const delta: Partial<Coins> = {};
        for (const k of ["pp", "gp", "sp", "cp"] as const) {
          const v = int(coins, k);
          if (v) delta[k] = v;
        }
        if (Object.keys(delta).length) {
          changes.push(adjustCoins(c, delta) ? `coins now ${coinsText(c.coins)}` : `can't afford that (has ${coinsText(c.coins)})`);
        }
      }
      const xp = int(input, "xp");
      if (xp) {
        c.xp = Math.max(0, c.xp + xp);
        changes.push(`gained ${xp} XP (total ${c.xp})`);
      }
      const insp = bool(input, "inspiration");
      if (insp !== undefined) {
        c.inspiration = insp;
        changes.push(insp ? "gained inspiration" : "spent inspiration");
      }
    },
    ctx.now,
  );
  member.character = char;
  await syncCharacterToCombat(ctx.store, ctx.campaign.channelId, char);
  if (changes.length) ctx.dmRolls.push(`📝 **${char.name}** ${changes.join(", ")}.`);
  return `${char.name}: ${changes.join("; ") || "no changes"}. Now HP ${char.hp}/${char.maxHp}${char.tempHp ? ` (+${char.tempHp} temp)` : ""}${char.conditions.length ? `, conditions: ${char.conditions.join(", ")}` : ""}.`;
}

function lookupRules(input: Input): string {
  const kind = str(input, "kind");
  const name = str(input, "name") ?? "";
  const clip = (s: string, n = 3000) => (s.length > n ? `${s.slice(0, n)}…` : s);
  if (kind === "monster") {
    const m = findMonster(name);
    if (!m) throw new ToolError(`No SRD monster "${name}".`);
    const abil = ["STR", "DEX", "CON", "INT", "WIS", "CHA"].map((a, i) => `${a} ${m.abilities[i]} (${signed(abilityMod(m.abilities[i]!))})`);
    return clip(
      [
        `${m.name}: ${m.size} ${m.type}, ${m.alignment}. AC ${m.ac}${m.acNote ? ` (${m.acNote})` : ""}, HP ${m.hp} (${m.hpRoll}), speed ${m.speed.replace(/\.$/, "")}. CR ${crText(m.cr)} (${m.xp} XP).`,
        abil.join(", "),
        [m.saves && `Saves ${m.saves}`, m.skills && `Skills ${m.skills}`, m.resistances && `Resist ${m.resistances}`, m.immunities && `Immune ${m.immunities}`, m.conditionImmunities && `Condition immunities ${m.conditionImmunities}`, `Senses ${m.senses}`]
          .filter(Boolean)
          .join(". "),
        m.traits.map((t) => `Trait — ${t.name}: ${t.desc}`).join("\n"),
        m.actions.map((a) => `Action — ${a.name}: ${a.desc}`).join("\n"),
        m.reactions.map((a) => `Reaction — ${a.name}: ${a.desc}`).join("\n"),
        m.legendary.map((a) => `Legendary — ${a.name}: ${a.desc}`).join("\n"),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  if (kind === "spell") {
    const s = findSpell(name);
    if (!s) throw new ToolError(`No SRD spell "${name}".`);
    return clip(
      `${s.name}: ${s.level === 0 ? "cantrip" : `level ${s.level}`} ${s.school}. ${s.castingTime}, range ${s.range}, ${s.components}, ${s.duration}${s.concentration ? " (concentration)" : ""}.\n${s.desc}${s.higherLevel ? `\nAt higher levels: ${s.higherLevel}` : ""}`,
    );
  }
  if (kind === "condition") {
    const c = findCondition(name);
    if (!c) throw new ToolError(`No SRD condition "${name}".`);
    return `${c.name}:\n${c.desc}`;
  }
  if (kind === "item") {
    const i = findMagicItem(name);
    if (i) return clip(`${i.name} (${i.rarity}): ${i.desc}`);
    const w = findWeapon(name);
    if (w) return `${w.name}: ${w.category} weapon, ${w.damage} ${w.damageType}${w.twoHanded ? ` (${w.twoHanded} two-handed)` : ""}, ${w.properties.join(", ") || "no properties"}${w.range ? `, range ${w.range}` : ""}, ${w.cost}.`;
    throw new ToolError(`No SRD item "${name}".`);
  }
  throw new ToolError('kind must be "monster", "spell", "condition" or "item".');
}

async function startCombat(ctx: ToolContext, input: Input): Promise<string> {
  const enemies = Array.isArray(input.enemies) ? (input.enemies as Input[]).filter((e) => e && typeof e === "object") : [];
  const channelId = ctx.campaign.channelId;
  const existing = await getCombat(ctx.store, channelId);
  if (!existing) {
    const combat = createCombat({ channelId, guildId: ctx.campaign.guildId, createdBy: "dm", now: ctx.now.toISOString() });
    await ctx.store.put(keys.combat(channelId), combat, "create");
  }
  const unknown: string[] = [];
  const { combat } = await editCombat(
    ctx.store,
    channelId,
    (cb) => {
      unknown.length = 0; // The edit may be retried after a conflict.
      const room = MAX_COMBATANTS - cb.combatants.length;
      const wanted =
        ctx.party.filter((p) => !cb.combatants.some((x) => x.characterId === p.character.id)).length +
        enemies.reduce((n, e) => n + Math.min(10, Math.max(1, int(e, "count") ?? 1)), 0);
      if (wanted > room) throw new ToolError(`That's too many combatants (max ${MAX_COMBATANTS}). Use fewer enemies.`);
      for (const p of ctx.party) {
        const c = p.character;
        if (cb.combatants.some((x) => x.characterId === c.id)) continue;
        addCombatant(cb, partyCombatant(c), ctx.rng);
      }
      for (const e of enemies) {
        const name = str(e, "name") || "Enemy";
        const count = Math.min(10, Math.max(1, int(e, "count") ?? 1));
        const srd = findMonster(str(e, "srd_monster") ?? name);
        const exact = srd && (normalize(srd.name) === normalize(str(e, "srd_monster") ?? "") || normalize(srd.name) === normalize(name));
        if (srd && exact) {
          const added = addMonsters(cb, srd, count, { rollHp: true, name, ...(ctx.rng ? { rng: ctx.rng } : {}) });
          const hp = int(e, "hp");
          const ac = int(e, "ac");
          for (const x of added) {
            if (hp) Object.assign(x, { hp, maxHp: hp });
            if (ac) x.ac = ac;
          }
        } else {
          if (int(e, "hp") === undefined) unknown.push(name);
          const hp = Math.max(1, int(e, "hp") ?? 11);
          for (let i = 0; i < count; i++) {
            addCombatant(
              cb,
              {
                name: count > 1 ? `${name} ${String.fromCharCode(65 + i)}` : name,
                initBonus: int(e, "initiative_bonus") ?? 0,
                isPlayer: false,
                hp,
                maxHp: hp,
                ac: int(e, "ac") ?? 12,
              },
              ctx.rng,
            );
          }
        }
      }
      pushLog(cb, "Roll for initiative!");
    },
    ctx.now,
  );
  ctx.combatChanged = true;
  const who = current(combat);
  return `Combat started. Initiative order (round ${combat.round}):\n${plainOrder(combat)}\n${who ? `It's ${who.name}'s turn.` : ""}${unknown.length ? `\nNo stats given for ${unknown.join(", ")}: used 11 HP, AC 12.` : ""}`;
}

function partyCombatant(c: Character) {
  return {
    name: c.name,
    initBonus: initiativeMod(c),
    isPlayer: true,
    hp: c.hp,
    maxHp: c.maxHp,
    ac: c.ac,
    ownerId: c.ownerId,
    characterId: c.id,
    conditions: [...c.conditions],
  };
}

const plainOrder = (combat: Parameters<typeof renderOrder>[0]) =>
  renderOrder(combat, { revealHp: true }).replace(/[*`_]/g, "").replace(/▶️/g, "→").replace(/▫️|💀/g, " ");

async function updateCombatant(ctx: ToolContext, input: Input): Promise<string> {
  const name = str(input, "name") ?? "";
  const dmg = int(input, "damage");
  const healing = int(input, "heal");
  const before = await getCombat(ctx.store, ctx.campaign.channelId);
  if (!before) throw new ToolError("There's no combat running. Use start_combat first.");
  const found = findCombatant(before, name);
  if (!found) throw new ToolError(`No combatant "${name}". Order:\n${plainOrder(before)}`);

  // Player characters: change the sheet (temp HP, death saves) and mirror it onto the tracker.
  const member = found.characterId ? ctx.party.find((p) => p.character.id === found.characterId) : undefined;
  if (member && (dmg || healing)) {
    const { char } = await editCharacter(
      ctx.store,
      member.character,
      (c) => {
        if (dmg) applyDamage(c, dmg);
        if (healing) heal(c, healing);
      },
      ctx.now,
    );
    member.character = char;
    await syncCharacterToCombat(ctx.store, ctx.campaign.channelId, char);
  }

  const { combat, result } = await editCombat(
    ctx.store,
    ctx.campaign.channelId,
    (cb) => {
      const t = cb.combatants.find((x) => x.id === found.id);
      if (!t) throw new ToolError(`${found.name} is no longer in the fight.`);
      const notes: string[] = [];
      if (dmg) {
        if (!member) damageCombatant(t, dmg);
        notes.push(`took ${dmg} damage`);
      }
      if (healing) {
        if (!member) healCombatant(t, healing);
        notes.push(`healed ${healing}`);
      }
      const add = str(input, "add_condition");
      if (add) {
        t.conditions = t.conditions.filter((x) => x.toLowerCase() !== add.toLowerCase()).concat(add);
        notes.push(`now ${add}`);
      }
      const rem = str(input, "remove_condition");
      if (rem) {
        t.conditions = t.conditions.filter((x) => x.toLowerCase() !== rem.toLowerCase());
        notes.push(`no longer ${rem}`);
      }
      if (bool(input, "remove")) {
        removeCombatant(cb, t.id);
        notes.push("removed from combat");
      } else if (isDown(t)) notes.push("is down");
      pushLog(cb, `${t.name} ${notes.join(", ")}.`);
      return { t, notes };
    },
    ctx.now,
  );
  ctx.combatChanged = true;
  const { t, notes } = result;
  if (notes.length) ctx.dmRolls.push(`📝 **${t.name}** ${notes.join(", ")}.`);
  return `${t.name}: ${notes.join(", ") || "no change"}${t.hp !== undefined ? ` (HP ${t.hp}/${t.maxHp})` : ""}.\nOrder:\n${plainOrder(combat)}`;
}

async function advanceTurn(ctx: ToolContext): Promise<string> {
  const { combat, result: who } = await editCombat(
    ctx.store,
    ctx.campaign.channelId,
    (cb) => {
      const w = nextTurn(cb);
      if (w) pushLog(cb, `Round ${cb.round}: ${w.name}'s turn.`);
      return w;
    },
    ctx.now,
  );
  ctx.combatChanged = true;
  if (!who) return "There are no combatants.";
  const player = who.isPlayer ? ` (a player character${isDown(who) ? " at 0 HP: they roll a death save" : ""})` : "";
  return `Round ${combat.round}: it's ${who.name}'s turn${player}.`;
}

async function endCombat(ctx: ToolContext): Promise<string> {
  const combat = await getCombat(ctx.store, ctx.campaign.channelId);
  if (!combat) return "There was no combat running.";
  await ctx.store.delete(keys.combat(ctx.campaign.channelId));
  ctx.combatChanged = true;
  ctx.dmRolls.push(`🏁 Combat ended after ${combat.round} round${combat.round === 1 ? "" : "s"}.`);
  return "Combat ended.";
}

function updateStory(ctx: ToolContext, input: Input): string {
  const c = ctx.campaign;
  const changed: string[] = [];
  const title = str(input, "title");
  if (title) {
    c.title = title.slice(0, 100);
    changed.push("title");
  }
  const scene = str(input, "scene");
  if (scene) {
    c.scene = scene.slice(0, 200);
    changed.push("scene");
  }
  const quest = str(input, "quest");
  if (quest) {
    c.quest = quest.slice(0, 300);
    changed.push("quest");
  }
  const forget = new Set(strArray(input, "forget").map((n) => n.toLowerCase()));
  if (forget.size) c.notes = c.notes.filter((n) => !forget.has(n.toLowerCase()));
  for (const note of strArray(input, "remember")) {
    if (!c.notes.some((n) => n.toLowerCase() === note.toLowerCase())) c.notes.push(note.slice(0, 240));
  }
  if (c.notes.length > MAX_NOTES) c.notes.splice(0, c.notes.length - MAX_NOTES);
  return `Story updated (${[...changed, forget.size ? "forgot notes" : "", strArray(input, "remember").length ? "notes" : ""].filter(Boolean).join(", ") || "nothing"}). ${c.notes.length} notes kept.`;
}
