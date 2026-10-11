import { useEffect, useState } from "react";
import { Volume2 } from "lucide-react";
import { isDesktop } from "../../desktop";
import { SOUND_LABELS, notificationAdapter, previewSound, type NotificationSoundName, type PermissionState } from "../../notify";
import { isSoundEnabled, withSoundEnabled, withSoundsEnabled } from "../../notify/soundCatalog";
import { setPref, usePrefs } from "../../ui";
import { Category, Field, Page, RadioGroup, SwitchRow, Unavailable } from "./controls";

type ReactionNotifications = "all" | "dm" | "never";

const PERMISSION_TEXT: Record<PermissionState, string> = {
  granted: "Allowed by your system.",
  denied: "Blocked by your system. Allow notifications for Vokko in your browser or system settings.",
  default: "Not asked yet: turning this on asks for permission.",
  unsupported: "This browser cannot show notifications.",
};

const SOUNDS = Object.keys(SOUND_LABELS) as NotificationSoundName[];

export function NotificationsPage() {
  const desktop = usePrefs(s => s.desktopNotifications);
  const reactions = usePrefs(s => s.reactionNotifications);
  const sounds = usePrefs(s => s.notificationSounds);
  const soundCurrent = usePrefs(s => s.soundCurrentChannel);
  const badge = usePrefs(s => s.unreadBadge);
  const flash = usePrefs(s => s.taskbarFlash);
  const disabled = usePrefs(s => s.disabledSounds);
  const [permission, setPermission] = useState<PermissionState | null>(null);
  const app = isDesktop();

  useEffect(() => {
    let live = true;
    notificationAdapter()
      .permission()
      .then(state => live && setPermission(state))
      .catch(() => live && setPermission("unsupported"));
    return () => {
      live = false;
    };
  }, []);

  const setDesktop = async (on: boolean) => {
    if (!on) {
      setPref("desktopNotifications", false);
      return;
    }
    // Optimistic: flip now, revert if the permission is refused.
    setPref("desktopNotifications", true);
    let result: PermissionState = "denied";
    try {
      result = await notificationAdapter().request();
    } catch {
      result = "denied";
    }
    setPermission(result);
    if (result !== "granted") setPref("desktopNotifications", false);
  };

  const allOff = SOUNDS.every(name => !isSoundEnabled(disabled, name));
  const setSound = (name: NotificationSoundName, on: boolean) => setPref("disabledSounds", withSoundEnabled(disabled, name, on));

  return (
    <Page title="Notifications">
      <Category title="Overview">
        <SwitchRow
          label="Enable desktop notifications"
          note={
            <>
              Get a pop-up when something happens while Vokko is in the background.{" "}
              <span className="notify-permission" data-state={permission ?? "unknown"}>
                {permission ? PERMISSION_TEXT[permission] : "Checking permission…"}
              </span>
            </>
          }
          checked={desktop}
          disabled={permission === "unsupported"}
          onChange={on => void setDesktop(on)}
        />
        <Field label="Reaction notifications">
          <RadioGroup<ReactionNotifications>
            name="Reaction notifications"
            value={reactions}
            onChange={v => setPref("reactionNotifications", v)}
            options={[
              { value: "all", label: "All reactions" },
              { value: "dm", label: "Only in direct messages" },
              { value: "never", label: "Never" },
            ]}
          />
        </Field>
      </Category>

      <Category title="Badges">
        <SwitchRow label="Enable unread message badge" note="Shows a count on the app icon, the tab title and the favicon." checked={badge} onChange={v => setPref("unreadBadge", v)} />
        <SwitchRow
          label="Enable taskbar flashing"
          note={app ? "Flashes the taskbar button when you get a mention or a DM in the background." : "Available in the desktop app."}
          checked={flash}
          disabled={!app}
          onChange={v => setPref("taskbarFlash", v)}
        />
      </Category>

      <Category title="Sounds">
        <SwitchRow label="Play notification sounds" checked={sounds} onChange={v => setPref("notificationSounds", v)} />
        <SwitchRow label="Play sounds for the channel you are viewing" checked={soundCurrent} onChange={v => setPref("soundCurrentChannel", v)} />
        <div className="notify-sounds-head">
          <span className="field-label">Sounds</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPref("disabledSounds", withSoundsEnabled(disabled, SOUNDS, allOff))}>
            {allOff ? "Enable all sounds" : "Disable all sounds"}
          </button>
        </div>
        {SOUNDS.map(name => (
          <div key={name} className="notify-sound-row">
            <button type="button" className="notify-sound-preview" aria-label={`Preview ${SOUND_LABELS[name]}`} onClick={() => previewSound(name)}>
              <Volume2 size={18} />
            </button>
            <div className="notify-sound-switch">
              <SwitchRow label={SOUND_LABELS[name]} checked={isSoundEnabled(disabled, name)} onChange={on => setSound(name, on)} />
            </div>
          </div>
        ))}
      </Category>

      <Category title="Email Notifications">
        {/* TODO(email): enable once the server reports an SMTP configuration (self-hosted instances have none by default). */}
        <Unavailable>Email notifications are not available on this server: it has no email (SMTP) service set up.</Unavailable>
      </Category>
    </Page>
  );
}
