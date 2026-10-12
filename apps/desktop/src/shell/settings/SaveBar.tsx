import { useEffect, useRef } from "react";
import { registerUnsaved, useUnsavedShakes } from "./unsaved";

/**
 * "Careful, you have unsaved changes" bar shared by the settings pages. While visible it blocks leaving the User Settings and Channel Settings modals
 * (see unsaved.ts) and answers each refused attempt with a shake. Styles: channel-settings.css (`.cs-savebar`), settings-modal.css (`.sm`).
 */
export function SaveBar({ visible, busy, error, onReset, onSave }: { visible: boolean; busy: boolean; error: string | null; onReset(): void; onSave(): void }) {
  useEffect(() => (visible ? registerUnsaved() : undefined), [visible]);
  const shakes = useUnsavedShakes();
  const mountedAt = useRef(shakes);
  // Re-baseline while hidden so a bar that comes back after Reset does not start out shaking from earlier refusals.
  if (!visible) {
    mountedAt.current = shakes;
    return null;
  }
  const shaken = shakes - mountedAt.current;
  return (
    <div className="cs-savebar" role="alert" data-shake={shaken > 0 ? (shaken % 2 ? "a" : "b") : undefined}>
      <span className="cs-savebar-text">{error ?? "Careful — you have unsaved changes!"}</span>
      <button type="button" className="btn btn-link btn-sm" disabled={busy} onClick={onReset}>
        Reset
      </button>
      <button type="button" className="btn btn-success btn-sm" disabled={busy} onClick={onSave}>
        {busy ? "Saving…" : "Save Changes"}
      </button>
    </div>
  );
}
