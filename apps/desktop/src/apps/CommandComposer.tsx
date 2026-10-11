// The `/` command picker of the composer: commands grouped by app, option chips, choices and autocomplete, keyboard navigation,
// and running the command instead of sending a message. The composer only forwards keys, its text and the submit.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Check, CircleAlert, LayoutGrid, Loader2, X } from "lucide-react";
import { appStore } from "../api/store";
import { ApplicationCommandOptionType, type ApplicationCommand, type ApplicationCommandOption, type ApplicationCommandOptionChoice, type InteractionDataOption, type Snowflake } from "../api/types";
import { Popout } from "../ui";
import {
  buildOptions,
  commandInsertText,
  matchChoices,
  matchCommands,
  parseInput,
  remainingOptions,
  replaceValue,
  type ParsedInput,
  type ValueResolvers,
} from "./commandParser";
import { AppIcon } from "./AppIcon";
import { dismissRun, loadIndex, requestAutocomplete, runCommand, useAppsStore } from "./store";
import "./apps.css";

const OPTION_TYPE_LABEL: Record<ApplicationCommandOptionType, string> = {
  [ApplicationCommandOptionType.String]: "text",
  [ApplicationCommandOptionType.Integer]: "whole number",
  [ApplicationCommandOptionType.Boolean]: "True or False",
  [ApplicationCommandOptionType.User]: "user",
  [ApplicationCommandOptionType.Channel]: "channel",
  [ApplicationCommandOptionType.Role]: "role",
  [ApplicationCommandOptionType.Number]: "number",
};

type Item =
  | { kind: "command"; key: string; command: ApplicationCommand; appName: string; appIcon: string | null; groupStart: boolean }
  | { kind: "option"; key: string; option: ApplicationCommandOption }
  | { kind: "choice"; key: string; choice: ApplicationCommandOptionChoice; insert: string }
  | { kind: "boolean"; key: string; value: boolean };

/** Resolvers for user/channel/role option values typed by name, from the store. */
function resolversFor(channelId: Snowflake): ValueResolvers {
  const state = appStore.getState();
  const channel = state.channels[channelId] ?? state.threads[channelId];
  const guildId = channel?.guild_id ?? null;
  const lower = (s: string) => s.toLowerCase();
  return {
    userByName: name => {
      const members = guildId ? Object.values(state.members[guildId] ?? {}) : [];
      const hit = members.find(m => [m.nick, m.user.global_name, m.user.username].some(n => n && lower(n) === lower(name)));
      return hit?.user.id ?? Object.values(state.users).find(u => lower(u.username) === lower(name))?.id ?? null;
    },
    channelByName: name => Object.values(state.channels).find(c => c.guild_id === guildId && c.name && lower(c.name) === lower(name))?.id ?? null,
    roleByName: name => (guildId ? state.guilds[guildId]?.roles.find(r => lower(r.name) === lower(name))?.id ?? null : null),
  };
}

export interface CommandComposer {
  /** The text is a slash command the picker handles. */
  active: boolean;
  /** Keys the picker consumed (arrows, Enter/Tab on a suggestion, Escape). */
  onKeyDown(event: KeyboardEvent<HTMLElement>): boolean;
  /** Enter on the composer: "sent" ran the command, "blocked" kept the text (an error is shown), "none" = not a command. */
  submit(rawText: string): "sent" | "blocked" | "none";
  panel: ReactNode;
}

export interface CommandComposerProps {
  channelId: Snowflake;
  text: string;
  caret: number;
  /** Replace the draft text and move the caret. */
  setText(text: string, caret: number): void;
}

