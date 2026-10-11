import { useState, type ReactNode } from "react";
import { AtSign, Bookmark, CalendarClock, Hash, Inbox as InboxIcon, Bell } from "lucide-react";
import { channelMentionCount, dmName, isChannelUnread, useStore } from "../api/store";
import { ChannelType, type Channel } from "../api/types";
import { Popout } from "../ui";
import { markChannelRead } from "./actions";
import { closeModal } from "./modalStore";
import { dmPath, go, guildPath } from "./nav";

type Tab = "unreads" | "mentions" | "bookmarks" | "reminders" | "scheduled";

const TABS: { id: Tab; label: string }[] = [
  { id: "unreads", label: "Unreads" },
  { id: "mentions", label: "Mentions" },
  { id: "bookmarks", label: "Bookmarks" },
  { id: "reminders", label: "Reminders" },
  { id: "scheduled", label: "Scheduled" },
];

const EMPTY: Record<Exclude<Tab, "unreads" | "mentions">, { icon: ReactNode; title: string; body: string }> = {
  bookmarks: { icon: <Bookmark size={40} />, title: "No bookmarks yet", body: "Bookmarked messages will show up here. Not available yet." },
  reminders: { icon: <Bell size={40} />, title: "No reminders", body: "Messages you set a reminder on will show up here. Not available yet." },
  scheduled: { icon: <CalendarClock size={40} />, title: "Nothing scheduled", body: "Scheduled messages will show up here. Not available yet." },
};

/** Inbox popout under the title-bar button. Unreads and Mentions are real; the other tabs are visual. */
export function InboxPopout({ anchor, open }: { anchor: HTMLElement | null; open: boolean }) {
  const [tab, setTab] = useState<Tab>("unreads");
  const rows = useStore(s => {
    const out: { channel: Channel; guildName: string | null; mentions: number }[] = [];
    for (const channel of Object.values(s.channels)) {
      if (channel.type === ChannelType.GuildCategory || channel.type === ChannelType.GuildVoice) continue;
      if (!isChannelUnread(s, channel.id)) continue;
      out.push({ channel, guildName: channel.guild_id ? (s.guilds[channel.guild_id]?.name ?? null) : null, mentions: channelMentionCount(s, channel.id) });
    }
    return out;
  });
  const list = tab === "mentions" ? rows.filter(r => r.mentions > 0) : rows;

  return (
    <Popout anchor={anchor} open={open} onClose={closeModal} side="bottom" align="end" gap={4} className="inbox-popout">
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
        {(tab === "unreads" || tab === "mentions") && list.length === 0 && (
          <div className="inbox-empty">
            {tab === "unreads" ? <InboxIcon size={40} /> : <AtSign size={40} />}
            <div className="inbox-empty-title">{tab === "unreads" ? "You're all caught up" : "No mentions"}</div>
            <div className="inbox-empty-body">{tab === "unreads" ? "Channels with new messages will show up here." : "Messages that mention you will show up here."}</div>
          </div>
        )}
        {(tab === "unreads" || tab === "mentions") &&
          list.map(({ channel, guildName, mentions }) => {
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
        {tab !== "unreads" && tab !== "mentions" && (
          <div className="inbox-empty">
            {EMPTY[tab].icon}
            <div className="inbox-empty-title">{EMPTY[tab].title}</div>
            <div className="inbox-empty-body">{EMPTY[tab].body}</div>
          </div>
        )}
      </div>
    </Popout>
  );
}
