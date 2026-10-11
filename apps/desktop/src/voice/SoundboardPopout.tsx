import { useState } from "react";
import { Music, Plus, Search, Volume2 } from "lucide-react";
import { useStore } from "../api/store";
import { Popout } from "../ui";
import { useVoice } from "./store";

/**
 * Soundboard popout (anchored above the voice panel / control bar). The soundboard backend is a later milestone, so there are no
 * sounds yet: the layout is the real one (search, server section, "Add Sound" tile) and shows an empty state.
 */
export function SoundboardPopout({ anchor, open, onClose }: { anchor: HTMLElement | null; open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const guildId = useVoice(s => s.guildId);
  const guild = useStore(s => (guildId ? s.guilds[guildId] : undefined));
  return (
    <Popout anchor={anchor} open={open} onClose={onClose} side="top" align="start" gap={8} className="voice-soundboard">
      <div className="voice-soundboard-search">
        <Search size={16} aria-hidden="true" />
        <input className="voice-soundboard-input" placeholder="Find the perfect sound" aria-label="Find the perfect sound" value={query} autoFocus onChange={e => setQuery(e.target.value)} />
        <Volume2 size={18} className="voice-soundboard-volume" aria-hidden="true" />
      </div>
      <div className="voice-soundboard-body">
        <section className="voice-soundboard-section" aria-label={guild?.name ?? "Server sounds"}>
          <h3 className="voice-soundboard-heading">{guild?.name ?? "Server sounds"}</h3>
          <button type="button" className="voice-soundboard-add" aria-disabled="true" title="Uploading sounds arrives with the soundboard update">
            <Plus size={16} aria-hidden="true" /> Add Sound
          </button>
        </section>
        <div className="voice-soundboard-empty">
          <Music size={32} aria-hidden="true" />
          <p>{query ? "No sounds match your search." : "No sounds yet. The soundboard is coming in a later update."}</p>
        </div>
      </div>
    </Popout>
  );
}
