import { Fragment, useState, type KeyboardEvent } from "react";
import { Plus, RotateCcw, X } from "lucide-react";
import { isDesktop } from "../../desktop";
import { Caps, IS_MAC, keyCaps } from "../../keyboard";
import { DEFAULT_KEYBINDS, KEYBIND_ACTIONS, actionById, canBindKeys, effectiveKeybinds, eventKeys, findConflicts, normalizeKeys, toAccelerator } from "../../ui/keybinds";
import { setPref, usePrefs, type KeybindPref } from "../../ui/prefs";
import { Category, Page, Select, Toggle } from "./controls";
import { OverlayHotkeyCategory } from "../../overlay/GameOverlayPage";

function KeyCaps({ keys }: { keys: string }) {
  // Same caps as the shortcuts dialog: Cmd/Option symbols on macOS, Ctrl elsewhere.
  const parts = keyCaps(normalizeKeys(keys).replace("Ctrl", "Mod"), IS_MAC);
  return (
    <>
      {parts.map((k, i) => (
        <Fragment key={`${i}:${k}`}>
          {i > 0 && <span className="keybind-plus" aria-hidden="true">+</span>}
          <kbd className="keybind-key">{k}</kbd>
        </Fragment>
      ))}
    </>
  );
}

/** Button that records the next key combination pressed while it has focus. */
export function Recorder({ keys, onRecord, label }: { keys: string; onRecord(keys: string): void; label: string }) {
  const [recording, setRecording] = useState(false);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    const pressed = eventKeys(event.nativeEvent);
    if (!pressed) return;
    setRecording(false);
    onRecord(pressed);
  };
  return (
    <button
      type="button"
      className={`keybind-recorder${recording ? " recording" : ""}`}
      aria-label={recording ? `Recording keybind for ${label}: press keys` : `Keybind for ${label}: ${keys || "none"}. Click to record.`}
      onClick={() => setRecording(r => !r)}
      onBlur={() => setRecording(false)}
      onKeyDown={onKeyDown}
    >
      {recording ? <span className="keybind-recording">Press keys…</span> : keys ? <KeyCaps keys={keys} /> : <span className="keybind-empty">Record keybind</span>}
    </button>
  );
}

export function KeybindsPage() {
  const stored = usePrefs(s => s.keybinds);
  const customized = stored.length > 0;
  // The page works on current action ids (a list stored by an older build has its ids mapped).
  const rows: KeybindPref[] = customized ? effectiveKeybinds(stored) : [...DEFAULT_KEYBINDS];
  const conflicts = findConflicts(rows);
  /** "Add a Keybind" row: kept here until keys are recorded (the account only stores complete binds). */
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const desktop = isDesktop();

  const save = (next: KeybindPref[]) => {
    setError(null);
    setPref("keybinds", next);
  };
  /** Conflict check before applying recorded keys to row `index` (-1 = the draft row). */
  const takenBy = (keys: string, index: number): KeybindPref | undefined => rows.find((b, i) => i !== index && normalizeKeys(b.keys).toLowerCase() === keys.toLowerCase());
  const record = (index: number, raw: string) => {
    const keys = normalizeKeys(raw);
    const action = index < 0 ? draft : rows[index]?.action;
    if (action && !canBindKeys(keys, action)) {
      setError(`${keys} would block typing: add Ctrl, Alt or ${IS_MAC ? "Cmd" : "the Windows key"}, or use a function key.`);
      return;
    }
    const other = takenBy(keys, index);
    if (other) {
      setError(`${keys} is already used by "${actionById(other.action)?.label ?? other.action}".`);
      return;
    }
    if (index < 0 && draft) {
      save([...rows, { action: draft, keys }]);
      setDraft(null);
    } else save(rows.map((b, i) => (i === index ? { ...b, keys, ...(toAccelerator(keys) ? {} : { global: undefined }) } : b)));
  };
  const add = () => setDraft((KEYBIND_ACTIONS.find(a => !rows.some(b => b.action === a.id)) ?? KEYBIND_ACTIONS[0]!).id);

  const actionOptions = KEYBIND_ACTIONS.map(a => ({ value: a.id, label: a.label }));

  return (
    <Page title="Keybinds">
      <div className="keybinds-toolbar">
        <button type="button" className="btn btn-primary btn-sm" onClick={add} disabled={draft !== null}>
          <Plus size={16} /> Add a Keybind
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!customized && draft === null}
          onClick={() => {
            setDraft(null);
            save([]);
          }}
        >
          <RotateCcw size={16} /> Reset to defaults
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {conflicts.size > 0 && (
        <p className="field-error" role="alert">
          Some keybinds use the same keys. Only the first one runs.
        </p>
      )}
      <Category title={customized ? "Custom Keybinds" : "Default Keybinds"}>
        <table className="keybind-table keybind-editor">
          <thead>
            <tr>
              <th>Action</th>
              <th>Keybind</th>
              {desktop && <th>Global</th>}
              <th>
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((bind, index) => {
              const label = actionById(bind.action)?.label ?? bind.action;
              return (
                <tr key={`${index}:${bind.action}:${bind.keys}`} className={conflicts.has(index) ? "conflict" : undefined}>
                  <td className="keybind-action">
                    <Select<string> label={`Action of keybind ${index + 1}`} value={bind.action} options={actionOptions} onChange={v => save(rows.map((b, i) => (i === index ? { ...b, action: v } : b)))} />
                  </td>
                  <td className="keybind-keys">
                    <Recorder keys={bind.keys} label={label} onRecord={keys => record(index, keys)} />
                  </td>
                  {desktop && (
                    <td className="keybind-global">
                      <Toggle label={`Global keybind for ${label}`} checked={!!bind.global} disabled={!toAccelerator(bind.keys)} onChange={on => save(rows.map((b, i) => (i === index ? { ...b, global: on || undefined } : b)))} />
                    </td>
                  )}
                  <td className="keybind-status">
                    <button type="button" className="keybind-remove" aria-label={`Remove keybind ${label}`} onClick={() => save(rows.filter((_, i) => i !== index))}>
                      <X size={16} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {draft !== null && (
              <tr className="keybind-draft">
                <td className="keybind-action">
                  <Select<string> label="Action of the new keybind" value={draft} options={actionOptions} onChange={setDraft} />
                </td>
                <td className="keybind-keys">
                  <Recorder keys="" label={actionById(draft)?.label ?? draft} onRecord={keys => record(-1, keys)} />
                </td>
                {desktop && <td />}
                <td className="keybind-status">
                  <button type="button" className="keybind-remove" aria-label="Cancel the new keybind" onClick={() => setDraft(null)}>
                    <X size={16} />
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {rows.length === 0 && draft === null && <p className="settings-todo">No keybinds. Add one, or reset to the defaults.</p>}
      </Category>
      <p className="settings-field-note">
        {desktop ? "Global keybinds also work while Vokko is in the background." : "Global keybinds are available in the desktop app."} These are the same shortcuts as the Keyboard shortcuts list (<Caps caps={keyCaps("Mod+/", IS_MAC)} />).
      </p>
      {desktop && <OverlayHotkeyCategory />}
    </Page>
  );
}
