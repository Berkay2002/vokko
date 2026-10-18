// Client state for apps: the command index per channel, commands in flight, autocomplete choices and webhook list refreshes.
import { create } from "zustand";
import { gateway } from "../api/gateway";
import { ApiRequestError } from "../api/errors";
import { appStore } from "../api/store";
import {
  InteractionType,
  type ApplicationCommand,
  type ComponentType,
  type ApplicationCommandIndex,
  type ApplicationCommandOptionChoice,
  type InteractionDataOption,
  type Message,
  type Snowflake,
} from "../api/types";
import { commandIndex, invokeInteraction } from "./api";

export interface CommandRun {
  nonce: string;
  /** Interaction id once the server accepted it. */
  id: string | null;
  channelId: Snowflake;
  appName: string;
  commandName: string;
  state: "sending" | "waiting" | "failed";
  error: string | null;
}

/** A component click in flight (or failed) on one message; its components stay disabled while it is pending. */
export interface ComponentClick {
  nonce: string;
  state: "sending" | "waiting" | "failed";
}

interface IndexEntry {
  data: ApplicationCommandIndex | null;
  loading: boolean;
  error: string | null;
}

interface AppsState {
  indexes: Record<Snowflake, IndexEntry>;
  runs: Record<string, CommandRun>;
  /** autocomplete request nonce → choices the bot sent */
  choices: Record<string, ApplicationCommandOptionChoice[]>;
  /** message id → its latest component click (a message has at most one pending) */
  clicks: Record<Snowflake, ComponentClick>;
  /** Bumped by WEBHOOKS_UPDATE per channel and per guild: webhook lists refetch when it changes. */
  webhookVersion: Record<Snowflake, number>;
}

export const useAppsStore = create<AppsState>(() => ({ indexes: {}, runs: {}, choices: {}, clicks: {}, webhookVersion: {} }));

const EMPTY_INDEX: ApplicationCommandIndex = { applications: [], application_commands: [] };
let counter = 0;
const newNonce = (): string => `${Date.now()}${(counter++ % 1000).toString().padStart(3, "0")}`;

let bound = false;
/** Interactions whose response already arrived (it can beat the REST answer of POST /interactions). */
const answered = new Set<string>();

/** Subscribes to the gateway events apps care about (once). */
export function bindAppsGateway(): void {
  if (bound) return;
  bound = true;
  const set = useAppsStore.setState;
  const get = useAppsStore.getState;
  gateway.on("INTERACTION_FAILURE", ({ id, nonce }) => {
    const run = Object.values(get().runs).find(r => r.id === id);
    if (run) set({ runs: { ...get().runs, [run.nonce]: { ...run, state: "failed", error: `${run.appName} did not respond.` } } });
    if (nonce) failClick(nonce);
  });
  // A component click was answered; a type 6 answer shows no message, so this is what ends the pending state.
  gateway.on("INTERACTION_SUCCESS", ({ nonce }) => {
    if (nonce) settleClick(nonce);
  });
  gateway.on("MESSAGE_CREATE", message => {
    const id = message.interaction_metadata?.id;
    if (!id) return;
    answered.add(id);
    const run = Object.values(get().runs).find(r => r.id === id);
    if (run) {
      const { [run.nonce]: _done, ...rest } = get().runs;
      void _done;
      set({ runs: rest });
    }
  });
  gateway.on("APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE", ({ nonce, choices }) => {
    if (nonce) set({ choices: { ...get().choices, [nonce]: choices } });
  });
  gateway.on("WEBHOOKS_UPDATE", ({ guild_id, channel_id }) => {
    const versions = get().webhookVersion;
    set({ webhookVersion: { ...versions, [guild_id]: (versions[guild_id] ?? 0) + 1, [channel_id]: (versions[channel_id] ?? 0) + 1 } });
  });
  // Who can run what changes with bots joining or leaving, roles and channel overwrites: drop the cached indexes.
  const invalidate = () => set({ indexes: {} });
  gateway.on("GUILD_MEMBER_ADD", member => member.user.bot && invalidate());
  gateway.on("GUILD_MEMBER_REMOVE", ({ user }) => user.bot && invalidate());
  gateway.on("GUILD_ROLE_UPDATE", invalidate);
  // Only the own member decides what you can run (a nickname change of someone else changes nothing), and only in that guild.
  gateway.on("GUILD_MEMBER_UPDATE", member => {
    if (member.user.id === appStore.getState().me?.id) invalidateGuildIndexes(member.guild_id);
  });
  gateway.on("CHANNEL_UPDATE", invalidate);
}

/** Drops the cached command indexes of the channels of one guild (`guildOf` maps a channel id to its guild). */
export function invalidateGuildIndexes(guildId: Snowflake, guildOf: (channelId: Snowflake) => Snowflake | null | undefined = id => {
  const state = appStore.getState();
  return (state.channels[id] ?? state.threads[id])?.guild_id;
}): void {
  useAppsStore.setState(s => ({ indexes: Object.fromEntries(Object.entries(s.indexes).filter(([channelId]) => guildOf(channelId) !== guildId)) }));
}

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : error instanceof Error ? error.message : "Something went wrong.";
}

/** Loads (or reuses) the command index of a channel. */
export async function loadIndex(channelId: Snowflake, force = false): Promise<ApplicationCommandIndex> {
  bindAppsGateway();
  const current = useAppsStore.getState().indexes[channelId];
  if (current?.data && !force) return current.data;
  useAppsStore.setState(s => ({ indexes: { ...s.indexes, [channelId]: { data: current?.data ?? null, loading: true, error: null } } }));
  try {
    const data = await commandIndex(channelId);
    useAppsStore.setState(s => ({ indexes: { ...s.indexes, [channelId]: { data, loading: false, error: null } } }));
    return data;
  } catch (error) {
    useAppsStore.setState(s => ({ indexes: { ...s.indexes, [channelId]: { data: EMPTY_INDEX, loading: false, error: errorText(error) } } }));
    return EMPTY_INDEX;
  }
}

