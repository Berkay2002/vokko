import { useState } from "react";
import { setPref, usePrefs } from "../../ui";
import { Category, Field, Page, RadioGroup, SwitchRow } from "./controls";

type ReactionNotifications = "all" | "dm" | "never";

export function NotificationsPage() {
  const desktop = usePrefs(s => s.desktopNotifications);
  const reactions = usePrefs(s => s.reactionNotifications);
  const sounds = usePrefs(s => s.notificationSounds);
  const soundCurrent = usePrefs(s => s.soundCurrentChannel);
  const badge = usePrefs(s => s.unreadBadge);
  const friends = usePrefs(s => s.friendsOnlineAlerts);
  const [denied, setDenied] = useState(false);

  const setDesktop = async (on: boolean) => {
    if (!on) {
      setDenied(false);
      setPref("desktopNotifications", false);
      return;
    }
    // Optimistic: flip now, revert if the permission is refused.
    setPref("desktopNotifications", true);
    let result: NotificationPermission = "denied";
    try {
      if (typeof Notification !== "undefined") result = await Notification.requestPermission();
    } catch {
      result = "denied";
    }
    if (result === "granted") {
      setDenied(false);
    } else {
      setPref("desktopNotifications", false);
      setDenied(true);
    }
  };

  return (
    <Page title="Notifications">
      <Category title="Overview">
        <SwitchRow
          label="Enable desktop notifications"
          note={denied ? "Notification permission was denied. Allow it in your browser or system settings and try again." : "Get a pop-up when something happens while Vokko is in the background."}
          checked={desktop}
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

      <Category title="Sounds">
        <SwitchRow label="Play notification sounds" checked={sounds} onChange={v => setPref("notificationSounds", v)} />
        <SwitchRow label="Play sounds for the channel you are viewing" checked={soundCurrent} onChange={v => setPref("soundCurrentChannel", v)} />
      </Category>

      <Category title="Badges">
        <SwitchRow label="Show unread badge" note="Display a count on the app icon." checked={badge} onChange={v => setPref("unreadBadge", v)} />
      </Category>

      <Category title="Advanced">
        <SwitchRow label="Alert me when friends come online" checked={friends} onChange={v => setPref("friendsOnlineAlerts", v)} />
      </Category>
    </Page>
  );
}
