// The soundboard popout body: search, favourites, the current server's sounds, other servers' sounds and the default sounds.
// Clicking a tile plays it for everyone in your voice channel; the speaker button previews it locally (on hover or click).

import { useEffect, useMemo, useState } from "react";
import { Music, Plus, Search, Star, Volume2 } from "lucide-react";
import { Perm } from "../api/permissions";
import { useStore } from "../api/store";
import type { SoundboardSound } from "../api/types";
import { openModal } from "../shell/modalStore";
import { usePermissions } from "../shell/usePermissions";
import { useVoice } from "../voice/store";
import { buildSections, soundKey } from "./helpers";
import { stopPreview } from "./playback";
import { loadDefaults, previewSound, sendSound, setSoundboardVolume, toggleFavorite, useSoundboard } from "./store";
import { usePrefs } from "../ui/prefs";

function SoundTile({ sound, disabled, favorite, onError }: { sound: SoundboardSound; disabled: boolean; favorite: boolean; onError(text: string | null): void }) {
  const [sent, setSent] = useState(false);
  const play = async () => {
    if (disabled) return;
    const error = await sendSound(sound);
    onError(error);
    if (!error) {
      setSent(true);
      setTimeout(() => setSent(false), 600);
    }
  };
  return (
    <div className={`sb-tile${sent ? " sent" : ""}${disabled ? " disabled" : ""}`} data-sound-key={soundKey(sound)}>
      <button type="button" className="sb-tile-play" aria-label={`Play ${sound.name}`} aria-disabled={disabled || undefined} onClick={() => void play()}>
        {sound.emoji_name && (
          <span className="sb-tile-emoji" aria-hidden="true">
            {sound.emoji_name}
          </span>
        )}
        <span className="sb-tile-name">{sound.name}</span>
      </button>
      <button
        type="button"
        className="sb-tile-tool sb-tile-preview"
        aria-label={`Preview ${sound.name}`}
        title="Preview (only you hear it)"
        onMouseEnter={() => previewSound(sound)}
        onMouseLeave={stopPreview}
        onClick={() => previewSound(sound)}
      >
        <Volume2 size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`sb-tile-tool sb-tile-star${favorite ? " on" : ""}`}
        aria-label={favorite ? `Remove ${sound.name} from favorites` : `Add ${sound.name} to favorites`}
        aria-pressed={favorite}
        onClick={() => toggleFavorite(sound)}
      >
        <Star size={14} aria-hidden="true" fill={favorite ? "currentColor" : "none"} />
      </button>
    </div>
  );
}

export function SoundboardPanel() {
  const [query, setQuery] = useState("");
  const [showVolume, setShowVolume] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const voiceGuildId = useVoice(s => s.guildId);
  const inCall = useVoice(s => !!s.channelId);
  const deafened = useVoice(s => s.selfDeaf);
  const guilds = useStore(s => s.guilds);
  const guildOrder = useStore(s => s.guildOrder);
  const { guildSounds, defaults, favorites } = useSoundboard();
  const volume = usePrefs(s => s.soundboardVolume);
  const perms = usePermissions(voiceGuildId);
  const canAdd = perms.can(Perm.CREATE_GUILD_EXPRESSIONS) || perms.can(Perm.MANAGE_GUILD_EXPRESSIONS);

  useEffect(() => {
    if (defaults === null) void loadDefaults();
    return stopPreview;
  }, [defaults]);

  const sections = useMemo(
    () =>
      buildSections({
        query,
        favorites,
        currentGuildId: voiceGuildId,
        guildOrder,
        guildNames: Object.fromEntries(guildOrder.map(id => [id, guilds[id]?.name ?? "Server"])),
        guildSounds,
        defaults: defaults ?? [],
      }),
    [query, favorites, voiceGuildId, guildOrder, guilds, guildSounds, defaults],
  );
  const disabled = !inCall || deafened;
  const currentName = voiceGuildId ? guilds[voiceGuildId]?.name ?? "Server" : null;
  const showCurrentHeader = !!voiceGuildId && !sections.some(s => s.guildId === voiceGuildId) && query.trim() === "";
  const favoriteKeys = new Set(favorites);

  const addButton = (
    <button type="button" className="voice-soundboard-add sb-add" onClick={() => voiceGuildId && openModal({ type: "serverSettings", guildId: voiceGuildId, section: "soundboard" })}>
      <Plus size={16} aria-hidden="true" /> Add Sound
    </button>
  );

  return (
    <>
      <div className="voice-soundboard-search">
        <Search size={16} aria-hidden="true" />
        <input className="voice-soundboard-input" placeholder="Find the perfect sound" aria-label="Find the perfect sound" value={query} autoFocus onChange={e => setQuery(e.target.value)} />
        <button type="button" className="sb-volume-toggle" aria-label="Soundboard volume" aria-expanded={showVolume} onClick={() => setShowVolume(v => !v)}>
          <Volume2 size={18} className="voice-soundboard-volume" aria-hidden="true" />
        </button>
      </div>
      {showVolume && (
        <label className="sb-volume">
          <span>Soundboard volume</span>
          <input type="range" min={0} max={100} value={volume} aria-label="Soundboard volume" onChange={e => setSoundboardVolume(Number(e.target.value))} />
          <span className="sb-volume-value">{volume}%</span>
        </label>
      )}
      {error && (
        <p className="sb-hint sb-error" role="status">
          {error}
        </p>
      )}
      {disabled && <p className="sb-hint">{deafened ? "Soundboard is disabled while deafened. You can still preview sounds." : "Join a voice channel to play sounds. You can still preview them."}</p>}
      <div className="voice-soundboard-body sb-body">
        {showCurrentHeader && (
          <section className="voice-soundboard-section" aria-label={currentName ?? "Server sounds"}>
            <h3 className="voice-soundboard-heading">{currentName}</h3>
            {canAdd && addButton}
          </section>
        )}
        {sections.map(section => (
          <section key={section.id} className="voice-soundboard-section sb-section" aria-label={section.title}>
            <h3 className="voice-soundboard-heading">{section.title}</h3>
            <div className="sb-grid">
              {section.sounds.map(sound => (
                <SoundTile key={soundKey(sound)} sound={sound} disabled={disabled} favorite={favoriteKeys.has(soundKey(sound))} onError={setError} />
              ))}
            </div>
            {section.guildId === voiceGuildId && canAdd && query.trim() === "" && addButton}
          </section>
        ))}
        {sections.length === 0 && (
          <div className="voice-soundboard-empty">
            <Music size={32} aria-hidden="true" />
            <p>{query ? "No sounds match your search." : "No sounds yet."}</p>
          </div>
        )}
      </div>
    </>
  );
}
