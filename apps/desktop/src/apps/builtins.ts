// Client-side slash commands (no route): they send a plain message made from the typed text, so they work in every channel
// and DM where you can send. They are synthetic ApplicationCommands of a sentinel application so the parser, matching and option
// chips treat them like any other command.
import { ApplicationCommandOptionType, ApplicationCommandType, type ApplicationCommand } from "../api/types";

export const BUILTIN_APP_ID = "builtin";
export const BUILTIN_APP_NAME = "Built-in";

interface BuiltinDef {
  name: string;
  description: string;
  required: boolean;
  /** The message to send for the typed text (trimmed, maybe empty). */
  transform(message: string): string;
}

const append = (suffix: string) => (message: string) => (message ? `${message} ${suffix}` : suffix);

const DEFS: BuiltinDef[] = [
  { name: "me", description: "Displays text with emphasis.", required: true, transform: m => `_${m}_` },
  { name: "shrug", description: "Appends ¯\\_(ツ)_/¯ to your message.", required: false, transform: append("¯\\\\\\_(ツ)\\_/¯") }, // escaped for markdown, which then shows ¯\_(ツ)_/¯
  { name: "spoiler", description: "Marks your message as a spoiler.", required: true, transform: m => `||${m}||` },
  { name: "tableflip", description: "Appends (╯°□°)╯︵ ┻━┻ to your message.", required: false, transform: append("(╯°□°)╯︵ ┻━┻") },
  { name: "unflip", description: "Appends ┬─┬ノ( º _ ºノ) to your message.", required: false, transform: append("┬─┬ノ( º _ ºノ)") },
];

export const BUILTIN_COMMANDS: ApplicationCommand[] = DEFS.map(d => ({
  id: `${BUILTIN_APP_ID}:${d.name}`,
  type: ApplicationCommandType.ChatInput,
  application_id: BUILTIN_APP_ID,
  guild_id: null,
  name: d.name,
  description: d.description,
  options: [{ type: ApplicationCommandOptionType.String, name: "message", description: "Your message", required: d.required }],
  default_member_permissions: null,
  version: "1",
}));

export function isBuiltin(command: Pick<ApplicationCommand, "application_id">): boolean {
  return command.application_id === BUILTIN_APP_ID;
}

/** The built-ins an app command does not shadow: an app command with the same name wins. */
export function builtinsFor(commands: readonly ApplicationCommand[]): ApplicationCommand[] {
  const taken = new Set(commands.filter(c => c.type === ApplicationCommandType.ChatInput).map(c => c.name));
  return BUILTIN_COMMANDS.filter(c => !taken.has(c.name));
}

/** The channel's commands plus the built-ins nobody shadows. */
export function withBuiltins(commands: readonly ApplicationCommand[]): ApplicationCommand[] {
  return [...commands, ...builtinsFor(commands)];
}

/** The message a built-in sends for `message`, or null when a required message is empty. */
export function builtinContent(name: string, message: string): string | null {
  const def = DEFS.find(d => d.name === name);
  const text = message.trim();
  if (!def || (def.required && text === "")) return null;
  return def.transform(text);
}
