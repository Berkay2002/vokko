import { useState } from "react";
import { useWindowChrome } from "../desktop";
import { toAccelerator } from "../ui/keybinds";
import { Category, Field, Page, Slider, SwitchRow, Unavailable } from "../shell/settings/controls";
import { Recorder } from "../shell/settings/KeybindsPage";
import type { Corner } from "./protocol";
import { setOverlaySetting, useOverlaySettings } from "./settings";
import "./settings.css";

const CORNERS: { value: Corner; label: string }[] = [
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
];

/** A small screen with a button in each corner (Discord's notification-position picker); `allowOff` adds the centre "off" button. */
function CornerPicker({ label, value, onChange, allowOff }: { label: string; value: Corner | "off"; onChange(next: Corner | "off"): void; allowOff?: boolean }) {
  return (
    <div className="ovs-screen" role="radiogroup" aria-label={label}>
      {CORNERS.map(c => (
        <button key={c.value} type="button" role="radio" aria-checked={value === c.value} aria-label={c.label} className={`ovs-corner ovs-${c.value}${value === c.value ? " selected" : ""}`} onClick={() => onChange(c.value)} />
      ))}
      {allowOff && (
        <button type="button" role="radio" aria-checked={value === "off"} className={`ovs-off${value === "off" ? " selected" : ""}`} onClick={() => onChange("off")}>
          Off
        </button>
      )}
    </div>
  );
}

function HotkeyField() {
  const hotkey = useOverlaySettings(s => s.hotkey);
  const [error, setError] = useState<string | null>(null);
  const record = (keys: string) => {
    if (!toAccelerator(keys)) {
      setError(`${keys} can't be a system-wide hotkey. Use a letter, digit, function key or punctuation key with modifiers.`);
      return;
    }
    setError(null);
    setOverlaySetting("hotkey", keys);
  };
  return (
    <Field label="Toggle interactive mode" note="Works only while the overlay shows. Interactive mode takes the mouse so you can mute, deafen and open messages; Esc goes back to the game.">
      <Recorder keys={hotkey} label="Toggle overlay interactive mode" onRecord={record} />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Field>
  );
}

/** The overlay hotkey on the Keybinds page (desktop only), the same setting as on the Game Overlay page. */
export function OverlayHotkeyCategory() {
  return (
    <Category title="Game Overlay">
      <HotkeyField />
    </Category>
  );
}

export function GameOverlayPage() {
  const s = useOverlaySettings();
  const platform = useWindowChrome()?.platform;
  if (platform && platform !== "windows") {
    return (
      <Page title="Game Overlay">
        <Unavailable>The in-game overlay is available on Windows for now.</Unavailable>
      </Page>
    );
  }
  return (
    <Page title="Game Overlay">
      <SwitchRow
        label="Enable in-game overlay"
        note="Shows your call and new messages over games played in borderless or windowed mode. Vokko never touches the game itself, so it is safe with anti-cheat; exclusive fullscreen is not covered."
        checked={s.enabled}
        onChange={on => setOverlaySetting("enabled", on)}
      />
      <HotkeyField />
      <Category title="Voice Widget">
        <Field label="Position">
          <CornerPicker label="Voice widget position" value={s.corner} onChange={v => v !== "off" && setOverlaySetting("corner", v)} />
        </Field>
        <Field label="Opacity" note="Interactive mode is always fully opaque.">
          <Slider label="Overlay opacity" value={s.opacity} min={20} max={100} step={5} format={v => `${v}%`} onChange={v => setOverlaySetting("opacity", v)} />
        </Field>
      </Category>
      <Category title="Notifications">
        <Field label="Notification position" note="Mentions and direct messages, following your notification settings and Do Not Disturb.">
          <CornerPicker label="Notification position" value={s.notifications} onChange={v => setOverlaySetting("notifications", v)} allowOff />
        </Field>
      </Category>
      <Category title="When to Show">
        <SwitchRow label="Only show while in a call" note="Hides message notifications too when you are not in a call." checked={s.onlyInCall} onChange={on => setOverlaySetting("onlyInCall", on)} />
        <SwitchRow label="Show over every window" note="Not only over fullscreen and borderless games." checked={s.always} onChange={on => setOverlaySetting("always", on)} />
      </Category>
    </Page>
  );
}
