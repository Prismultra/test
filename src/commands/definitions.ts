import {
  ApplicationCommandOptionType as T,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  type APIApplicationCommandBasicOption,
  type APIApplicationCommandOption,
  type APIApplicationCommandOptionChoice,
  type APIApplicationCommandSubcommandOption,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord-api-types/v10";
import { ABILITIES, ABILITY_NAMES } from "../game/rules.js";

type Extra = Record<string, unknown>;

const opt = <O extends APIApplicationCommandBasicOption>(o: O) => o;

const str = (name: string, description: string, extra: Extra = {}) =>
  opt({ type: T.String, name, description, ...extra } as APIApplicationCommandBasicOption);
const int = (name: string, description: string, extra: Extra = {}) =>
  opt({ type: T.Integer, name, description, ...extra } as APIApplicationCommandBasicOption);
const bool = (name: string, description: string, extra: Extra = {}) =>
  opt({ type: T.Boolean, name, description, ...extra } as APIApplicationCommandBasicOption);
const userOpt = (name: string, description: string, extra: Extra = {}) =>
  opt({ type: T.User, name, description, ...extra } as APIApplicationCommandBasicOption);

const sub = (
  name: string,
  description: string,
  options: APIApplicationCommandBasicOption[] = [],
): APIApplicationCommandSubcommandOption => ({ type: T.Subcommand, name, description, options });

const choices = (pairs: [string, string][]): APIApplicationCommandOptionChoice<string>[] =>
  pairs.map(([name, value]) => ({ name, value }));

const REQUIRED = { required: true };
const AUTO = { autocomplete: true };

const mode = () =>
  str("mode", "Roll with advantage or disadvantage", {
    choices: choices([
      ["Normal", "normal"],
      ["Advantage", "advantage"],
      ["Disadvantage", "disadvantage"],
    ]),
  });
const privateOpt = () => bool("private", "Only you can see the result");
const abilityChoices = choices(ABILITIES.map((a) => [ABILITY_NAMES[a], a]));
const scores = ABILITIES.map((a) => int(a, `${ABILITY_NAMES[a]} score (default 10)`, { min_value: 1, max_value: 30 }));

const command = (
  name: string,
  description: string,
  options: APIApplicationCommandOption[] = [],
): RESTPostAPIChatInputApplicationCommandsJSONBody => ({
  type: ApplicationCommandType.ChatInput,
  name,
  description,
  options,
  integration_types: [ApplicationIntegrationType.GuildInstall],
  contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
});

export const COMMANDS: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  command("roll", "Roll dice, e.g. 2d6+3, 4d6dl1, 1d20+5 adv", [
    str("dice", "Dice expression (2d6+3, 4d6dl1, d20 adv, 8d6 fire)", { ...REQUIRED, max_length: 200 }),
    str("reason", "What the roll is for", { max_length: 100 }),
    mode(),
    int("repeat", "Roll it this many times (e.g. 6 for ability scores)", { min_value: 1, max_value: 20 }),
    privateOpt(),
  ]),

  command("char", "Create and manage your characters", [
    sub("create", "Create a new character", [
      str("name", "Character name", { ...REQUIRED, max_length: 64 }),
      str("class", "Class (SRD classes get automatic saves and spell slots)", { ...REQUIRED, ...AUTO, max_length: 40 }),
      str("species", "Species / race", { ...AUTO, max_length: 40 }),
      int("level", "Level 1-20 (default 1)", { min_value: 1, max_value: 20 }),
      ...scores,
      int("hp", "Max HP (default: calculated from class and CON)", { min_value: 1, max_value: 999 }),
      int("ac", "Armor class (default 10 + DEX)", { min_value: 1, max_value: 40 }),
    ]),
    sub("sheet", "Show a character sheet", [
      str("name", "Which of your characters (default: active)", AUTO),
      userOpt("user", "Show someone else's active character"),
      privateOpt(),
    ]),
    sub("list", "List your characters"),
    sub("use", "Switch your active character", [str("name", "Character", { ...REQUIRED, ...AUTO })]),
    sub("set", "Change a field on your active character", [
      str("field", "What to change", { ...REQUIRED, ...AUTO }),
      str("value", "New value", { ...REQUIRED, max_length: 1000 }),
    ]),
    sub("prof", "Add or remove a skill/save proficiency or expertise", [
      str("name", "Skill or saving throw", { ...REQUIRED, ...AUTO }),
      str("type", "Proficiency type (default: proficient)", {
        choices: choices([
          ["Proficient", "proficient"],
          ["Expertise", "expertise"],
          ["Remove", "remove"],
        ]),
      }),
    ]),
    sub("attack-add", "Add an attack (SRD weapons fill in automatically)", [
      str("name", "Attack or weapon name", { ...REQUIRED, ...AUTO, max_length: 60 }),
      int("to_hit", "Attack bonus (default: calculated for SRD weapons)", { min_value: -10, max_value: 30 }),
      str("damage", "Damage, e.g. 1d8+3 slashing", { max_length: 100 }),
      str("notes", "Notes (range, properties...)", { max_length: 200 }),
    ]),
    sub("attack-remove", "Remove an attack", [str("name", "Attack", { ...REQUIRED, ...AUTO })]),
    sub("delete", "Delete one of your characters", [
      str("name", "Character", { ...REQUIRED, ...AUTO }),
      bool("confirm", "Yes, really delete it", REQUIRED),
    ]),
  ]),

  command("check", "Roll an ability or skill check with your active character", [
    str("skill", "Skill or ability", { ...REQUIRED, ...AUTO }),
    mode(),
    int("bonus", "Extra bonus (Guidance, Bardic Inspiration...)", { min_value: -20, max_value: 20 }),
    int("dc", "Difficulty class, if you know it", { min_value: 1, max_value: 40 }),
    privateOpt(),
  ]),

  command("save", "Roll a saving throw with your active character", [
    str("ability", "Ability", { ...REQUIRED, choices: abilityChoices }),
    mode(),
    int("bonus", "Extra bonus", { min_value: -20, max_value: 20 }),
    int("dc", "Difficulty class, if you know it", { min_value: 1, max_value: 40 }),
    privateOpt(),
  ]),

  command("attack", "Attack with one of your character's attacks", [
    str("name", "Attack", { ...REQUIRED, ...AUTO }),
    str("target", "Target in the current combat (applies damage on a hit)", AUTO),
    mode(),
    int("bonus", "Extra to-hit bonus", { min_value: -20, max_value: 20 }),
  ]),

  command("hp", "Track your active character's hit points", [
    sub("damage", "Take damage", [
      int("amount", "Damage taken", { ...REQUIRED, min_value: 0, max_value: 9999 }),
      bool("crit", "It was a critical hit (matters at 0 HP)"),
    ]),
    sub("heal", "Regain hit points", [int("amount", "HP regained", { ...REQUIRED, min_value: 0, max_value: 9999 })]),
    sub("temp", "Gain temporary hit points", [int("amount", "Temp HP", { ...REQUIRED, min_value: 0, max_value: 999 })]),
    sub("set", "Set current HP directly", [int("amount", "Current HP", { ...REQUIRED, min_value: 0, max_value: 9999 })]),
    sub("show", "Show current HP"),
  ]),

  command("deathsave", "Roll a death saving throw"),

  command("rest", "Take a short or long rest", [
    str("type", "Rest type", {
      ...REQUIRED,
      choices: choices([
        ["Short rest", "short"],
        ["Long rest", "long"],
      ]),
    }),
    int("hit_dice", "Short rest: hit dice to spend", { min_value: 0, max_value: 20 }),
  ]),

  command("spell", "Look up spells and track spell slots", [
    sub("info", "Look up an SRD spell", [str("name", "Spell", { ...REQUIRED, ...AUTO }), privateOpt()]),
    sub("cast", "Cast a spell, spending a slot", [
      int("level", "Slot level (0 for a cantrip)", { ...REQUIRED, min_value: 0, max_value: 9 }),
      str("name", "Spell name", AUTO),
    ]),
    sub("slots", "Show your spell slots"),
  ]),

  command("monster", "Look up an SRD monster stat block", [
    str("name", "Monster", { ...REQUIRED, ...AUTO }),
    privateOpt(),
  ]),

  command("condition", "Look up a condition, or add/remove one on your character", [
    str("name", "Condition", { ...REQUIRED, ...AUTO }),
    str("action", "What to do (default: look it up)", {
      choices: choices([
        ["Look up", "info"],
        ["Add to my character", "add"],
        ["Remove from my character", "remove"],
      ]),
    }),
  ]),

  command("item", "Look up an SRD magic item, weapon or armor", [
    str("name", "Item", { ...REQUIRED, ...AUTO }),
    privateOpt(),
  ]),

  command("inv", "Manage your active character's inventory and coins", [
    sub("list", "Show inventory"),
    sub("add", "Add an item", [
      str("item", "Item name", { ...REQUIRED, ...AUTO, max_length: 80 }),
      int("qty", "Quantity (default 1)", { min_value: 1, max_value: 9999 }),
    ]),
    sub("remove", "Remove an item", [
      str("item", "Item name", { ...REQUIRED, ...AUTO }),
      int("qty", "Quantity (default 1)", { min_value: 1, max_value: 9999 }),
    ]),
    sub("coins", "Add or spend coins (negative to spend)", [
      int("gp", "Gold", { min_value: -1000000, max_value: 1000000 }),
      int("sp", "Silver", { min_value: -1000000, max_value: 1000000 }),
      int("cp", "Copper", { min_value: -1000000, max_value: 1000000 }),
      int("pp", "Platinum", { min_value: -1000000, max_value: 1000000 }),
    ]),
  ]),

  command("init", "Initiative and combat tracker for this channel", [
    sub("start", "Start a combat in this channel", [bool("show_monster_hp", "Show exact monster HP to everyone")]),
    sub("join", "Add your active character (rolls initiative)", [
      int("initiative", "Use this initiative instead of rolling", { min_value: -10, max_value: 50 }),
      mode(),
    ]),
    sub("add", "Add a custom combatant", [
      str("name", "Name", { ...REQUIRED, max_length: 40 }),
      int("bonus", "Initiative bonus", { min_value: -10, max_value: 20 }),
      int("initiative", "Use this initiative instead of rolling", { min_value: -10, max_value: 50 }),
      int("hp", "Hit points", { min_value: 1, max_value: 9999 }),
      int("ac", "Armor class", { min_value: 1, max_value: 40 }),
      int("count", "How many (default 1)", { min_value: 1, max_value: 20 }),
      bool("player", "This is a player character"),
    ]),
    sub("monster", "Add SRD monsters (rolls initiative and HP)", [
      str("name", "Monster", { ...REQUIRED, ...AUTO }),
      int("count", "How many (default 1)", { min_value: 1, max_value: 20 }),
      bool("average_hp", "Use average HP instead of rolling"),
      str("label", "Custom name, e.g. Cave Goblin", { max_length: 40 }),
    ]),
    sub("next", "Next turn"),
    sub("prev", "Previous turn"),
    sub("show", "Show the initiative order", [bool("private", "Only you can see it (shows monster HP and AC)")]),
    sub("damage", "Damage a combatant", [
      str("target", "Combatant", { ...REQUIRED, ...AUTO }),
      int("amount", "Damage", { ...REQUIRED, min_value: 0, max_value: 9999 }),
    ]),
    sub("heal", "Heal a combatant", [
      str("target", "Combatant", { ...REQUIRED, ...AUTO }),
      int("amount", "Healing", { ...REQUIRED, min_value: 0, max_value: 9999 }),
    ]),
    sub("condition", "Add or remove a condition on a combatant", [
      str("target", "Combatant", { ...REQUIRED, ...AUTO }),
      str("condition", "Condition", { ...REQUIRED, ...AUTO, max_length: 40 }),
      bool("remove", "Remove instead of add"),
    ]),
    sub("remove", "Remove a combatant", [str("target", "Combatant", { ...REQUIRED, ...AUTO })]),
    sub("end", "End the combat"),
  ]),

  command("act", "Tell the AI Dungeon Master what your character does", [
    str("action", "What you do or say", { ...REQUIRED, max_length: 1500 }),
  ]),

  command("dm", "Run a campaign with the AI Dungeon Master in this channel", [
    sub("start", "Start a new campaign in this channel", [
      str("premise", "Setting or premise (leave empty for a surprise)", { max_length: 1000 }),
      str("tone", "Tone of the story", {
        choices: choices([
          ["Classic heroic fantasy", "heroic"],
          ["Dark and gritty", "dark"],
          ["Lighthearted and funny", "lighthearted"],
          ["Horror", "horror"],
          ["Mystery and intrigue", "mystery"],
        ]),
      }),
      str("length", "How long the adventure should be", {
        choices: choices([
          ["One-shot (one session)", "one-shot"],
          ["Short adventure (a few sessions)", "short"],
          ["Ongoing campaign", "campaign"],
        ]),
      }),
    ]),
    sub("join", "Join the campaign with your active character"),
    sub("leave", "Leave the campaign"),
    sub("ask", "Ask the DM an out-of-character question (rules, recap, options)", [
      str("question", "Your question", { ...REQUIRED, max_length: 1000 }),
    ]),
    sub("recap", "Recap the story so far"),
    sub("status", "Show the campaign and party"),
    sub("end", "End the campaign in this channel", [bool("confirm", "Yes, end it", REQUIRED)]),
  ]),

  command("help", "How to use Tavernkeep"),
];
