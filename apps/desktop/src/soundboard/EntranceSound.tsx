// Entrance sound pickers (User Settings > Voice & Video for the global one, the per-server profile for a server's own) and the
// "Soundboard volume" setting.

import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { useStore } from "../api/store";
import type { Snowflake, SoundboardSound } from "../api/types";
import { Category, Field, Select, Slider } from "../shell/settings/controls";
import { effectiveVolume, soundKey } from "./helpers";
import { playPreview } from "./playback";
import { findSound, loadDefaults, loadEntrance, setEntranceSound, setSoundboardVolume, useSoundboard } from "./store";

const NONE = "none";

/** Picker for the entrance sound of `guildId` (null = global, used in every server without its own). */
export function EntranceSoundField({ guildId }: { guildId: Snowflake | null }) {
  const { defaults, guildSounds, entrance, volume } = useSoundboard();
  const guilds = useStore(s => s.guilds);
  const guildOrder = useStore(s => s.guildOrder);

  useEffect(() => {
    if (defaults === null) void loadDefaults();
    if (entrance === null) void loadEntrance();
  }, [defaults, entrance]);

  const current = entrance?.find(e => e.guild_id === guildId) ?? null;
  const currentSound = current ? findSound({ defaults, guildSounds }, current.sound_id, current.source_guild_id) : null;
  const all: SoundboardSound[] = [...(defaults ?? []), ...guildOrder.flatMap(id => guildSounds[id] ?? [])];
  const label = (sound: SoundboardSound) => `${sound.emoji_name ? `${sound.emoji_name} ` : ""}${sound.name} (${sound.guild_id ? guilds[sound.guild_id]?.name ?? "Server" : "Default"})`;
  const options = [{ value: NONE, label: guildId ? "Use my global entrance sound" : "None" }, ...all.map(sound => ({ value: soundKey(sound), label: label(sound) }))];
  const value = current ? (currentSound ? soundKey(currentSound) : NONE) : NONE;

  const [error, setError] = useState<string | null>(null);
  const change = (key: string) => {
    const sound = all.find(s => soundKey(s) === key) ?? null;
    void setEntranceSound(guildId, sound).then(setError);
  };

  return (
    <Field
      label={guildId ? "Server entrance sound" : "Entrance sound"}
      note={guildId ? "Plays for everyone in the channel when you join a voice channel in this server." : "Plays for everyone in the channel when you join a voice channel, in every server without its own entrance sound."}
    >
      <div className="account-inline sb-entrance">
        <Select<string> label={guildId ? "Server entrance sound" : "Entrance sound"} value={value} options={options} onChange={change} />
        <button type="button" className="btn btn-secondary btn-sm" aria-label="Preview entrance sound" disabled={!currentSound} onClick={() => currentSound && playPreview(currentSound.url, effectiveVolume(currentSound.volume, volume))}>
          <Play size={14} aria-hidden="true" />
        </button>
      </div>
      {error && <p className="field-error">{error}</p>}
    </Field>
  );
}

/** The Soundboard block of User Settings > Voice & Video. */
export function SoundboardVoiceSettings() {
  const volume = useSoundboard(s => s.volume);
  return (
    <Category title="Soundboard">
      <Field label="Soundboard volume" note="How loud sounds others play are for you (each sound also has its own volume).">
        <Slider label="Soundboard volume" value={volume} min={0} max={100} onChange={setSoundboardVolume} format={v => `${v}%`} />
      </Field>
      <EntranceSoundField guildId={null} />
    </Category>
  );
}
