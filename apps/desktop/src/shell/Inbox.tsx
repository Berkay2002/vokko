import { useMemo, useState } from "react";
import { Hash, Inbox as InboxIcon } from "lucide-react";
import { channelMentionCount, dmName, isChannelUnread, useStore } from "../api/store";
import { ChannelType, type Channel } from "../api/types";
import { Popout } from "../ui";
import { markChannelRead } from "./actions";
import { MentionList, ReminderList, SavedMessages } from "../media/InboxLists";
import { mutedTest, useMutedUntil } from "./localState";
import { closeModal } from "./modalStore";
import { dmPath, go, guildPath } from "./nav";

type Tab = "unreads" | "mentions" | "bookmarks" | "reminders";

const TABS: { id: Tab; label: string }[] = [
  { id: "unreads", label: "Unreads" },
  { id: "mentions", label: "Mentions" },
  { id: "bookmarks", label: "Bookmarks" },
  { id: "reminders", label: "Reminders" },
];

/** Inbox popout under the title-bar button (above the account card on a phone). Unreads come from read states, Mentions, Bookmarks and Reminders from the server. */
export function InboxPopout({ anchor, open, side = "bottom" }: { anchor: HTMLElement | null; open: boolean; side?: "top" | "bottom" }) {
  const [tab, setTab] = useState<Tab>("unreads");
  const channels = useStore(s => s.channels);
  const readStates = useStore(s => s.readStates);
  const guilds = useStore(s => s.guilds);
  const mutedUntil = useMutedUntil();
  const rows = useMemo(() => {
    if (!open || tab !== "unreads") return [];
    const state = { channels, readStates } as Parameters<typeof isChannelUnread>[0];
    const muted = mutedTest({ mutedUntil });
    const out: { channel: Channel; guildName: string | null; mentions: number }[] = [];
    for (const channel of Object.values(channels)) {
      if (channel.type === ChannelType.GuildCategory || channel.type === ChannelType.GuildVoice) continue;
      if (!isChannelUnread(state, channel.id)) continue;
      // A muted channel (or one in a muted category) is quiet here, as in its channel row; its mentions live on the Mentions tab.
      if (muted(channel.id) || (channel.parent_id != null && muted(channel.parent_id))) continue;
      out.push({ channel, guildName: channel.guild_id ? (guilds[channel.guild_id]?.name ?? null) : null, mentions: channelMentionCount(state, channel.id) });
    }
    return out;
  }, [open, tab, channels, readStates, guilds, mutedUntil]);

  return (
    <Popout anchor={anchor} open={open} onClose={closeModal} side={side} align="end" gap={side === "top" ? 8 : 4} className="inbox-popout">
      <div className="inbox-header">
        <InboxIcon size={20} />
        <span className="inbox-title">Inbox</span>
      </div>
      <div className="inbox-tabs" role="tablist">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`inbox-tab${tab === t.id ? " selected" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="inbox-body">
        {tab === "unreads" && rows.length === 0 && (
          <div className="inbox-empty">
            <InboxIcon size={40} />
            <div className="inbox-empty-title">You're all caught up</div>
            <div className="inbox-empty-body">Channels with new messages will show up here.</div>
          </div>
        )}
        {tab === "unreads" &&
          rows.map(({ channel, guildName, mentions }) => {
            const guildId = channel.guild_id;
            const name = guildId ? (channel.name ?? "") : dmName(channel);
            return (
              <div key={channel.id} className="inbox-row">
                <button
                  type="button"
                  className="inbox-row-main"
                  onClick={() => {
                    closeModal();
                    go(guildId ? guildPath(guildId, channel.id) : dmPath(channel.id));
                  }}
                >
                  <span className="inbox-row-icon">{guildId ? <Hash size={18} /> : <InboxIcon size={18} />}</span>
                  <span className="inbox-row-text">
                    <span className="inbox-row-name">{name}</span>
                    {guildName && <span className="inbox-row-sub">{guildName}</span>}
                  </span>
                  {mentions > 0 && <span className="inbox-row-badge">{mentions}</span>}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void markChannelRead(channel.id)}>
                  Mark as Read
                </button>
              </div>
            );
          })}
        {tab === "mentions" && <MentionList onNavigate={closeModal} />}
        {tab === "bookmarks" && <SavedMessages onNavigate={closeModal} />}
        {tab === "reminders" && <ReminderList onNavigate={closeModal} />}
      </div>
    </Popout>
  );
}
