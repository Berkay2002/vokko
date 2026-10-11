import { Caps, bindingGroups } from "../../keyboard";
import { Category, Page } from "./controls";
import { InfoBanner } from "./smControls";

export function KeybindsPage() {
  return (
    <Page title="Keybinds">
      <Category title="Custom Keybinds">
        <p className="sm-sub-note">Custom keybinds let you perform specific actions in Vokko without clicking through menus.</p>
        <InfoBanner>Custom keybinds are not available yet. The built-in shortcuts are listed below.</InfoBanner>
      </Category>
      <Category title="Default Keybinds">
        {bindingGroups().map(group => (
          <section key={group.title} className="sm-keys-group" aria-label={group.title}>
            <h3 className="sm-sub-heading">{group.title}</h3>
            <div className="sm-keys-card">
              {group.binds.map(b => (
                <div key={b.id} className="sm-keys-row">
                  <span className="sm-keys-action">{b.action}</span>
                  <span className="sm-keys-caps">
                    <Caps caps={b.keys} />
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </Category>
    </Page>
  );
}
