// Server Settings > Soundboard: upload (name, emoji, volume, preview and trim to 5.2 s in the browser with WebAudio), edit and
// delete. Every server gets all 48 slots.

import { useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Play, Square, Trash2, Upload } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { Perm } from "../api/permissions";
import { useStore } from "../api/store";
import { SOUNDBOARD_SOUNDS_PER_GUILD, type SoundboardSound } from "../api/types";
import { firstTextChannel } from "../shell/channels";
import { Category, Field, Page, Unavailable } from "../shell/settings/controls";
import { usePermissions } from "../shell/usePermissions";
import { MAX_SECONDS, clampTrim, encodeWav, formatSeconds, initialTrim, isAcceptedAudio, needsReencode, percentToVolume, validateSoundName, volumeToPercent, type Trim } from "./helpers";
import { playPreview, stopPreview } from "./playback";
import { createSound, deleteSound, editSound, refreshGuildSounds, useSoundboard } from "./store";

const errorText = (e: unknown): string => (e instanceof ApiRequestError || e instanceof Error ? e.message : "Something went wrong. Try again.");

interface Picked {
  file: File;
  /** null when the browser could not decode it (it is uploaded as is and the server decides). */
  buffer: AudioBuffer | null;
}

let context: AudioContext | null = null;
function audioContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  context ??= new AudioContext();
  return context;
}

async function decode(file: File): Promise<AudioBuffer | null> {
  const ctx = audioContext();
  if (!ctx) return null;
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    return null;
  }
}

/** Plays the trimmed window of a decoded file; returns a stop function. */
function playWindow(buffer: AudioBuffer, trim: Trim, volume: number, onEnd: () => void): () => void {
  const ctx = audioContext();
  if (!ctx) return () => undefined;
  void ctx.resume();
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.buffer = buffer;
  source.connect(gain).connect(ctx.destination);
  source.onended = onEnd;
  source.start(0, trim.start, Math.max(0.01, trim.end - trim.start));
  return () => {
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
  };
}

const baseName = (name: string): string => name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 32);

