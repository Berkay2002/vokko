import { Fragment } from "react";
import { Modal } from "../ui";
import { closeModal } from "./modalStore";
import { GROUPS } from "./settings/KeybindsPage";

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
// The handlers accept Ctrl or Cmd; show the one the platform uses.
const CAP: Record<string, string> = { Up: "↑", Down: "↓", ...(MAC ? { Ctrl: "Cmd" } : {}) };

function Caps({ keys }: { keys: string[] }) {
  return (
    <span className="shortcut-caps">
      {keys.map((k, i) => (
        <Fragment key={k}>
          {i > 0 && <span className="shortcut-plus" aria-hidden="true">+</span>}
          <kbd className="shortcut-cap">{CAP[k] ?? k}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

/** Ctrl+/: the built-in shortcuts as key-cap cards. Only wired shortcuts are listed; Settings > Keybinds has the full table. */
export function ShortcutsModal() {
  return (
    <Modal open onClose={closeModal} title="Keyboard shortcuts" className="shortcuts-modal">
      <p className="shortcuts-sub">
        Press <Caps keys={["Ctrl", "/"]} /> at any time to see this list.
      </p>
      {GROUPS.map(group => {
        const binds = group.binds.filter(b => b.wired);
        if (binds.length === 0) return null;
        return (
          <section key={group.title} className="shortcuts-group">
            <h3 className="shortcuts-heading">{group.title}</h3>
            <div className="shortcuts-grid">
              {binds.map(b => (
                <div key={b.action} className="shortcut-card">
                  <span className="shortcut-action">{b.action}</span>
                  <Caps keys={b.keys} />
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </Modal>
  );
}
