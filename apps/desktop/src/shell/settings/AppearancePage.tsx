import { useEffect } from "react";
import { COMMUNITY_THEME_CARDS, FONT_SIZES, THEMES, previewThemeChoice, resetPrefs, setPref, usePrefs } from "../../ui";
import { GROUP_GAPS, SPACING_PRESETS, setMessageSpacing } from "../../ui/prefs";
import type { MessageDisplay, MessageSpacing, ThemeCard } from "../../ui/prefs";
import { Category, Divider, Field, Page, RadioGroup, Select, Slider, SwitchRow, Unavailable } from "./controls";

const DEFAULT_GAP = SPACING_PRESETS.balanced.gap;

const APPEARANCE_KEYS = ["theme", "fontSize", "messageDisplay", "messageSpacing", "messageGroupGap", "showEmbeds", "showReactions", "previewMarkdown", "convertEmoticons", "streamerMode", "streamerHideInvites", "streamerDisableSounds", "streamerDisableNotifications"] as const;

/** Hovering or focusing a swatch previews the theme on the whole app; leaving, blurring, Esc or closing the page puts the saved one back. */
function usePreviewReset(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") previewThemeChoice(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previewThemeChoice(null);
    };
  }, []);
}

function previewProps(id: ThemeCard["id"]) {
  return {
    onMouseEnter: () => previewThemeChoice(id),
    onMouseLeave: () => previewThemeChoice(null),
    onFocus: () => previewThemeChoice(id),
    onBlur: () => previewThemeChoice(null),
  };
}

export function AppearancePage() {
  const theme = usePrefs(s => s.theme);
  const messageDisplay = usePrefs(s => s.messageDisplay);
  const fontSize = usePrefs(s => s.fontSize);
  const gap = usePrefs(s => s.messageGroupGap);
  const spacing = usePrefs(s => s.messageSpacing);
  const showEmbeds = usePrefs(s => s.showEmbeds);
  const showReactions = usePrefs(s => s.showReactions);
  const previewMarkdown = usePrefs(s => s.previewMarkdown);
  const convertEmoticons = usePrefs(s => s.convertEmoticons);
  const streamerMode = usePrefs(s => s.streamerMode);
  const hideInvites = usePrefs(s => s.streamerHideInvites);
  const disableSounds = usePrefs(s => s.streamerDisableSounds);
  const disableNotifications = usePrefs(s => s.streamerDisableNotifications);
  usePreviewReset();

  return (
    <Page title="Appearance">
      <Category title="Theme">
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {THEMES.map(t => {
            const selected = theme === t.id;
            return (
              <button key={t.id} type="button" role="radio" aria-checked={selected} aria-label={t.label} className={`theme-card${selected ? " selected" : ""}`} onClick={() => setPref("theme", t.id)} {...previewProps(t.id)}>
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

      <Category title="Community themes">
        <p className="theme-note">Editor and terminal colour schemes. Hover or focus one to preview it; Esc goes back to your saved theme.</p>
        <div className="theme-swatches" role="radiogroup" aria-label="Community themes">
          {COMMUNITY_THEME_CARDS.map(t => {
            const selected = theme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t.label}
                title={t.label}
                data-theme-id={t.id}
                className={`theme-swatch${selected ? " selected" : ""}`}
                onClick={() => setPref("theme", t.id)}
                {...previewProps(t.id)}
              >
                <span className="theme-swatch-fill" aria-hidden="true">
                  <i style={{ background: t.swatch }} />
                  <i style={{ background: t.chat }} />
                </span>
              </button>
            );
          })}
        </div>
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
        <Field label="Message spacing">
          <RadioGroup<MessageSpacing>
            name="Message spacing"
            value={spacing}
            onChange={setMessageSpacing}
            options={[
              { value: "compact", label: "Compact", note: `${SPACING_PRESETS.compact.gap}px between groups, lines close together.` },
              { value: "balanced", label: "Balanced", note: `${SPACING_PRESETS.balanced.gap}px between groups. The default.` },
              { value: "roomy", label: "Roomy", note: "Wide gaps between groups and a little air between the lines of one message." },
            ]}
          />
        </Field>
        <Field label="Space between message groups">
          {/* the slider moves over Discord's stops (0, 4, 8, 16, 24 px); the presets above set it */}
          <Slider
            label="Space between message groups"
            value={Math.max(0, GROUP_GAPS.indexOf(gap as (typeof GROUP_GAPS)[number]))}
            min={0}
            max={GROUP_GAPS.length - 1}
            step={1}
            onChange={i => setPref("messageGroupGap", GROUP_GAPS[i] ?? DEFAULT_GAP)}
            format={i => `${GROUP_GAPS[i] ?? gap}px`}
          />
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
