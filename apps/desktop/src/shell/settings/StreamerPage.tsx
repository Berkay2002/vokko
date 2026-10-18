import { isDesktop } from "../../desktop";
import { setPref, usePrefs } from "../../ui";
import { Category, Page, SwitchRow } from "./controls";

/** Settings > Streamer Mode. The effects live where the data is shown (blur classes on <html>, notify/, the desktop window). */
export function StreamerPage() {
  const p = usePrefs();
  const app = isDesktop();
  const on = p.streamerMode;
  return (
    <Page title="Streamer Mode">
      <Category title="Streamer Mode">
        <SwitchRow label="Enable Streamer Mode" note="Hides personal details while you stream or share your screen. A keybind can toggle it too." checked={on} onChange={v => setPref("streamerMode", v)} />
        <SwitchRow
          label="Automatically enable/disable"
          note={app ? "Turns Streamer Mode on while OBS, XSplit or other streaming software runs, and off when it closes." : "Available in the desktop app: it watches for OBS and other streaming software."}
          checked={p.streamerAutoEnable}
          disabled={!app}
          onChange={v => setPref("streamerAutoEnable", v)}
        />
      </Category>
      <Category title="Options">
        <SwitchRow label="Hide personal information" note="Blurs your username, email addresses and linked accounts." checked={p.streamerHidePersonal} disabled={!on} onChange={v => setPref("streamerHidePersonal", v)} />
        <SwitchRow label="Hide invite links" note="Invite links and cards are hidden or blurred." checked={p.streamerHideInvites} disabled={!on} onChange={v => setPref("streamerHideInvites", v)} />
        <SwitchRow label="Disable sounds" note="No notification or call sounds play." checked={p.streamerDisableSounds} disabled={!on} onChange={v => setPref("streamerDisableSounds", v)} />
        <SwitchRow label="Disable notifications" note="No desktop notifications are shown." checked={p.streamerDisableNotifications} disabled={!on} onChange={v => setPref("streamerDisableNotifications", v)} />
        <SwitchRow
          label="Hide Vokko window from screen capture"
          note={app ? "Screen recordings and screen shares show the window as blank." : "Available in the desktop app."}
          checked={p.streamerHideWindow}
          disabled={!on || !app}
          onChange={v => setPref("streamerHideWindow", v)}
        />
      </Category>
    </Page>
  );
}