/** The cached index (empty while not loaded). */
export function cachedIndex(channelId: Snowflake | null | undefined): ApplicationCommandIndex {
  return (channelId ? useAppsStore.getState().indexes[channelId]?.data : null) ?? EMPTY_INDEX;
}

export function appNameOf(index: ApplicationCommandIndex, applicationId: Snowflake): string {
  return index.applications.find(a => a.id === applicationId)?.name ?? "The app";
}

/** Runs a command; the response arrives as MESSAGE_CREATE (or INTERACTION_FAILURE). Returns the run's nonce. */
export function runCommand(channelId: Snowflake, command: ApplicationCommand, options: InteractionDataOption[], targetId?: Snowflake): string {
  bindAppsGateway();
  const nonce = newNonce();
  const appName = appNameOf(cachedIndex(channelId), command.application_id);
  const run: CommandRun = { nonce, id: null, channelId, appName, commandName: command.name, state: "sending", error: null };
  useAppsStore.setState(s => ({ runs: { ...s.runs, [nonce]: run } }));
  const update = (patch: Partial<CommandRun>) => {
    const existing = useAppsStore.getState().runs[nonce];
    if (existing) useAppsStore.setState(s => ({ runs: { ...s.runs, [nonce]: { ...existing, ...patch } } }));
  };
  invokeInteraction({
    type: InteractionType.ApplicationCommand,
    application_id: command.application_id,
    channel_id: channelId,
    data: { id: command.id, name: command.name, type: command.type, ...(options.length ? { options } : {}), ...(targetId ? { target_id: targetId } : {}) },
    nonce,
  }).then(
    created => {
      const existing = useAppsStore.getState().runs[nonce];
      if (answered.has(created.id)) dismissRun(nonce);
      else if (existing) update({ id: created.id, state: existing.state === "failed" ? "failed" : "waiting" });
    },
    error => update({ state: "failed", error: errorText(error) }),
  );
  return nonce;
}

const settleClick = (nonce: string): void => {
  const clicks = Object.fromEntries(Object.entries(useAppsStore.getState().clicks).filter(([, c]) => c.nonce !== nonce));
  useAppsStore.setState({ clicks });
};
const failClick = (nonce: string): void => {
  const clicks = useAppsStore.getState().clicks;
  const entry = Object.entries(clicks).find(([, c]) => c.nonce === nonce);
  if (!entry) return;
  useAppsStore.setState({ clicks: { ...clicks, [entry[0]]: { nonce, state: "failed" } } });
  setTimeout(() => settleClick(nonce), FAILURE_SHOWN_MS);
};

/** How long a click may stay pending before it counts as failed (the server reports a silent bot after 3 s; this covers a lost event). */
const CLICK_TIMEOUT_MS = 15_000;
const FAILURE_SHOWN_MS = 8_000;

/** Clicks a button, or picks an option of a select; the answer arrives as MESSAGE_UPDATE/MESSAGE_CREATE, then INTERACTION_SUCCESS (or INTERACTION_FAILURE). */
export function clickComponent(message: Pick<Message, "id" | "channel_id" | "application_id" | "author">, customId: string, componentType: ComponentType, values?: string[]): void {
  // Interaction responses name their application; a bot's own message is authored by it (its user id is the application id).
  const applicationId = message.application_id ?? (message.author?.bot ? message.author.id : undefined);
  const pending = useAppsStore.getState().clicks[message.id];
  if (!applicationId || pending?.state === "sending" || pending?.state === "waiting") return;
  bindAppsGateway();
  const nonce = newNonce();
  const mark = (state: ComponentClick["state"]) => useAppsStore.setState(s => ({ clicks: { ...s.clicks, [message.id]: { nonce, state } } }));
  mark("sending");
  invokeInteraction({
    type: InteractionType.MessageComponent,
    application_id: applicationId,
    channel_id: message.channel_id,
    message_id: message.id,
    data: { custom_id: customId, component_type: componentType, ...(values ? { values } : {}) },
    nonce,
  }).then(
    () => {
      // INTERACTION_SUCCESS or INTERACTION_FAILURE may have beaten this answer.
      const current = () => useAppsStore.getState().clicks[message.id];
      if (current()?.nonce !== nonce || current()?.state !== "sending") return;
      mark("waiting");
      setTimeout(() => current()?.nonce === nonce && current()?.state === "waiting" && failClick(nonce), CLICK_TIMEOUT_MS);
    },
    () => failClick(nonce),
  );
}

/** Asks the bot for choices of the focused option; read them with `useAppsStore(s => s.choices[nonce])`. */
export function requestAutocomplete(channelId: Snowflake, command: ApplicationCommand, options: InteractionDataOption[]): string {
  bindAppsGateway();
  const nonce = newNonce();
  void invokeInteraction({
    type: InteractionType.ApplicationCommandAutocomplete,
    application_id: command.application_id,
    channel_id: channelId,
    data: { id: command.id, name: command.name, type: command.type, options },
    nonce,
  }).catch(() => undefined);
  return nonce;
}

export function dismissRun(nonce: string): void {
  const { [nonce]: _gone, ...rest } = useAppsStore.getState().runs;
  void _gone;
  useAppsStore.setState({ runs: rest });
}
