// The `/` command picker of the composer: commands grouped by app, option chips, choices and autocomplete, keyboard navigation,
// and running the command instead of sending a message. The composer only forwards keys, its text and the submit.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Check, CircleAlert, Clock, LayoutGrid, Loader2, SquareSlash, X } from "lucide-react";
import { appStore, useStore } from "../api/store";
import { ApplicationCommandOptionType, type ApplicationCommand, type ApplicationCommandOption, type ApplicationCommandOptionChoice, type Gif, type InteractionDataOption, type Snowflake } from "../api/types";
import { Popout, Tooltip } from "../ui";
import { afterNextKey, useKeyToken, useKeyedState } from "../chat/keyedState";
import {
  buildOptions,
  commandInsertText,
  matchChoices,
  parseInput,
  remainingOptions,
  replaceValue,
  type ParsedInput,
  type ValueResolvers,
} from "./commandParser";
import { AppIcon } from "./AppIcon";
import { Perm } from "../api/permissions";
import { usePermissions } from "../shell/usePermissions";
import { hasThreadsType } from "../threads/util";
import { BUILTIN_APP_ID, BUILTIN_APP_NAME, builtinContent, builtinsFor, canOfferTts, isActionBuiltin, isBuiltin, takesFreeText, withBuiltins } from "./builtins";
import { usePrefs } from "../ui/prefs";
import { NICK_MAX, latestOnly, runMsg, runNick, runThread, searchGifs, type ActionValues } from "./builtinActions";
import { bumpRecent, buildSections, loadRecents, saveRecents, type PanelSection, type Recents } from "./panel";
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
  | { kind: "command"; key: string; command: ApplicationCommand; appName: string; appIcon: string | null; section: PanelSection["kind"] }
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

/** Same limit as the composer's own. */
const MAX_MESSAGE = 2000;

/** An app's icon, or the slash tile of the built-in commands. */
function AppBadge({ name, icon, size, builtin }: { name: string; icon: string | null; size: number; builtin: boolean }) {
  if (!builtin) return <AppIcon name={name} icon={icon} size={size} />;
  return (
    <span className="apps-icon apps-icon-builtin" aria-hidden="true" style={{ width: size, height: size }}>
      <SquareSlash size={Math.round(size * 0.7)} />
    </span>
  );
}

/** The icon of a panel section: a clock for Frequently Used, the app's icon, the slash tile for Built-in. */
function SectionIcon({ section, size }: { section: PanelSection; size: number }) {
  if (section.kind === "recent") return <Clock size={size === 16 ? 14 : 20} aria-hidden="true" />;
  if (section.kind === "builtin") return <AppBadge name={section.name} icon={null} size={size} builtin />;
  return <AppIcon name={section.name} icon={section.app?.icon ?? null} size={size} />;
}

