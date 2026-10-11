import { isDesktop } from "../desktop";
import { Category } from "../shell/settings/controls";
import { setPref, usePrefs } from "../ui";
import "./appicon.css";
import { iconUrl } from "./urls";
import { APP_ICONS } from "./variants";

/** Appearance > App Icon: a free perk, every variant is available. The desktop shell applies it to the window, tray and Dock (apply.ts). */
export function AppIconSection() {
  const current = usePrefs(s => s.appIcon);
  return (
    <Category title="App Icon">
      <p className="app-icon-note">
        Pick the icon for the taskbar, Dock and system tray.
        {isDesktop() ? " The Dock entry of a closed app and Cmd+Tab keep the installed icon." : " It is saved here and applied in the desktop app."}
      </p>
      <div className="app-icon-grid" role="radiogroup" aria-label="App icon">
        {APP_ICONS.map(icon => {
          const selected = current === icon.id;
          return (
            <button key={icon.id} type="button" role="radio" aria-checked={selected} aria-label={icon.label} data-app-icon={icon.id} className={`app-icon-tile${selected ? " selected" : ""}`} onClick={() => setPref("appIcon", icon.id)}>
              <img className="app-icon-art" src={iconUrl(icon.id)} alt="" width={64} height={64} />
              <span className="app-icon-label">{icon.label}</span>
            </button>
          );
        })}
      </div>
    </Category>
  );
}
