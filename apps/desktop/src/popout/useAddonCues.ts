// Main's one subtitle job for the pop-out: an addon's cues are a REST call (the pop-out has no login), so main fetches them and relays the
// list. Embedded cues arrive as data in the media room, which the pop-out's own Room receives, so those need nothing from here.

import { useEffect, useState } from "react";
import type { Snowflake, StremioState } from "../api/types";
import { getAddonCues, itemKey, useSubtitleStore } from "../stremio/subtitles";
import type { TextPick } from "../stremio/subtitles";
import type { CuesReply } from "./protocol";

/** The viewer's subtitle choice for the film that plays now (what the tile's Languages menu set). */
export function usePick(channelId: Snowflake, state: StremioState | undefined): TextPick | null {
  const entry = useSubtitleStore(s => s.picks[channelId]);
  return state && entry?.item === itemKey(state) ? entry.pick : null;
}

/** The cues of the chosen addon subtitle once fetched; null while there is none or it is still loading. */
export function useAddonCues(channelId: Snowflake, pick: TextPick | null): CuesReply | null {
  const [reply, setReply] = useState<CuesReply | null>(null);
  const sid = pick?.kind === "addon" ? pick.sid : "";
  useEffect(() => {
    setReply(null);
    if (!sid) return;
    let stale = false;
    getAddonCues(channelId, sid)
      .then(r => !stale && setReply({ sid, cues: r.cues }))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [channelId, sid]);
  return reply;
}