export interface CommandComposer {
  /** The text is a slash command the picker handles. */
  active: boolean;
  /** Keys the picker consumed (arrows, Enter/Tab on a suggestion, Escape). */
  onKeyDown(event: KeyboardEvent<HTMLElement>): boolean;
  /** Enter on the composer: "sent" ran the command, "blocked" kept the text (an error is shown), "none" = not a command,
   *  a message = the text of a built-in command, for the composer to send like a typed message. */
  submit(rawText: string, hasUploads?: boolean): "sent" | "blocked" | "none" | { kind: "message"; content: string; tts?: boolean };
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
  const meId = useStore(s => s.me?.id ?? null);
  const [recents, setRecents] = useState<Recents>(() => loadRecents(meId));
  useEffect(() => setRecents(loadRecents(meId)), [meId]);
  const listRef = useRef<HTMLDivElement>(null);
  const keyNav = useRef(false);
  const railLock = useRef(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // Typing clears them: keyed on the draft text, not reset from an effect (see keyedState.ts).
  const textToken = useKeyToken(text);
  const [error, setError] = useKeyedState<string | null>(textToken, null);
  const [notice, setNotice] = useKeyedState<string | null>(textToken, null);
  const [gifs, setGifs] = useState<{ q: string; list: Gif[]; failed: boolean } | null>(null);
  const gifLatest = useRef(latestOnly());
  /** The GIF picked from the list: the text it put in the composer and the URL that Enter sends. */
  const gifPick = useRef<{ text: string; url: string } | null>(null);
  const channel = useStore(s => s.channels[channelId] ?? s.threads[channelId]);
  const guildId = channel?.guild_id ?? null;
  const { can } = usePermissions(guildId, channelId);
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

  // The channel's commands plus the client-side built-ins (they work before the index loads and in channels without apps).
  const appCommands = index?.application_commands;
  const canThread = !!guildId && hasThreadsType(channel) && can(Perm.CREATE_PUBLIC_THREADS) && can(Perm.READ_MESSAGE_HISTORY) && can(Perm.SEND_MESSAGES_IN_THREADS);
  const canNick = !!guildId && can(Perm.CHANGE_NICKNAME);
  const ttsPlayback = usePrefs(s => s.ttsPlayback);
  const canTts = canOfferTts(ttsPlayback, channel, can(Perm.SEND_TTS_MESSAGES));
  const commands = useMemo(() => withBuiltins(appCommands ?? [], { nick: canNick, threads: canThread, tts: canTts }), [appCommands, canNick, canThread, canTts]);
  const parsed: ParsedInput = useMemo(() => parseInput(text, caret, commands), [text, caret, commands]);
  const command = parsed.command;
  // /gif: the search text (typed as `query:` or as free text) drives a debounced GIF search shown as choices.
  const isGif = !!command && isBuiltin(command) && command.name === "gif";
  const gifQuery = isGif ? parsed.options.find(o => o.name === "query")?.raw ?? (parsed.options.length === 0 ? text.slice(parsed.name.length + 1).trim() : "") : "";
  useEffect(() => {
    if (!gifQuery || gifPick.current?.text === text.trim()) return; // picking a GIF puts its title in the composer: no new search for it
    const timer = setTimeout(() => {
      // Only the latest search may answer: "cat" arriving after "cats" is dropped.
      gifLatest.current(searchGifs(gifQuery)).then(
        list => list && setGifs({ q: gifQuery, list, failed: false }),
        () => setGifs({ q: gifQuery, list: [], failed: true }),
      );
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gifQuery]);
  const gifNote = isGif && gifQuery && gifs?.q === gifQuery && gifPick.current?.text !== text.trim() && gifs.list.length === 0 ? (gifs.failed ? "Could not search GIFs." : "No GIFs found.") : null;
  // Another channel: nothing from the last one stays on the strip.
  useEffect(() => {
    setError(null);
    setNotice(null);
    gifPick.current = null;
  }, [channelId]);
  const appOf = (id: Snowflake) => index?.applications.find(a => a.id === id);
  const appInfo = (id: Snowflake): { name: string; icon: string | null } => (id === BUILTIN_APP_ID ? { name: BUILTIN_APP_NAME, icon: null } : appOf(id) ?? { name: "App", icon: null });
  const commandQuery = parsed.slash && parsed.active?.kind === "command" ? parsed.active.query : null;
  const sections = useMemo(() => (commandQuery === null ? [] : buildSections(commands, index?.applications ?? [], commandQuery, recents)), [commands, index, commandQuery, recents]);

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
    if (!parsed.slash) return [];
    // One row per command of each section, in section order (a Frequently Used command is listed again under its app).
    if (active?.kind === "command") {
      return sections.flatMap(sec =>
        sec.commands.map((c): Item => {
          const app = sec.kind === "recent" ? appInfo(c.application_id) : sec.app ?? { name: sec.name, icon: null };
          return { kind: "command", key: `${sec.id}:${c.id}`, command: c, appName: app.name, appIcon: app.icon, section: sec.kind };
        }),
      );
    }
    if (!command) return [];
    if (isGif && gifQuery) {
      if (gifPick.current?.text === text.trim()) return []; // picked: Enter sends it
      return gifs?.q === gifQuery ? gifs.list.map((g): Item => ({ kind: "choice", key: `gif${g.id}`, choice: { name: g.title || g.url, value: g.url }, insert: g.url })) : [];
    }
    // Free text after a built-in (`/shrug me`) is its option, not an option name: no list, so Enter sends it.
    if (active?.kind === "option-name" && takesFreeText(command) && parsed.options.length === 0) return [];
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
  }, [parsed, sections, command, choices, autocomplete, focusKey, index, isGif, gifQuery, gifs, text]);

  const listKey = `${parsed.active?.kind ?? ""}:${parsed.name}:${parsed.active && "query" in parsed.active ? parsed.active.query : ""}`;
  const listToken = useKeyToken(listKey);
  const [selected, setSelected] = useKeyedState(listToken, 0);
  const [railActive, setRailActive] = useKeyedState<string | null>(listToken, null);
  // Arrow keys keep the selected row in view (the first row also shows the header above it).
  useEffect(() => {
    if (!keyNav.current) return;
    keyNav.current = false;
    const list = listRef.current;
    if (!list) return;
    if (selected === 0) list.scrollTop = 0;
    else list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  /** The section the rail highlights follows the list's scroll position. */
  function syncRail(): void {
    const list = listRef.current;
    if (!list || Date.now() < railLock.current) return;
    let current = sections[0]?.id ?? null;
    for (const sec of sections) {
      const el = list.querySelector<HTMLElement>(`[data-section="${sec.id}"]`);
      if (el && el.offsetTop <= list.scrollTop + 8) current = sec.id;
    }
    if (list.scrollHeight > list.clientHeight && list.scrollTop + list.clientHeight >= list.scrollHeight - 2) current = sections[sections.length - 1]?.id ?? current;
    setRailActive(current);
  }

  function jumpTo(id: string): void {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (!list || !el) return;
    railLock.current = Date.now() + 300;
    setRailActive(id);
    list.scrollTo({ top: el.offsetTop });
  }
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
    if (item.kind === "choice" && isGif) {
      const next = `/gif ${item.choice.name}`;
      gifPick.current = { text: next.trim(), url: String(item.choice.value) };
      setText(next, next.length);
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
      keyNav.current = true;
      setSelected(s => (s + 1) % items.length);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      keyNav.current = true;
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

  function noteUsed(used: ApplicationCommand): void {
    const next = bumpRecent(loadRecents(meId), used.id, Date.now());
    saveRecents(meId, next);
    setRecents(next);
  }

  function submit(rawText: string, hasUploads = false): "sent" | "blocked" | "none" | { kind: "message"; content: string; tts?: boolean } {
    if (!rawText.startsWith("/")) return "none";
    const raw = parseInput(rawText, rawText.length, commands);
    const target = raw.command ?? (raw.nameDone ? null : commands.find(c => c.type === 1 && c.name === raw.name.toLowerCase()) ?? null);
    if (!target) {
      if (!index) {
        setError("Commands are still loading.");
        return "blocked";
      }
      return "none"; // not a command: sent as a normal message
    }
    if (hasUploads && !isBuiltin(target)) return "none";
    // The actions clear the draft, which would drop the attachments (and the reply) with it.
    if (hasUploads && isBuiltin(target) && target.name !== "gif" && isActionBuiltin(target.name)) {
      setError(`Remove the attachments to use /${target.name}.`);
      return "blocked";
    }
    // An app may own the name of a built-in: wait for the index (after a failed load the built-in is used).
    if (isBuiltin(target) && !index) {
      setError("Commands are still loading.");
      return "blocked";
    }
    const withCommand = raw.command ? raw : { ...raw, command: target };
    const built = buildOptions(withCommand, resolversFor(channelId));
    const problems = Object.entries(built.errors);
    // A built-in with one option takes the rest of the text as it (`/shrug hi`).
    const free = takesFreeText(target) && raw.options.length === 0;
    const freeValue = rawText.slice(raw.name.length + 1).trim();
    const firstOption = target.options?.[0];
    if (free && firstOption?.required && freeValue === "") {
      setError(`Missing required option: ${firstOption.name}`);
      return "blocked";
    }
    if (!free && (built.missing.length > 0 || problems.length > 0)) {
      setError(built.missing.length > 0 ? `Missing required option${built.missing.length > 1 ? "s" : ""}: ${built.missing.join(", ")}` : problems.map(([name, message]) => `${name}: ${message}`).join(" · "));
      return "blocked";
    }
    if (isBuiltin(target) && target.name === "gif") {
      const pick = gifPick.current;
      if (!pick || pick.text !== rawText.trim()) {
        setError("Pick a GIF from the list.");
        return "blocked";
      }
      noteUsed(target);
      return { kind: "message", content: pick.url };
    }
    if (isBuiltin(target) && isActionBuiltin(target.name)) {
      // Side effects run only now that the options are valid; their errors go to the error strip.
      const values: ActionValues = free && firstOption ? { [firstOption.name]: freeValue } : Object.fromEntries(built.options.map(o => [o.name, o.value]));
      if (target.name === "nick" && String(values.new_nick ?? "").trim().length > NICK_MAX) {
        setError(`Nicknames can be ${NICK_MAX} characters at most.`);
        return "blocked";
      }
      const env = { channelId, guildId };
      // The result belongs to the empty draft this send leaves (not the command text, not a later draft): dropped once that is edited.
      const submitted = textToken;
      const run = target.name === "nick" ? runNick(env, values).then(n => afterNextKey(submitted, t => setNotice(n, t))) : target.name === "msg" ? runMsg(env, values) : runThread(env, values);
      run.catch((e: unknown) => {
        const message = e instanceof Error ? e.message : "Something went wrong.";
        afterNextKey(submitted, t => setError(message, t));
      });
      noteUsed(target);
      return "sent";
    }
    if (isBuiltin(target)) {
      const message = free ? rawText.slice(raw.name.length + 1) : String(built.options.find(o => o.name === "message")?.value ?? "");
      const content = builtinContent(target.name, message);
      if (content === null) {
        setError("Missing required option: message");
        return "blocked";
      }
      if (content.length > MAX_MESSAGE) {
        setError(`Message is too long (${MAX_MESSAGE} characters at most, with what the command adds).`);
        return "blocked";
      }
      noteUsed(target);
      return target.name === "tts" ? { kind: "message", content, tts: true } : { kind: "message", content };
    }
    runCommand(channelId, target, built.options);
    noteUsed(target); // counted when sent: the store has no cheap success hook (a failed run still counts)
    return "sent";
  }

  const channelRuns = Object.values(runs).filter(r => r.channelId === channelId);
  const showHeader = !!command && parsed.active?.kind !== "command";
  const app = command ? appOf(command.application_id) : undefined;
  const built = command ? buildOptions(parsed, resolversFor(channelId)) : null;
  const activeOption = parsed.active?.kind === "option-value" ? parsed.active.option : null;

  function renderRow(item: Item, i: number): ReactNode {
    const optional = item.kind === "command" ? (item.command.options ?? []).filter(o => !o.required).length : 0;
    return (
      <div
        key={item.key}
        role="option"
        aria-selected={i === selected}
        className={`chat-autocomplete-item apps-picker-item${item.kind === "command" ? " apps-command-row" : ""}${i === selected ? " selected" : ""}`}
        onMouseEnter={() => {
          keyNav.current = false;
          setSelected(i);
        }}
        onMouseDown={e => {
          e.preventDefault();
          apply(item);
        }}
      >
        {item.kind === "command" && (
          <>
            {item.section === "recent" && <AppBadge name={item.appName} icon={item.appIcon} size={32} builtin={isBuiltin(item.command)} />}
            <span className="apps-row-text">
              <span className="apps-row-head">
                <span className="chat-autocomplete-label">/{item.command.name}</span>
                {item.command.options?.filter(o => o.required).map(o => <span key={o.name} className="apps-option-chip ghost">{o.name}</span>)}
                {optional > 0 && (
                  <>
                    <span className="apps-row-sep" aria-hidden="true" />
                    <span className="apps-row-optional">+{optional} optional</span>
                  </>
                )}
              </span>
              <span className="apps-picker-desc">{item.command.description}</span>
            </span>
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
    );
  }

  const panel =
    open || showHeader || error || notice || gifNote || channelRuns.length > 0 ? (
      <div className="apps-command-layer">
        {open && commandQuery !== null && (
          <div className="chat-autocomplete apps-picker apps-panel">
            {commandQuery === "" && (
              <nav className="apps-rail" aria-label="Command sources">
                {sections.map(sec => (
                  <div key={sec.id} className="apps-rail-entry">
                    {sec.kind === "builtin" && sections.length > 1 && <hr className="apps-rail-divider" />}
                    <Tooltip content={sec.name} side="right">
                      <button
                        type="button"
                        className={`apps-rail-btn${(railActive ?? sections[0]?.id) === sec.id ? " active" : ""}`}
                        aria-label={sec.name}
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => jumpTo(sec.id)}
                      >
                        <SectionIcon section={sec} size={32} />
                      </button>
                    </Tooltip>
                  </div>
                ))}
              </nav>
            )}
            <div ref={listRef} className="apps-panel-list" role="listbox" aria-label="Commands" onScroll={syncRail}>
              {sections.map(sec => (
                <div key={sec.id} role="group" aria-labelledby={`apps-sec-${sec.id}`} data-section={sec.id}>
                  <div id={`apps-sec-${sec.id}`} className="apps-picker-group">
                    <SectionIcon section={sec} size={16} />
                    {sec.name}
                  </div>
                  {items.map((item, i) => (item.kind === "command" && item.key.startsWith(`${sec.id}:`) ? renderRow(item, i) : null))}
                </div>
              ))}
            </div>
          </div>
        )}
        {open && commandQuery === null && (
          <div className="chat-autocomplete apps-picker" role="listbox" aria-label="Command options">
            {items.map((item, i) => (
              <div key={item.key}>
                {i === 0 && item.kind === "option" && <div className="chat-autocomplete-title">Options</div>}
                {i === 0 && (item.kind === "choice" || item.kind === "boolean") && <div className="chat-autocomplete-title">{activeOption?.name ?? "Choices"}</div>}
                {renderRow(item, i)}
              </div>
            ))}
          </div>
        )}
        {showHeader && command && (
          <div className="apps-command-bar" aria-label={`Command /${command.name}`}>
            <AppBadge name={app?.name ?? "App"} icon={app?.icon ?? null} size={20} builtin={isBuiltin(command)} />
            <span className="apps-command-name">/{command.name}</span>
            {(command.options ?? []).map(option => {
              const typed = parsed.options.find(o => o.name === option.name);
              const problem = built?.errors[option.name];
              // `/shrug hi`: the text after a built-in's name stands for its message.
              const free = takesFreeText(command) && parsed.options.length === 0 && text.slice(parsed.name.length + 1).trim() !== "";
              const filled = (!!typed && !problem && typed.raw !== "") || free;
              const cls = ["apps-option-chip"];
              if (activeOption?.name === option.name) cls.push("active");
              if (filled) cls.push("filled");
              if (problem) cls.push("invalid");
              if (option.required && !typed && !free) cls.push("missing");
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
        {gifNote && (
          <div className="apps-run" role="status">
            {gifNote}
          </div>
        )}
        {notice && (
          <div className="apps-run" role="status">
            <Check size={14} aria-hidden="true" /> {notice}
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

  // Built-ins take plain text, so the composer keeps its @mention, :emoji and #channel pickers inside them.
  return { active: parsed.slash && !!command && !isBuiltin(command), onKeyDown, submit, panel };
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
        {[...byApp, { app: { id: BUILTIN_APP_ID, name: BUILTIN_APP_NAME, icon: null }, commands: builtinsFor(index?.application_commands ?? []) }].map(({ app, commands }) => (
          <section key={app.id} className="apps-launcher-app">
            <div className="apps-launcher-title">
              <AppBadge name={app.name} icon={app.icon} size={20} builtin={app.id === BUILTIN_APP_ID} /> {app.name}
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
