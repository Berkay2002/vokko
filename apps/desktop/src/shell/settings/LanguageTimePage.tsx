import { formatMessageTimestamp } from "../../chat/util";
import { LOCALES, useT } from "../../i18n";
import { setPref, usePrefs } from "../../ui";
import { localeTag, type TimeFormat } from "../../ui/prefs";
import { Page, RadioGroup, Select } from "./controls";
import { SubHeading } from "./smControls";

/** Language (string catalogs in src/i18n, English only so far) and the clock of every timestamp (src/chat/util.ts and markdown <t:>). */
export function LanguageTimePage() {
  const t = useT();
  const timeFormat = usePrefs(s => s.timeFormat);
  const locale = usePrefs(s => s.locale);
  const sample = new Date();
  sample.setHours(21, 24, 0, 0);
  return (
    <Page title={t("settings.languageTime")}>
      <SubHeading level={2} note={t("language.note")}>
        {t("language.select")}
      </SubHeading>
      <div className="settings-field">
        <Select<string>
          label="Language"
          value={locale}
          options={[{ value: "", label: t("language.device") }, ...LOCALES.map(l => ({ value: l.id, label: l.native === l.label ? l.label : `${l.native} (${l.label})` }))]}
          onChange={v => setPref("locale", v)}
        />
      </div>
      <SubHeading level={2}>{t("language.timeFormat")}</SubHeading>
      <RadioGroup<TimeFormat>
        name="Time format"
        value={timeFormat}
        onChange={v => setPref("timeFormat", v)}
        options={[
          { value: "auto", label: t("language.auto") },
          { value: "12", label: t("language.12h") },
          { value: "24", label: t("language.24h") },
        ]}
      />
      <p className="sm-sub-note">
        {t("language.preview")} <time data-testid="time-preview">{formatMessageTimestamp(sample, sample, localeTag({ locale, timeFormat }))}</time>
      </p>
    </Page>
  );
}
