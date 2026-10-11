import { Caps, IS_MAC, bindingGroups, keyCaps } from "../keyboard";
import { Modal } from "../ui";
import { closeModal } from "./modalStore";

/** Ctrl+/ (Cmd+/ on macOS): every shortcut in the binding table as key-cap cards, with the keys this OS uses. */
export function ShortcutsModal() {
  return (
    <Modal open onClose={closeModal} title="Keyboard shortcuts" className="shortcuts-modal">
      <p className="shortcuts-sub">
        Press <Caps caps={keyCaps("Mod+/", IS_MAC)} /> at any time to see this list.
      </p>
      {bindingGroups().map(group => (
        <section key={group.title} className="shortcuts-group">
          <h3 className="shortcuts-heading">{group.title}</h3>
          <div className="shortcuts-grid">
            {group.binds.map(b => (
              <div key={b.id} className="shortcut-card">
                <span className="shortcut-action">{b.action}</span>
                <Caps caps={b.keys} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </Modal>
  );
}
