import { Fragment } from "react";
import { Category, Page } from "./controls";
import { InfoBanner } from "./smControls";

interface Bind {
  keys: string[];
  action: string;
  wired?: boolean;
}

export const GROUPS: { title: string; binds: Bind[] }[] = [
  {
    title: "Navigation",
    binds: [
      { keys: ["Ctrl", "K"], action: "Quick switcher", wired: true },
      { keys: ["Alt", "Up"], action: "Previous channel", wired: true },
      { keys: ["Alt", "Down"], action: "Next channel", wired: true },
      { keys: ["Ctrl", "Alt", "Up"], action: "Previous server", wired: true },
      { keys: ["Ctrl", "Alt", "Down"], action: "Next server", wired: true },
      { keys: ["Ctrl", "Shift", "N"], action: "Create or join a server", wired: true },
      { keys: ["Ctrl", "I"], action: "Open inbox", wired: true },
    ],
  },
  {
    title: "Messaging",
    binds: [
      { keys: ["Ctrl", "U"], action: "Toggle member list / user profile", wired: true },
      { keys: ["Ctrl", "P"], action: "Toggle pinned messages" },
      { keys: ["Up"], action: "Edit your last message", wired: true },
    ],
  },
  {
    title: "Voice",
    binds: [
      { keys: ["Ctrl", "Shift", "M"], action: "Toggle mute" },
      { keys: ["Ctrl", "Shift", "D"], action: "Toggle deafen" },
    ],
  },
  {
    title: "Misc",
    binds: [
      { keys: ["Ctrl", "/"], action: "Show keyboard shortcuts", wired: true },
      { keys: ["Shift", "Esc"], action: "Mark server as read", wired: true },
      { keys: ["Esc"], action: "Mark channel as read", wired: true },
    ],
  },
];

export function KeybindsPage() {
  return (
    <Page title="Keybinds">
      <Category title="Custom Keybinds">
        <p className="sm-sub-note">Custom keybinds let you perform specific actions in Vokko without clicking through menus.</p>
        <InfoBanner>Custom keybinds are not available yet. The built-in shortcuts are listed below.</InfoBanner>
      </Category>
      <Category title="Default Keybinds">
        {GROUPS.map(group => (
          <section key={group.title} className="sm-keys-group" aria-label={group.title}>
            <h3 className="sm-sub-heading">{group.title}</h3>
            <div className="sm-keys-card">
              {group.binds.map(b => (
                <div key={b.action} className="sm-keys-row">
                  <span className="sm-keys-action">{b.action}</span>
                  {!b.wired && <span className="sm-keys-tag">Not wired yet</span>}
                  <span className="sm-keys-caps">
                    {b.keys.map((k, i) => (
                      <Fragment key={k}>
                        {i > 0 && <span className="keybind-plus" aria-hidden="true">+</span>}
                        <kbd className="sm-keys-cap">{k}</kbd>
                      </Fragment>
                    ))}
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