export function useCommandComposer({ channelId, text, caret, setText }: CommandComposerProps): CommandComposer {
  const entry = useAppsStore(s => s.indexes[channelId]);
  const runs = useAppsStore(s => s.runs);
  const index = entry?.data;
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autocomplete, setAutocomplete] = useState<{ nonce: string; key: string } | null>(null);
  const choices = useAppsStore(s => (autocomplete ? s.choices[autocomplete.nonce] : undefined));

  // Loaded when the channel opens: user and message menus read it too.
  useEffect(() => {
    void loadIndex(channelId);
  }, [channelId]);
  const slash = text.startsWith("/");
  useEffect(() => {
    if (slash && !entry) void loadIndex(channelId);
  }, [slash, entry, channelId]);

  const commands = index?.application_commands;
  const parsed: ParsedInput = useMemo(() => parseInput(text, caret, commands ?? []), [text, caret, commands]);
  const command = parsed.command;
  const appOf = (id: Snowflake) => index?.applications.find(a => a.id === id);

  // Autocomplete: ask the bot (debounced) while a value of an autocomplete option is typed.
  const focusedOption = parsed.active?.kind === "option-value" && parsed.active.option.autocomplete ? parsed.active : null;
  const focusKey = focusedOption && command ? `${command.id}:${focusedOption.option.name}:${focusedOption.query}` : null;
  useEffect(() => {
    if (!focusKey || !command || !focusedOption) return;
    const timer = setTimeout(() => {
      const built = buildOptions(parsed, resolversFor(channelId)).options.filter(o => o.name !== focusedOption.option.name);
      const value: InteractionDataOption["value"] = focusedOption.option.type === ApplicationCommandOptionType.String ? focusedOption.query : Number(focusedOption.query) || 0;
      const nonce = requestAutocomplete(channelId, command, [...built, { name: focusedOption.option.name, type: focusedOption.option.type, value, focused: true }]);
      setAutocomplete({ nonce, key: focusKey });
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const items: Item[] = useMemo(() => {
    const active = parsed.active;
    if (!parsed.slash || !commands) return [];
    if (active?.kind === "command") {
      // Grouped by app (a stable sort keeps the match order inside each app), with a header at each group start.
      const list = matchCommands(commands, active.query)
        .slice(0, 25)
        .map(c => ({ c, app: appOf(c.application_id) }))
        .sort((a, b) => (a.app?.name ?? "").localeCompare(b.app?.name ?? ""));
      let last: Snowflake | null = null;
      return list.map(({ c, app }) => {
        const item: Item = { kind: "command", key: `c${c.id}`, command: c, appName: app?.name ?? "App", appIcon: app?.icon ?? null, groupStart: c.application_id !== last };
        last = c.application_id;
        return item;
      });
    }
    if (!command) return [];
    if (active?.kind === "option-name") return remainingOptions(parsed, active.query).map(o => ({ kind: "option", key: `o${o.name}`, option: o }));
    // A value followed by a space is finished: no list, so Enter runs the command.
    if (active?.kind === "option-value" && !/\s$/.test(active.query)) {
      const option = active.option;
      if (option.choices?.length) return matchChoices(option.choices, active.query).map(c => ({ kind: "choice", key: `ch${String(c.value)}`, choice: c, insert: c.name }));
      if (option.autocomplete) return (choices ?? []).map(c => ({ kind: "choice", key: `ac${String(c.value)}`, choice: c, insert: String(c.value) }));
      if (option.type === ApplicationCommandOptionType.Boolean) return [true, false].filter(v => String(v).startsWith(active.query.toLowerCase())).map(v => ({ kind: "boolean", key: `b${v}`, value: v }));
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, commands, command, choices, autocomplete, focusKey, index]);

  // Command groups keep their app header in order after sorting.
  const listKey = `${parsed.active?.kind ?? ""}:${parsed.name}:${parsed.active && "query" in parsed.active ? parsed.active.query : ""}`;
  useEffect(() => setSelected(0), [listKey]);
  useEffect(() => setError(null), [text]);
  const open = items.length > 0 && dismissed !== listKey;

  function apply(item: Item): void {
    const active = parsed.active;
    if (item.kind === "command") {
      const next = commandInsertText(item.command);
      setText(next, next.length);
      return;
    }
    if (item.kind === "option" && active && active.kind === "option-name") {
      const insert = `${item.option.name}:`;
      const next = text.slice(0, active.start) + insert + text.slice(caret);
      setText(next, active.start + insert.length);
      return;
    }
    if ((item.kind === "choice" || item.kind === "boolean") && active?.kind === "option-value") {
      const typed = parsed.options.find(o => o.valueStart === active.start);
      const end = typed?.end ?? caret;
      const result = replaceValue(text, active.start, end, item.kind === "choice" ? item.insert : item.value ? "True" : "False");
      setText(result.text, result.caret);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>): boolean {
    if (!open) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(s => (s + 1) % items.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(s => (s - 1 + items.length) % items.length);
      return true;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      const item = items[selected];
      if (!item) return false;
      e.preventDefault();
      apply(item);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDismissed(listKey);
      return true;
    }
    return false;
  }

  function submit(rawText: string): "sent" | "blocked" | "none" {
    if (!rawText.startsWith("/")) return "none";
    const raw = parseInput(rawText, rawText.length, commands ?? []);
    const target = raw.command ?? (raw.nameDone ? null : (commands ?? []).find(c => c.type === 1 && c.name === raw.name.toLowerCase()) ?? null);
    if (!target) {
      if (!commands) {
        setError("Commands are still loading.");
        return "blocked";
      }
      return "none"; // not a command: sent as a normal message
    }
    const withCommand = raw.command ? raw : { ...raw, command: target };
    const built = buildOptions(withCommand, resolversFor(channelId));
    const problems = Object.entries(built.errors);
    if (built.missing.length > 0 || problems.length > 0) {
      setError(built.missing.length > 0 ? `Missing required option${built.missing.length > 1 ? "s" : ""}: ${built.missing.join(", ")}` : problems.map(([name, message]) => `${name}: ${message}`).join(" · "));
      return "blocked";
    }
    runCommand(channelId, target, built.options);
    return "sent";
  }

  const channelRuns = Object.values(runs).filter(r => r.channelId === channelId);
  const showHeader = !!command && parsed.active?.kind !== "command";
  const app = command ? appOf(command.application_id) : undefined;
  const built = command ? buildOptions(parsed, resolversFor(channelId)) : null;
  const activeOption = parsed.active?.kind === "option-value" ? parsed.active.option : null;

  const panel =
    open || showHeader || error || channelRuns.length > 0 ? (
      <div className="apps-command-layer">
        {open && (
          <div className="chat-autocomplete apps-picker" role="listbox" aria-label={parsed.active?.kind === "command" ? "Commands" : "Command options"}>
            {items.map((item, i) => (
              <div key={item.key}>
                {item.kind === "command" && item.groupStart && (
                  <div className="chat-autocomplete-title apps-picker-group">
                    <AppIcon name={item.appName} icon={item.appIcon} size={16} />
                    {item.appName}
                  </div>
                )}
                {i === 0 && item.kind === "option" && <div className="chat-autocomplete-title">Options</div>}
                {i === 0 && (item.kind === "choice" || item.kind === "boolean") && <div className="chat-autocomplete-title">{activeOption?.name ?? "Choices"}</div>}
                <div
                  role="option"
                  aria-selected={i === selected}
                  className={`chat-autocomplete-item apps-picker-item${i === selected ? " selected" : ""}`}
                  onMouseEnter={() => setSelected(i)}
                  onMouseDown={e => {
                    e.preventDefault();
                    apply(item);
                  }}
                >
                  {item.kind === "command" && (
                    <>
                      <span className="chat-autocomplete-label">/{item.command.name}</span>
                      {item.command.options?.filter(o => o.required).map(o => <span key={o.name} className="apps-option-chip ghost">{o.name}</span>)}
                      <span className="apps-picker-desc">{item.command.description}</span>
                      <span className="chat-autocomplete-hint">{item.appName}</span>
                    </>
                  )}
                  {item.kind === "option" && (
                    <>
                      <span className="chat-autocomplete-label">{item.option.name}</span>
                      {item.option.required && <span className="apps-required">required</span>}
                      <span className="apps-picker-desc">{item.option.description}</span>
                      <span className="chat-autocomplete-hint">{OPTION_TYPE_LABEL[item.option.type]}</span>
                    </>
                  )}
                  {item.kind === "choice" && <span className="chat-autocomplete-label">{item.choice.name}</span>}
                  {item.kind === "boolean" && <span className="chat-autocomplete-label">{item.value ? "True" : "False"}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        {showHeader && command && (
          <div className="apps-command-bar" aria-label={`Command /${command.name}`}>
            <AppIcon name={app?.name ?? "App"} icon={app?.icon ?? null} size={20} />
            <span className="apps-command-name">/{command.name}</span>
            {(command.options ?? []).map(option => {
              const typed = parsed.options.find(o => o.name === option.name);
              const problem = built?.errors[option.name];
              const filled = !!typed && !problem && typed.raw !== "";
              const cls = ["apps-option-chip"];
              if (activeOption?.name === option.name) cls.push("active");
              if (filled) cls.push("filled");
              if (problem) cls.push("invalid");
              if (option.required && !typed) cls.push("missing");
              return (
                <button
                  key={option.name}
                  type="button"
                  className={cls.join(" ")}
                  title={problem ?? option.description}
                  onMouseDown={e => {
                    e.preventDefault();
                    if (typed) {
                      setText(text, typed.end);
                      return;
                    }
                    const sep = text.endsWith(" ") ? "" : " ";
                    const next = `${text}${sep}${option.name}:`;
                    setText(next, next.length);
                  }}
                >
                  {filled && <Check size={12} aria-hidden="true" />}
                  {option.name}
                  {option.required && !filled && <span aria-hidden="true">*</span>}
                </button>
              );
            })}
            <span className="apps-command-desc">{activeOption ? activeOption.description : command.description}</span>
          </div>
        )}
        {error && (
          <div className="apps-command-error" role="alert">
            <CircleAlert size={14} aria-hidden="true" /> {error}
          </div>
        )}
        {channelRuns.map(run => (
          <div key={run.nonce} className={`apps-run ${run.state}`} role={run.state === "failed" ? "alert" : "status"}>
            {run.state === "failed" ? <CircleAlert size={14} aria-hidden="true" /> : <Loader2 size={14} className="apps-spin" aria-hidden="true" />}
            {run.state === "failed" ? run.error : `Sending /${run.commandName}…`}
            {run.state === "failed" && (
              <button type="button" className="apps-run-dismiss" aria-label="Dismiss" onClick={() => dismissRun(run.nonce)}>
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    ) : null;

  return { active: parsed.slash && !!command, onKeyDown, submit, panel };
}

/** The composer's apps button: every command of the channel by app; picking one starts it in the composer. */
export function AppLauncherPopout({ anchor, open, onClose, channelId, onPick }: { anchor: RefObject<HTMLElement | null>; open: boolean; onClose(): void; channelId: Snowflake; onPick(text: string): void }) {
  const entry = useAppsStore(s => s.indexes[channelId]);
  useEffect(() => {
    if (open) void loadIndex(channelId);
  }, [open, channelId]);
  const index = entry?.data;
  const byApp = (index?.applications ?? []).map(app => ({ app, commands: (index?.application_commands ?? []).filter(c => c.application_id === app.id && c.type === 1) })).filter(g => g.commands.length > 0);
  return (
    <Popout anchor={anchor} open={open} onClose={onClose} side="top">
      <div className="chat-apps-panel apps-launcher" role="dialog" aria-label="Apps">
        <h3>Apps</h3>
        {entry?.loading && !index && <p>Loading…</p>}
        {index && byApp.length === 0 && <p>No apps with commands in this channel.</p>}
        {byApp.map(({ app, commands }) => (
          <section key={app.id} className="apps-launcher-app">
            <div className="apps-launcher-title">
              <AppIcon name={app.name} icon={app.icon} size={20} /> {app.name}
            </div>
            {commands.map(command => (
              <button
                key={command.id}
                type="button"
                className="apps-launcher-command"
                onClick={() => {
                  onClose();
                  onPick(commandInsertText(command));
                }}
              >
                <span>/{command.name}</span>
                <small>{command.description}</small>
              </button>
            ))}
          </section>
        ))}
      </div>
    </Popout>
  );
}

/** The apps glyph used in the plus menu entry. */
export const AppsGlyph = LayoutGrid;
