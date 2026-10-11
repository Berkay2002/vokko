import { setPref, usePrefs } from "../../ui";
import type { TimeFormat } from "../../ui/prefs";
import { Page, RadioGroup, Select, Unavailable } from "./controls";
import { SubHeading } from "./smControls";

/** Language (English only for now) and the clock used for message timestamps (src/chat/util.ts formatTime reads the pref). */
export function LanguageTimePage() {
  const timeFormat = usePrefs(s => s.timeFormat);
  return (
    <Page title="Language & Time">
      <SubHeading level={2} note="Choose the language you want Vokko to show.">Select a language</SubHeading>
      <div className="settings-field">
        <Select<string> label="Language" value="en" options={[{ value: "en", label: "English" }]} onChange={() => undefined} />
        <Unavailable>More languages are not available yet.</Unavailable>
      </div>
      <SubHeading level={2}>Time format</SubHeading>
      <RadioGroup<TimeFormat>
        name="Time format"
        value={timeFormat}
        onChange={v => setPref("timeFormat", v)}
        options={[
          { value: "auto", label: "Automatic" },
          { value: "12", label: "12-hour" },
          { value: "24", label: "24-hour" },
        ]}
      />
    </Page>
  );
}
