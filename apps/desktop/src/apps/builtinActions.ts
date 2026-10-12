// What the action built-ins do: /nick /msg /thread call existing routes, /gif searches GIFs for the picker. Each returns the notice to show
// (or nothing) and throws with a readable message, which the composer shows in its error strip.
import { ApiRequestError, request, startThread } from "../api/rest";
import { appStore } from "../api/store";
import type { Channel, GifPage, Gif, GuildMember, Snowflake } from "../api/types";
import { dmPath, go } from "../shell/nav";
import { openThread } from "../threads/threadUi";

export interface ActionEnv {
  channelId: Snowflake;
  guildId: Snowflake | null;
}
export type ActionValues = Record<string, string | number | boolean | undefined>;

const errorText = (error: unknown): string => (error instanceof ApiRequestError ? error.message : error instanceof Error ? error.message : "Something went wrong.");

/** Posts through the route (the message arrives over the gateway): the channel is not open yet, so there is no optimistic row to keep. */
const post = (channelId: Snowflake, content: string): Promise<unknown> => request("POST", `/channels/${channelId}/messages`, { content });

export const NICK_MAX = 32;

/** Wraps promises so only the latest one answers: an older one resolves to null (also when it fails). */
export function latestOnly(): <T>(promise: Promise<T>) => Promise<T | null> {
  let latest = 0;
  return promise => {
    const mine = ++latest;
    return promise.then(
      value => (mine === latest ? value : null),
      error => {
        if (mine === latest) throw error;
        return null;
      },
    );
  };
}

/** Changes the own nickname of the server (an empty value resets it). */
export async function runNick(env: ActionEnv, values: ActionValues): Promise<string> {
  if (!env.guildId) throw new Error("Nicknames only exist in servers.");
  const nick = String(values.new_nick ?? "").trim();
  if (nick.length > NICK_MAX) throw new Error(`Nicknames can be ${NICK_MAX} characters at most.`);
  try {
    await request<GuildMember>("PATCH", `/guilds/${env.guildId}/members/@me`, { nick: nick || null });
  } catch (error) {
    throw new Error(errorText(error));
  }
  return nick ? `Your nickname on this server has been changed to ${nick}.` : "Your nickname on this server has been reset.";
}

/** Opens (or creates) the DM with the user, posts the message there and goes to it. */
export async function runMsg(_env: ActionEnv, values: ActionValues): Promise<void> {
  const recipient = String(values.user ?? "");
  const content = String(values.message ?? "").trim();
  try {
    const channel = await request<Channel>("POST", "/users/@me/channels", { recipient_id: recipient });
    appStore.getState().upsertChannel(channel);
    await post(channel.id, content);
    go(dmPath(channel.id));
  } catch (error) {
    throw new Error(errorText(error));
  }
}

/** Creates a thread without a starter message, posts the message in it and opens the thread panel. */
export async function runThread(env: ActionEnv, values: ActionValues): Promise<void> {
  const name = String(values.name ?? "").trim();
  const content = String(values.message ?? "").trim();
  let thread: Channel;
  try {
    thread = await startThread(env.channelId, { name });
  } catch (error) {
    throw new Error(errorText(error));
  }
  openThread(thread); // opened even when the post fails, so the empty thread is not left behind unseen
  try {
    await post(thread.id, content);
  } catch (error) {
    throw new Error(`The thread was created, but the message was not sent: ${errorText(error)}`);
  }
}

/** GIFs matching `query`, for the picker list. */
export async function searchGifs(query: string, limit = 12): Promise<Gif[]> {
  const q = new URLSearchParams({ q: query, limit: String(limit) });
  const page = await request<GifPage>("GET", `/gifs/search?${q}`);
  return page.results;
}
