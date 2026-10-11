import { DeveloperApps } from "../../apps/DeveloperApps";
import { Page, SwitchRow } from "./controls";

/** Discord's "Advanced" page: developer tools and application test mode. Neither has an effect in Vokko yet, so both stay off and disabled. */
export function DeveloperPage() {
  return (
    <Page title="Advanced">
      <SwitchRow label="Developer Mode" note="Developer mode adds context menu options for people who write apps. Copy ID is always in the menus in Vokko." checked={false} disabled onChange={() => undefined} />
      <SwitchRow label="Application Test Mode" note="Enter an application ID to turn on its test mode. Test mode is not available yet." checked={false} disabled onChange={() => undefined} />
      <DeveloperApps />
    </Page>
  );
}
