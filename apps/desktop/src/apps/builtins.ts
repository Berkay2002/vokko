// Client-side slash commands (no route of their own): the text commands send a plain message made from the typed text, the action
// commands (/gif /msg /nick /thread) call existing routes (builtinActions.ts). They are synthetic ApplicationCommands of a sentinel
// application so the parser, matching and option chips treat them like any other command, and they work in every channel and DM
// where you can send (/nick and /thread only where they make sense: see BuiltinContext).
import { ApplicationCommandOptionType, ApplicationCommandType, type ApplicationCommand, type ApplicationCommandOption } from "../api/types";

export const BUILTIN_APP_ID = "builtin";
export const BUILTIN_APP_NAME = "Built-in";

/** Where the composer is: decides which built-ins are offered. */
export interface BuiltinContext {
  /** The channel belongs to a server (not a DM) and the viewer may change their nickname there. */
  nick: boolean;
  /** The viewer may create a thread in this channel and post in it. */
  threads: boolean;
  /** The viewer holds SEND_TTS_MESSAGES here and has "Allow playback and usage of /tts command" on. */
  tts: boolean;
}
/** Whether /tts is offered: unknown channel (not loaded yet) is hidden, not treated as a DM; DMs allow it, servers need SEND_TTS_MESSAGES. */
export function canOfferTts(playback: boolean, channel: { guild_id?: string | null } | undefined, canSendTts: boolean): boolean {
  return playback && !!channel && (!channel.guild_id || canSendTts);
}
export const ANY_CONTEXT: BuiltinContext = { nick: true, threads: true, tts: true };

interface BuiltinDef {
  name: string;
  description: string;
  options: ApplicationCommandOption[];
  /** Text commands: the message to send for the typed text (trimmed, maybe empty). */
  transform?(message: string): string;
  available?(context: BuiltinContext): boolean;
}

const S = ApplicationCommandOptionType.String;
const append = (suffix: string) => (message: string) => (message ? `${message} ${suffix}` : suffix);
const messageOption = (required: boolean): ApplicationCommandOption[] => [{ type: S, name: "message", description: "Your message", required }];

const DEFS: BuiltinDef[] = [
  { name: "gif", description: "Search for animated GIFs on the web.", options: [{ type: S, name: "query", description: "What to search for", required: true }] },
  { name: "me", description: "Displays text with emphasis.", options: messageOption(true), transform: m => `_${m}_` },
  {
    name: "msg",
    description: "Send a direct message to a user.",
    options: [
      { type: ApplicationCommandOptionType.User, name: "user", description: "The user to message", required: true },
      { type: S, name: "message", description: "Your message", required: true },
    ],
  },
  { name: "nick", description: "Changes your nickname on this server.", options: [{ type: S, name: "new_nick", description: "Your new nickname (empty resets it)" }], available: c => c.nick },
  { name: "shrug", description: "Appends ¯\\_(ツ)_/¯ to your message.", options: messageOption(false), transform: append("¯\\\\\\_(ツ)\\_/¯") }, // escaped for markdown, which then shows ¯\_(ツ)_/¯
  { name: "spoiler", description: "Marks your message as a spoiler.", options: messageOption(true), transform: m => `||${m}||` },
  { name: "tableflip", description: "Appends (╯°□°)╯︵ ┻━┻ to your message.", options: messageOption(false), transform: append("(╯°□°)╯︵ ┻━┻") },
  {
    name: "thread",
    description: "Creates a new thread and posts a message in it.",
    options: [
      { type: S, name: "name", description: "The name of the thread", required: true },
      { type: S, name: "message", description: "Your message", required: true },
    ],
    available: c => c.threads,
  },
  { name: "tts", description: "Sends a message that is read aloud to everyone viewing the channel.", options: messageOption(true), transform: m => m, available: c => c.tts },
  { name: "unflip", description: "Appends ┬─┬ノ( º _ ºノ) to your message.", options: messageOption(false), transform: append("┬─┬ノ( º _ ºノ)") },
];

const commandOf = (d: BuiltinDef): ApplicationCommand => ({
  id: `${BUILTIN_APP_ID}:${d.name}`,
  type: ApplicationCommandType.ChatInput,
  application_id: BUILTIN_APP_ID,
  guild_id: null,
  name: d.name,
  description: d.description,
  options: d.options,
  default_member_permissions: null,
  version: "1",
});

export const BUILTIN_COMMANDS: ApplicationCommand[] = DEFS.map(commandOf);

export function isBuiltin(command: Pick<ApplicationCommand, "application_id">): boolean {
  return command.application_id === BUILTIN_APP_ID;
}

/** A built-in with one option takes the text after its name as that option (`/shrug hi`, `/nick Bob`, `/gif cats`). */
export function takesFreeText(command: ApplicationCommand): boolean {
  return isBuiltin(command) && command.options?.length === 1;
}

/** The built-ins offered here that an app command does not shadow: an app command with the same name wins. */
export function builtinsFor(commands: readonly ApplicationCommand[], context: BuiltinContext = ANY_CONTEXT): ApplicationCommand[] {
  const taken = new Set(commands.filter(c => c.type === ApplicationCommandType.ChatInput).map(c => c.name));
  return DEFS.filter(d => !taken.has(d.name) && (d.available?.(context) ?? true)).map(commandOf);
}

/** The channel's commands plus the built-ins nobody shadows. */
export function withBuiltins(commands: readonly ApplicationCommand[], context: BuiltinContext = ANY_CONTEXT): ApplicationCommand[] {
  return [...commands, ...builtinsFor(commands, context)];
}

/** The message a text built-in sends for `message`, or null when a required message is empty (or the command is an action). */
export function builtinContent(name: string, message: string): string | null {
  const def = DEFS.find(d => d.name === name);
  const text = message.trim();
  if (!def?.transform || (def.options[0]?.required && text === "")) return null;
  return def.transform(text);
}

/** /gif /msg /nick /thread: they run an action instead of sending the typed text. */
export function isActionBuiltin(name: string): boolean {
  return DEFS.some(d => d.name === name && !d.transform);
}