function UploadForm({ guildId, uploadChannel, full }: { guildId: string; uploadChannel: string | undefined; full: boolean }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [volume, setVolume] = useState(100);
  const [trim, setTrim] = useState<Trim>({ start: 0, end: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const duration = picked?.buffer?.duration ?? 0;

  useEffect(() => () => stop.current?.(), []);

  const reset = () => {
    stop.current?.();
    setPicked(null);
    setName("");
    setEmoji("");
    setVolume(100);
    setError(null);
    setPlaying(false);
    if (input.current) input.current.value = "";
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!isAcceptedAudio(file)) {
      setError("Sounds must be MP3, OGG or WAV files.");
      return;
    }
    const buffer = await decode(file);
    setPicked({ file, buffer });
    setTrim(initialTrim(buffer?.duration ?? 0));
    if (!name.trim()) setName(baseName(file.name));
  };

  const togglePreview = () => {
    if (playing) {
      stop.current?.();
      setPlaying(false);
      return;
    }
    if (!picked?.buffer) return;
    stop.current = playWindow(picked.buffer, trim, volume / 100, () => setPlaying(false));
    setPlaying(true);
  };

  const submit = async () => {
    if (!picked || !uploadChannel) return;
    const nameError = validateSoundName(name);
    if (nameError) return setError(nameError);
    setBusy(true);
    setError(null);
    try {
      let file = picked.file;
      if (picked.buffer && needsReencode(file, duration, trim)) {
        const channels = Array.from({ length: picked.buffer.numberOfChannels }, (_, i) => picked.buffer?.getChannelData(i) ?? new Float32Array());
        const bytes = encodeWav(channels, picked.buffer.sampleRate, trim.start, trim.end);
        file = new File([bytes as BlobPart], `${baseName(picked.file.name) || "sound"}.wav`, { type: "audio/wav" });
      }
      await createSound(guildId, uploadChannel, file, { name: name.trim(), volume: percentToVolume(volume), ...(emoji.trim() ? { emoji_name: emoji.trim() } : {}) });
      reset();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Category title="Upload Sound">
      {!picked ? (
        <div className="sb-upload-start">
          <p className="settings-todo">MP3, OGG or WAV. Longer clips can be trimmed to {MAX_SECONDS} seconds here before they are uploaded.</p>
          <button type="button" className="btn btn-primary btn-sm" disabled={full || !uploadChannel} onClick={() => input.current?.click()}>
            <Upload size={14} aria-hidden="true" /> Upload Sound
          </button>
          {full && <p className="settings-todo">All {SOUNDBOARD_SOUNDS_PER_GUILD} slots are used. Delete a sound to add another.</p>}
        </div>
      ) : (
        <div className="sb-upload-form">
          <Field label="File">
            <div className="account-inline">
              <span className="sb-file-name">{picked.file.name}</span>
              {picked.buffer ? <span className="settings-todo">{formatSeconds(duration)}</span> : <span className="settings-todo">This browser could not read the file; it is uploaded as is.</span>}
            </div>
          </Field>
          {picked.buffer && (
            <Field label="Trim" note={`Up to ${MAX_SECONDS} seconds. Selected: ${formatSeconds(trim.end - trim.start)}.`}>
              <div className="sb-trim">
                <label>
                  Start
                  <input type="range" aria-label="Trim start" min={0} max={duration} step={0.01} value={trim.start} onChange={e => setTrim(t => clampTrim({ ...t, start: Number(e.target.value) }, duration, "start"))} />
                  <span>{formatSeconds(trim.start)}</span>
                </label>
                <label>
                  End
                  <input type="range" aria-label="Trim end" min={0} max={duration} step={0.01} value={trim.end} onChange={e => setTrim(t => clampTrim({ ...t, end: Number(e.target.value) }, duration, "end"))} />
                  <span>{formatSeconds(trim.end)}</span>
                </label>
              </div>
            </Field>
          )}
          <Field label="Sound name">
            <input className="input" aria-label="Sound name" value={name} maxLength={32} onChange={e => setName(e.target.value)} />
          </Field>
          <Field label="Related emoji" note="Shown on the sound's tile and flashed on your tile when you play it.">
            <input className="input sb-emoji-input" aria-label="Related emoji" value={emoji} maxLength={16} placeholder="🎺" onChange={e => setEmoji(e.target.value)} />
          </Field>
          <Field label="Volume">
            <div className="account-inline">
              <input type="range" aria-label="Sound volume" min={0} max={100} value={volume} onChange={e => setVolume(Number(e.target.value))} />
              <span className="settings-todo">{volume}%</span>
            </div>
          </Field>
          <div className="account-inline">
            <button type="button" className="btn btn-secondary btn-sm" disabled={!picked.buffer} onClick={togglePreview}>
              {playing ? <Square size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />} {playing ? "Stop" : "Preview"}
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || full} onClick={() => void submit()}>
              {busy ? "Uploading…" : "Upload"}
            </button>
            <button type="button" className="btn btn-link btn-sm" disabled={busy} onClick={reset}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <input ref={input} type="file" accept=".mp3,.ogg,.oga,.opus,.wav,audio/mpeg,audio/ogg,audio/wav" hidden aria-label="Sound file" onChange={e => void pick(e.target.files?.[0])} />
    </Category>
  );
}

function SoundRow({ guildId, sound, canEdit }: { guildId: string; sound: SoundboardSound; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(sound.name);
  const [emoji, setEmoji] = useState(sound.emoji_name ?? "");
  const [volume, setVolume] = useState(volumeToPercent(sound.volume));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const nameError = validateSoundName(name);
    if (nameError) return setError(nameError);
    setBusy(true);
    try {
      await editSound(guildId, sound.sound_id, { name: name.trim(), volume: percentToVolume(volume), emoji_name: emoji.trim() || null });
      setEditing(false);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await deleteSound(guildId, sound.sound_id);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <li className="sb-row" data-sound-id={sound.sound_id}>
      <div className="sb-row-main">
        <span className="sb-row-emoji" aria-hidden="true">
          {sound.emoji_name ?? "🔈"}
        </span>
        {editing ? (
          <div className="sb-row-edit">
            <input className="input" aria-label="Sound name" value={name} maxLength={32} onChange={e => setName(e.target.value)} />
            <input className="input sb-emoji-input" aria-label="Related emoji" value={emoji} maxLength={16} onChange={e => setEmoji(e.target.value)} />
            <input type="range" aria-label="Sound volume" min={0} max={100} value={volume} onChange={e => setVolume(Number(e.target.value))} />
            <span className="settings-todo">{volume}%</span>
          </div>
        ) : (
          <div className="sb-row-text">
            <span className="sb-row-name">{sound.name}</span>
            <span className="settings-todo">
              {volumeToPercent(sound.volume)}% volume{sound.user ? ` · uploaded by ${sound.user.global_name ?? sound.user.username}` : ""}
            </span>
          </div>
        )}
        <div className="sb-row-actions">
          <button type="button" className="btn btn-link btn-sm" aria-label={`Preview ${sound.name}`} onClick={() => playPreview(sound.url, editing ? volume / 100 : sound.volume)}>
            <Play size={14} aria-hidden="true" />
          </button>
          {canEdit &&
            (editing ? (
              <>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void save()}>
                  Save
                </button>
                <button type="button" className="btn btn-link btn-sm" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-link btn-sm" aria-label={`Edit ${sound.name}`} onClick={() => setEditing(true)}>
                  <Pencil size={14} aria-hidden="true" />
                </button>
                <button type="button" className="btn btn-link btn-sm sb-danger" aria-label={`Delete ${sound.name}`} disabled={busy} onClick={() => void remove()}>
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </>
            ))}
        </div>
      </div>
      {error && <p className="field-error">{error}</p>}
    </li>
  );
}

export function SoundboardSettingsPage({ guildId }: { guildId: string }) {
  const sounds = useSoundboard(s => s.guildSounds[guildId]);
  const meId = useStore(s => s.me?.id);
  const allChannels = useStore(s => s.channels);
  const perms = usePermissions(guildId);
  const channels = useMemo(() => Object.values(allChannels).filter(c => c.guild_id === guildId), [allChannels, guildId]);
  const uploadChannel = firstTextChannel(channels)?.id ?? channels[0]?.id;
  const canManage = perms.can(Perm.MANAGE_GUILD_EXPRESSIONS);
  const canCreate = canManage || perms.can(Perm.CREATE_GUILD_EXPRESSIONS);
  const list = sounds ?? [];

  useEffect(() => {
    void refreshGuildSounds(guildId);
    return stopPreview;
  }, [guildId]);

  return (
    <Page title="Soundboard">
      <p className="settings-todo">
        Upload sounds for everyone in this server to play in voice channels. Members can use them in any server's voice channel too. {list.length} of {SOUNDBOARD_SOUNDS_PER_GUILD} slots used.
      </p>
      {canCreate ? <UploadForm guildId={guildId} uploadChannel={uploadChannel} full={list.length >= SOUNDBOARD_SOUNDS_PER_GUILD} /> : <Unavailable>You need the Create Expressions permission to upload sounds.</Unavailable>}
      <Category title="Sounds">
        {list.length === 0 ? (
          <p className="settings-todo">No sounds yet.</p>
        ) : (
          <ul className="sb-rows" aria-label="Server sounds">
            {list.map(sound => (
              <SoundRow key={sound.sound_id} guildId={guildId} sound={sound} canEdit={canManage || (canCreate && sound.user?.id === meId)} />
            ))}
          </ul>
        )}
      </Category>
    </Page>
  );
}
