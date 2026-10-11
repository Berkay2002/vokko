import { useEffect, useState } from "react";
import { Field, Slider } from "../shell/settings/controls";
import { setPttKey, setPttReleaseMs } from "./engine";
import { acceleratorFromEvent, probeShortcut, usePttGlobal } from "./ptt";
import { useVoice } from "./store";

/** Push-to-talk keybind recorder and release delay, shown in Voice & Video settings while the input mode is Push to Talk. */
export function PttSettings() {
  const key = useVoice(s => s.settings.pttKey);
  const release = useVoice(s => s.settings.pttReleaseMs);
  const [recording, setRecording] = useState(false);
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const refused = usePttGlobal(s => s.refused);
  const inCall = useVoice(s => s.channelId !== null);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) return; // wait for a non-modifier key
      setPttKey(accelerator);
      setRecording(false);
      setProbeNote(null);
      // While in a call with the same key the shortcut is already ours: probing would only report "already registered".
      if (!(inCall && key === accelerator)) void probeShortcut(accelerator).then(setProbeNote);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, inCall, key]);

  return (
    <>
      <Field label="Shortcut" note="Hold this key to talk. In the desktop app it works while Vokko is in the background; in the browser only while this window has focus.">
        <div className="sp-actions ptt-keybind">
          <kbd className={`ptt-key${recording ? " recording" : ""}`} aria-live="polite">
            {recording ? "Press a key…" : (key ?? "No keybind set")}
          </kbd>
          <button type="button" className="sp-button" onClick={() => setRecording(r => !r)}>
            {recording ? "Cancel" : key ? "Edit Keybind" : "Record Keybind"}
          </button>
          {key && !recording && (
            <button type="button" className="sp-button" onClick={() => setPttKey(null)}>
              Clear
            </button>
          )}
        </div>
      </Field>
      {(refused ?? probeNote) && (
        <p className="field-error" role="alert" data-testid="ptt-refused">
          {refused ?? probeNote}
        </p>
      )}
      <Field label="Push to Talk release delay">
        <Slider label="Push to Talk release delay" value={release} min={0} max={2000} step={10} onChange={setPttReleaseMs} format={v => `${v} ms`} />
      </Field>
    </>
  );
}
