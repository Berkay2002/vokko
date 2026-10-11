import { useEffect, useRef, useState } from "react";
import { MessageSquareText, Rss } from "lucide-react";
import { ChannelType, type Channel } from "../api/types";
import { Popout, Tooltip } from "../ui";
import { ThreadsPopout } from "./ThreadsPopout";
import { openFollowDialog, useThreadUi } from "./threadUi";
import { hasThreadsType } from "./util";
import "./threads.css";

/**
 * Channel header buttons of this feature: Threads (text and announcement channels, with the popout) and Follow (announcement channels;
 * the dialog explains when no server of the viewer qualifies).
 */
export function ThreadsToolbar({ channel }: { channel: Channel }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const request = useThreadUi(s => s.listRequest);
  const seen = useRef(request);
  useEffect(() => {
    if (request !== seen.current) {
      seen.current = request;
      setOpen(true);
    }
  }, [request]);
  useEffect(() => setOpen(false), [channel.id]);
  const announcement = channel.type === ChannelType.GuildAnnouncement;
  if (!hasThreadsType(channel)) return null;
  return (
    <>
      {announcement && (
        <Tooltip content="Follow" side="bottom">
          <button type="button" className="toolbar-button" aria-label="Follow" onClick={() => openFollowDialog(channel.id)}>
            <Rss size={24} />
          </button>
        </Tooltip>
      )}
      <Tooltip content="Threads" side="bottom">
        <button ref={setAnchor} type="button" className={`toolbar-button${open ? " active" : ""}`} aria-label="Threads" aria-pressed={open} onClick={() => setOpen(o => !o)}>
          <MessageSquareText size={24} />
        </button>
      </Tooltip>
      <Popout anchor={anchor} open={open} onClose={() => setOpen(false)} side="bottom" align="end" gap={8} className="threads-popout-host">
        <ThreadsPopout channel={channel} onClose={() => setOpen(false)} />
      </Popout>
    </>
  );
}
