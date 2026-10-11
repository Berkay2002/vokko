import { Fragment } from "react";
import { Category, Page, Unavailable } from "./controls";

interface Bind {
  keys: string[];
  action: string;
  wired?: boolean;
}

const GROUPS: { title: string; binds: Bind[] }[] = [
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
      <Unavailable>Custom keybinds are not available yet. These are the built-in shortcuts.</Unavailable>
      {GROUPS.map(group => (
        <Category key={group.title} title={group.title}>
          <table className="keybind-table">
            <tbody>
              {group.binds.map(b => (
                <tr key={b.action}>
                  <td className="keybind-action">{b.action}</td>
                  <td className="keybind-keys">
                    {b.keys.map((k, i) => (
                      <Fragment key={k}>
                        {i > 0 && <span className="keybind-plus" aria-hidden="true">+</span>}
                        <kbd className="keybind-key">{k}</kbd>
                      </Fragment>
                    ))}
                  </td>
                  <td className="keybind-status">{!b.wired && <span className="keybind-tag">Not wired yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Category>
      ))}
    </Page>
  );
}
