import { useUnsavedShake } from "./unsaved";

/**
 * "Careful, you have unsaved changes" bar shared by the settings pages. While visible it blocks leaving the User, Channel and Server Settings modals
 * (see unsaved.ts) and answers each refused attempt with a shake. Styles: channel-settings.css (`.cs-savebar`), settings-modal.css (`.sm`).
 */
export function SaveBar({ visible, busy, error, saveDisabled, onReset, onSave }: { visible: boolean; busy: boolean; error: string | null; /** Save is not allowed yet (the page lists why). */ saveDisabled?: boolean; onReset(): void; onSave(): void }) {
  const shake = useUnsavedShake(visible);
  if (!visible) return null;
  return (
    <div className="cs-savebar" role="alert" data-shake={shake}>
      <span className="cs-savebar-text">{error ?? "Careful — you have unsaved changes!"}</span>
      <button type="button" className="btn btn-link btn-sm" disabled={busy} onClick={onReset}>
        Reset
      </button>
      <button type="button" className="btn btn-success btn-sm" disabled={busy || saveDisabled} onClick={onSave}>
        {busy ? "Saving…" : "Save Changes"}
      </button>
    </div>
  );
}
