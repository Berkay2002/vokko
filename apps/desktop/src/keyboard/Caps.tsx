import { Fragment } from "react";

/** Key caps joined by "+", as the shortcuts dialog and Settings > Keybinds draw them. */
export function Caps({ caps }: { caps: string[] }) {
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
