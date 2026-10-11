/** "Careful, you have unsaved changes" bar shared by the channel settings pages. */
export function SaveBar({ visible, busy, error, onReset, onSave }: { visible: boolean; busy: boolean; error: string | null; onReset(): void; onSave(): void }) {
  if (!visible) return null;
  return (
    <div className="cs-savebar" role="alert">
      <span className="cs-savebar-text">{error ?? "Careful — you have unsaved changes!"}</span>
      <button type="button" className="btn btn-link btn-sm" disabled={busy} onClick={onReset}>
        Reset
      </button>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onSave}>
        {busy ? "Saving…" : "Save Changes"}
      </button>
    </div>
  );
}
