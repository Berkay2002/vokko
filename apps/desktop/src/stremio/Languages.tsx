// Audio and subtitles of a Stremio session: the Languages button of the tile controls, its menu, and the subtitle line over the picture.
// Audio and a burned-in picture subtitle are the session's, so choosing one changes it for everyone (the menu says so). Text subtitles
// are this viewer's own (see ./subtitles.ts). Subtitle text is shown as React text, never HTML.

import { useEffect, useState } from "react";
import { Check, Languages } from "lucide-react";
import type { Snowflake, StremioAddonSubtitles, StremioCue, StremioState } from "../api/types";
import { Tooltip } from "../ui";
import { controlStremio } from "./api";
import { reason } from "./format";
import {
  activeCue,
  addCue,
  getAddonCues,
  itemKey,
  languageName,
  listAddonSubtitles,
  onCues,
  preferredTrack,
  readLang,
  subtitleTopic,
  trackName,
  useSubtitleStore,
  writeLang,
  type TextPick,
} from "./subtitles";

function Row({ label, hint, checked, onClick }: { label: string; hint?: string; checked: boolean; onClick(): void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} className="stremio-language-row" onClick={onClick}>
      <span className="stremio-language-check">{checked && <Check size={14} aria-hidden="true" />}</span>
      <span className="stremio-language-name">{label}</span>
      {hint && <span className="stremio-language-hint">{hint}</span>}
    </button>
  );
}

/** The Languages button with its menu, and the subtitle line. Mount inside the tile's control row. */
export function LanguagesMenu({ channelId, state, positionMs }: { channelId: Snowflake; state: StremioState; positionMs: number }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addons, setAddons] = useState<StremioAddonSubtitles | null>(null);
  const [cues, setCues] = useState<StremioCue[]>([]);
  const item = itemKey(state);
  const entry = useSubtitleStore(s => s.picks[channelId]);
  const setPick = useSubtitleStore(s => s.set);
  const pick: TextPick | null = entry?.item === item ? entry.pick : null;
  const decided = entry?.item === item;
  const audio = state.audio_tracks ?? [];
  const subs = state.subtitle_tracks ?? [];
  const texts = subs.filter(t => t.kind === "text");
  const bitmaps = subs.filter(t => t.kind === "bitmap");

  // A new film: the addon list belongs to the old one. With no choice made yet, take the text track in the language used last time.
  useEffect(() => setAddons(null), [item]);
  useEffect(() => {
    if (decided) return;
    const id = preferredTrack(state, readLang());
    if (id !== undefined) setPick(channelId, item, { kind: "text", id, lang: subs.find(t => t.id === id)?.language });
  }, [decided, state, channelId, item, subs, setPick]);

  // The cues of the chosen subtitle: embedded ones arrive as data in the media room, an addon's come from the server in one piece.
  const pickKey = pick ? (pick.kind === "text" ? `t${pick.id}` : `a${pick.sid}`) : "";
  useEffect(() => {
    setCues([]);
    if (!pick) return;
    if (pick.kind === "text") {
      const topic = subtitleTopic(pick.id);
      return onCues(state.bot_identity, (t, cue) => t === topic && setCues(list => addCue(list, cue)));
    }
    let stale = false;
    getAddonCues(channelId, pick.sid)
      .then(r => !stale && setCues(r.cues))
      .catch(e => !stale && setError(reason(e)));
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the pick's identity is pickKey
  }, [pickKey, item, state.bot_identity, channelId]);

  useEffect(() => {
    if (!open || addons) return;
    let stale = false;
    // Not linked to Stremio, or the server is busy: the file's own tracks still work, so this is not an error banner.
    listAddonSubtitles(channelId)
      .then(r => !stale && setAddons(r))
      .catch(() => !stale && setAddons({ subtitles: [], addon_errors: ["unreachable"] }));
    return () => {
      stale = true;
    };
  }, [open, addons, channelId]);

  const run = (promise: Promise<unknown>) => {
    setError(null);
    promise.catch(e => setError(reason(e)));
  };
  const chooseAudio = (id: number) => id !== state.audio && run(controlStremio(channelId, { audio: id }));
  const chooseText = (next: TextPick | null) => {
    setPick(channelId, item, next);
    if (next) writeLang(next.lang);
  };
  const off = () => {
    chooseText(null);
    if (state.burned_subtitle !== undefined) run(controlStremio(channelId, { burned_subtitle: null }));
  };
  const burn = (id: number) => {
    chooseText(null);
    run(controlStremio(channelId, { burned_subtitle: id }));
  };

  const cue = pick ? activeCue(cues, positionMs) : undefined;
  const nothingOn = !pick && state.burned_subtitle === undefined;
  const label = audio.length || subs.length ? "Audio and subtitles" : "Languages";

  return (
    <>
      {cue && (
        <div className="stremio-cue" data-testid="stremio-cue">
          <span>{cue.text}</span>
        </div>
      )}
      <Tooltip content={label} side="top">
        <button type="button" className={`stremio-button${open ? " active" : ""}`} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <Languages size={18} />
        </button>
      </Tooltip>
      {open && (
        <div className="stremio-languages" role="menu" aria-label={label} onKeyDown={e => e.key === "Escape" && setOpen(false)}>
          <section aria-label="Audio">
            <h3 className="stremio-languages-title">Audio</h3>
            <p className="stremio-languages-note">Everyone hears the same audio.</p>
            {audio.length === 0 && <p className="stremio-languages-note">Not known yet.</p>}
            {audio.map(t => (
              <Row key={t.id} label={trackName(t)} hint={t.codec} checked={t.id === state.audio} onClick={() => chooseAudio(t.id)} />
            ))}
          </section>
          <section aria-label="Subtitles">
            <h3 className="stremio-languages-title">Subtitles</h3>
            <Row label="Off" checked={nothingOn} onClick={off} />
            {texts.map(t => (
              <Row key={t.id} label={trackName(t)} hint={t.forced ? "forced" : undefined} checked={pick?.kind === "text" && pick.id === t.id} onClick={() => chooseText({ kind: "text", id: t.id, lang: t.language })} />
            ))}
            {bitmaps.map(t => (
              <Row key={t.id} label={trackName(t)} hint="shown to everyone" checked={state.burned_subtitle === t.id} onClick={() => burn(t.id)} />
            ))}
            {addons && addons.subtitles.length > 0 && <h4 className="stremio-languages-sub">From your addons</h4>}
            {addons?.subtitles.map(s => (
              <Row key={s.sid} label={languageName(s.language)} hint={s.addon} checked={pick?.kind === "addon" && pick.sid === s.sid} onClick={() => chooseText({ kind: "addon", sid: s.sid, lang: s.language })} />
            ))}
            {!addons && <p className="stremio-languages-note">Looking for more…</p>}
            {addons && addons.subtitles.length === 0 && subs.length === 0 && <p className="stremio-languages-note">No subtitles found.</p>}
            {addons && addons.addon_errors.length > 0 && <p className="stremio-languages-note">Some addons did not answer.</p>}
          </section>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}
