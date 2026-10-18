import { useState } from "react";
import { Inbox as InboxIcon } from "lucide-react";
import { Popout } from "../ui";
import { MentionList, ReminderList, SavedMessages } from "../media/InboxLists";
import { UnreadList } from "./InboxUnreads";
import { closeModal } from "./modalStore";

type Tab = "unreads" | "mentions" | "bookmarks" | "reminders";

const TABS: { id: Tab; label: string }[] = [
  { id: "unreads", label: "Unreads" },
  { id: "mentions", label: "Mentions" },
  { id: "bookmarks", label: "Bookmarks" },
  { id: "reminders", label: "Reminders" },
];

/** Inbox popout under the title-bar button (a bottom sheet on a phone, opened from the account card). Unreads come from read states, Mentions, Bookmarks and Reminders from the server. */
export function InboxPopout({ anchor, open, side = "bottom" }: { anchor: HTMLElement | null; open: boolean; side?: "top" | "bottom" }) {
  const [tab, setTab] = useState<Tab>("unreads");
  return (
    <Popout anchor={anchor} open={open} onClose={closeModal} side={side} align="end" gap={side === "top" ? 8 : 4} className="inbox-popout" sheet="Inbox">
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
        {tab === "unreads" && <UnreadList onNavigate={closeModal} />}
        {tab === "mentions" && <MentionList onNavigate={closeModal} />}
        {tab === "bookmarks" && <SavedMessages onNavigate={closeModal} />}
        {tab === "reminders" && <ReminderList onNavigate={closeModal} />}
      </div>
    </Popout>
  );
}
