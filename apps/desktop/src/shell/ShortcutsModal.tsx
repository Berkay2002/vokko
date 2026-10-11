import { Fragment } from "react";
import { BINDINGS, IS_MAC, keyCaps, type Binding, type ShortcutGroup } from "../keyboard";
import { Modal } from "../ui";
import { closeModal } from "./modalStore";

const GROUPS: ShortcutGroup[] = ["Navigation", "Unreads", "Chat", "Voice", "Panels"];

/** An Up/Down pair shows its shared modifiers once, then both arrows: ⌥ + ↑ ↓. */
function capsOf(b: Binding): string[] {
  const caps = keyCaps(b.keys[0]!, IS_MAC);
  if (b.keys.length < 2) return caps;
  return [...caps.slice(0, -1), b.keys.map(k => keyCaps(k, IS_MAC).at(-1)).join(" ")];
}

function Caps({ caps }: { caps: string[] }) {
  return (
    <span className="shortcut-caps">
      {caps.map((k, i) => (
        <Fragment key={k}>
          {i > 0 && <span className="shortcut-plus" aria-hidden="true">+</span>}
          <kbd className="shortcut-cap">{k}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

/** Ctrl+/ (Cmd+/ on macOS): every shortcut in the binding table as key-cap cards, with the keys this OS uses. */
export function ShortcutsModal() {
  return (
    <Modal open onClose={closeModal} title="Keyboard shortcuts" className="shortcuts-modal">
      <p className="shortcuts-sub">
        Press <Caps caps={keyCaps("Mod+/", IS_MAC)} /> at any time to see this list.
      </p>
      {GROUPS.map(group => (
        <section key={group} className="shortcuts-group">
          <h3 className="shortcuts-heading">{group}</h3>
          <div className="shortcuts-grid">
            {(BINDINGS as readonly Binding[])
              .filter(b => b.group === group)
              .map(b => (
                <div key={b.id} className="shortcut-card">
                  <span className="shortcut-action">{b.label}</span>
                  <Caps caps={capsOf(b)} />
                </div>
              ))}
          </div>
        </section>
      ))}
    </Modal>
  );
}
