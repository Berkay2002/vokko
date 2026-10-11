import { FONT_SIZES, THEMES, resetPrefs, setPref, usePrefs } from "../../ui";
import type { MessageDisplay } from "../../ui/prefs";
import { Category, Divider, Field, Page, RadioGroup, Select, Slider, SwitchRow, Unavailable } from "./controls";

const APPEARANCE_KEYS = ["theme", "fontSize", "messageDisplay", "messageGroupGap", "showEmbeds", "showReactions", "previewMarkdown", "convertEmoticons", "streamerMode", "streamerHideInvites", "streamerDisableSounds", "streamerDisableNotifications"] as const;

export function AppearancePage() {
  const theme = usePrefs(s => s.theme);
  const messageDisplay = usePrefs(s => s.messageDisplay);
  const fontSize = usePrefs(s => s.fontSize);
  const gap = usePrefs(s => s.messageGroupGap);
  const showEmbeds = usePrefs(s => s.showEmbeds);
  const showReactions = usePrefs(s => s.showReactions);
  const previewMarkdown = usePrefs(s => s.previewMarkdown);
  const convertEmoticons = usePrefs(s => s.convertEmoticons);
  const streamerMode = usePrefs(s => s.streamerMode);
  const hideInvites = usePrefs(s => s.streamerHideInvites);
  const disableSounds = usePrefs(s => s.streamerDisableSounds);
  const disableNotifications = usePrefs(s => s.streamerDisableNotifications);

  return (
    <Page title="Appearance">
      <Category title="Theme">
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {THEMES.map(t => {
            const selected = theme === t.id;
            return (
              <button key={t.id} type="button" role="radio" aria-checked={selected} aria-label={t.label} className={`theme-card${selected ? " selected" : ""}`} onClick={() => setPref("theme", t.id)}>
                <span className="theme-card-preview" aria-hidden="true">
                  <i style={{ width: "30%", background: t.swatch }} />
                  <i style={{ width: "70%", background: t.chat }} />
                </span>
                <span className="theme-card-label">{t.label}</span>
              </button>
            );
          })}
        </div>
        <SwitchRow label="Sync with computer" note="Follow your system's light or dark setting." checked={theme === "system"} onChange={on => setPref("theme", on ? "system" : "dark")} />
      </Category>

      <Category title="Messages">
        <Field label="Message display">
          <RadioGroup<MessageDisplay>
            name="Message display"
            value={messageDisplay}
            onChange={v => setPref("messageDisplay", v)}
            options={[
              { value: "cozy", label: "Cozy", note: "Avatars and names above the text, with room to breathe." },
              { value: "compact", label: "Compact", note: "Fit more messages on screen, one line each." },
            ]}
          />
        </Field>
        <Field label="Chat font size">
          <Select<string> label="Chat font size" value={String(fontSize)} options={FONT_SIZES.map(n => ({ value: String(n), label: `${n}px` }))} onChange={v => setPref("fontSize", Number(v))} />
        </Field>
        <Field label="Space between message groups">
          <Slider label="Space between message groups" value={gap} min={0} max={16} step={1} onChange={v => setPref("messageGroupGap", v)} format={v => `${v}px`} />
        </Field>
      </Category>

      <Category title="Chat Box">
        <SwitchRow label="Show embeds and link previews" checked={showEmbeds} onChange={v => setPref("showEmbeds", v)} />
        <SwitchRow label="Show reactions on messages" checked={showReactions} onChange={v => setPref("showReactions", v)} />
        <SwitchRow label="Preview Markdown as you type" checked={previewMarkdown} onChange={v => setPref("previewMarkdown", v)} />
        <SwitchRow label="Convert emoticons to emoji" note="For example, :) becomes a smiley." checked={convertEmoticons} onChange={v => setPref("convertEmoticons", v)} />
      </Category>

      <Category title="Streamer Mode">
        <SwitchRow label="Enable Streamer Mode" note="Blurs sensitive details while you share your screen." checked={streamerMode} onChange={v => setPref("streamerMode", v)} />
        <SwitchRow label="Hide invite links" checked={hideInvites} disabled={!streamerMode} onChange={v => setPref("streamerHideInvites", v)} />
        <SwitchRow label="Disable sounds" checked={disableSounds} disabled={!streamerMode} onChange={v => setPref("streamerDisableSounds", v)} />
        <SwitchRow label="Disable notifications" checked={disableNotifications} disabled={!streamerMode} onChange={v => setPref("streamerDisableNotifications", v)} />
      </Category>

      <Category title="Advanced">
        <Unavailable>Hardware acceleration and developer mode are not available in this build.</Unavailable>
      </Category>

      <Divider />
      <button type="button" className="sp-button" onClick={() => resetPrefs([...APPEARANCE_KEYS])}>
        Reset to defaults
      </button>
    </Page>
  );
}
