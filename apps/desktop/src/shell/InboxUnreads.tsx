// Inbox > Unreads: one card per unread channel (newest activity first) with its newest unread messages, a check to mark it read,
// and "Mark All as Read" on top. Previews are one cached request per channel and last_message_id.

import { useEffect, useMemo, useState } from "react";
import { Check, CheckCheck, Inbox as InboxIcon } from "lucide-react";
import { request } from "../api/rest";
import { compareIds } from "../api/snowflake";
import { channelMentionCount, displayName, dmName, isChannelUnread, useStore } from "../api/store";
import { ChannelType, type Channel, type Message, type Snowflake } from "../api/types";
import { ChannelTypeIcon } from "../chat/ChannelTypeIcon";
import { messageSnippet } from "../media/helpers";
import { jumpToMessage } from "../media/jump";
import { markChannelRead, markChannelsRead } from "./actions";
import { Avatar, GuildIcon } from "./Avatar";
import { isMutedAt, useLocalState, useMuteLapse } from "./localState";
import { dmPath, go, guildPath } from "./nav";

/** How many unread messages a card previews. */
export const PREVIEW_COUNT = 3;
/** Channel cards shown at once; the rest are counted (each card is one request). */
export const MAX_CARDS = 20;

export interface UnreadRow {
  channel: Channel;
  mentions: number;
}

type ReadView = Parameters<typeof isChannelUnread>[0];

/**
 * Unread channels you can open, newest activity first. Categories never count; voice channels do (their text chat). A muted
 * channel (or one in a muted category) only shows while it has mentions, as the channel list and rail treat it.
 */
export function unreadRows(state: ReadView, muted: (id: Snowflake) => boolean = () => false): UnreadRow[] {
  return Object.values(state.channels)
    .filter(c => c.type !== ChannelType.GuildCategory && isChannelUnread(state, c.id))
    .map(channel => ({ channel, mentions: channelMentionCount(state, channel.id) }))
    .filter(r => r.mentions > 0 || !(muted(r.channel.id) || (r.channel.parent_id != null && muted(r.channel.parent_id))))
    .sort((a, b) => compareIds(b.channel.last_message_id as Snowflake, a.channel.last_message_id as Snowflake));
}

/** The messages after the read pointer, oldest first, from a newest-first page. Never read: the whole page. */
export function unreadPreview(page: Message[], readId: Snowflake | null | undefined): Message[] {
  return page.filter(m => !readId || compareIds(m.id, readId) > 0).reverse();
}

const previews = new Map<string, Message[]>();

function usePreview(channel: Channel): Message[] | null {
  const key = `${channel.id}:${channel.last_message_id ?? ""}`;
  const [page, setPage] = useState<Message[] | null>(() => previews.get(key) ?? null);
  useEffect(() => {
    const hit = previews.get(key);
    if (hit) {
      setPage(hit);
      return;
    }
    let live = true;
    request<Message[]>("GET", `/channels/${channel.id}/messages?limit=${PREVIEW_COUNT}`)
      .then(list => {
        previews.set(key, list);
        if (live) setPage(list);
      })
      .catch(() => live && setPage([]));
    return () => {
      live = false;
    };
  }, [key, channel.id]);
  return page;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function when(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? timeFormat.format(d) : `${dayFormat.format(d)}, ${timeFormat.format(d)}`;
}

function UnreadCard({ channel, mentions, onNavigate }: UnreadRow & { onNavigate(): void }) {
  const guildId = channel.guild_id ?? null;
  const guild = useStore(s => (guildId ? s.guilds[guildId] : undefined));
  const category = useStore(s => (channel.parent_id ? s.channels[channel.parent_id]?.name : undefined));
  const readId = useStore(s => s.readStates[channel.id]?.last_message_id);
  const members = useStore(s => (guildId ? s.members[guildId] : undefined));
  const page = usePreview(channel);
  const messages = page ? unreadPreview(page, readId) : null;
  const name = guildId ? (channel.name ?? "") : dmName(channel);
  const sub = guild ? [guild.name, category].filter(Boolean).join(" › ") : channel.type === ChannelType.GroupDM ? "Group DM" : "Direct Message";
  const open = () => {
    onNavigate();
    go(guildId ? guildPath(guildId, channel.id) : dmPath(channel.id));
  };
  const recipient = channel.recipients?.[0];
  return (
    <section className="inbox-unread" aria-label={`${name}, ${sub}`} data-testid="inbox-unread">
      <div className="inbox-unread-head">
        <button type="button" className="inbox-unread-open" onClick={open}>
          <span className="inbox-unread-avatar">{guild ? <GuildIcon guild={guild} size={32} /> : recipient ? <Avatar user={recipient} size={32} /> : <InboxIcon size={20} />}</span>
          <span className="inbox-row-text">
            <span className="inbox-row-name">
              {guildId && <ChannelTypeIcon type={channel.type} size={16} className="inbox-unread-type" />}
              {name}
            </span>
            <span className="inbox-row-sub">{sub}</span>
          </span>
          {mentions > 0 && <span className="inbox-row-badge" aria-label={`${mentions} mentions`}>{mentions}</span>}
        </button>
        <button type="button" className="inbox-unread-check" aria-label={`Mark ${name} as read`} title="Mark as Read" onClick={() => void markChannelRead(channel.id)}>
          <Check size={18} />
        </button>
      </div>
      <div className="inbox-unread-messages">
        {messages === null && <div className="inbox-unread-loading">Loading messages…</div>}
        {messages?.map(m => (
          <button
            key={m.id}
            type="button"
            className="inbox-unread-message"
            onClick={() => {
              onNavigate();
              void jumpToMessage(m.channel_id, m.id, guildId);
            }}
          >
            <Avatar user={m.author} size={32} guildId={guildId ?? undefined} />
            <span className="inbox-unread-body">
              <span className="inbox-unread-meta">
                <span className="inbox-unread-author">{displayName(m.author, members?.[m.author.id])}</span>
                <span className="inbox-row-sub">{when(m.timestamp)}</span>
              </span>
              <span className="inbox-unread-text">{messageSnippet(m, 300)}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function UnreadList({ onNavigate }: { onNavigate(): void }) {
  const channels = useStore(s => s.channels);
  const readStates = useStore(s => s.readStates);
  const local = useLocalState();
  const lapses = useMuteLapse(Object.values(local.mutedUntil));
  const rows = useMemo(() => unreadRows({ channels, readStates } as ReadView, id => isMutedAt(local, id)), [channels, readStates, local, lapses]);
  if (rows.length === 0) {
    return (
      <div className="inbox-empty">
        <InboxIcon size={40} />
        <div className="inbox-empty-title">You're all caught up</div>
        <div className="inbox-empty-body">Channels with new messages will show up here.</div>
      </div>
    );
  }
  const hidden = rows.length - MAX_CARDS;
  return (
    <>
      <div className="inbox-unread-bar">
        <span className="inbox-row-sub">{rows.length === 1 ? "1 channel with new messages" : `${rows.length} channels with new messages`}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void markChannelsRead(rows.map(r => r.channel.id))}>
          <CheckCheck size={16} /> Mark All as Read
        </button>
      </div>
      {rows.slice(0, MAX_CARDS).map(r => (
        <UnreadCard key={r.channel.id} {...r} onNavigate={onNavigate} />
      ))}
      {hidden > 0 && <div className="inbox-unread-more">{hidden === 1 ? "1 more channel" : `${hidden} more channels`} with new messages</div>}
    </>
  );
}
