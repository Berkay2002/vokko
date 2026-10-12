import { useId } from "react";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { FONT_SIZES, setPref, usePrefs } from "../../ui";
import { NOTIFICATION_SECONDS, SATURATION_STEPS, TTS_RATES, ZOOM_STEPS } from "../../ui/a11y";
import type { StickerAnimation } from "../../ui/a11y";
import { GROUP_GAPS } from "../../ui/prefs";
import type { Density, MessageDisplay, RoleColors } from "../../ui/prefs";
import { speak, speechAvailable } from "../../ui/speech";
import { A11yPreview } from "./A11yPreview";
import { MarkerSlider, type MarkerTick } from "./MarkerSlider";
import { Category, Page, RadioGroup, Select, SwitchRow } from "./controls";

/**
 * Settings > Accessibility. Every control writes a pref; `ui/prefs.ts#apply` and `ui/a11yApply.ts` turn the prefs into html
 * classes and tokens, and the chat components read the rest (animation policy, toast minimum, legacy input).
 */

const px = (v: number) => `${v}px`;
const percent = (v: number) => `${v}%`;

const FONT_TICKS: MarkerTick[] = FONT_SIZES.map(v => ({ value: v, label: px(v) }));
const GAP_TICKS: MarkerTick[] = GROUP_GAPS.map(v => ({ value: v, label: px(v) }));
const ZOOM_TICKS: MarkerTick[] = ZOOM_STEPS.map(v => ({ value: v, label: [50, 75, 100, 150, 200].includes(v) ? percent(v) : undefined }));
const SATURATION_TICKS: MarkerTick[] = SATURATION_STEPS.map(v => ({ value: v, label: v % 50 === 0 ? percent(v) : undefined }));
const NOTIFICATION_TICKS: MarkerTick[] = NOTIFICATION_SECONDS.map(v => ({ value: v, label: `${v}s` }));
const TTS_TICKS: MarkerTick[] = TTS_RATES.map(v => ({ value: v, label: v === 0.5 ? "Slower" : v === 1 ? "1x" : v === 2 ? "Faster" : undefined }));

const TTS_SAMPLE = "This is how text to speech sounds at this speed.";

/**
 * A labelled control with its description above it, as on Discord's page. `inline` puts the control to the right of the label (Discord's select rows) instead of below it.
 * `children` may be a function that gets the id of the note, so the control can name it as its description.
 */
function Row({ label, note, inline, children }: { label: string; note?: ReactNode; inline?: boolean; children: ReactNode | ((noteId: string | undefined) => ReactNode) }) {
  const noteId = useId();
  const body = typeof children === "function" ? children(note ? noteId : undefined) : children;
  return (
    <div className={`settings-field a11y-field${inline ? " a11y-field-inline" : ""}`}>
      <div className="field-label">{label}</div>
      {note && <div className="settings-field-note" id={noteId}>{note}</div>}
      {inline ? <div className="a11y-field-control">{body}</div> : body}
    </div>
  );
}

export function AccessibilityPage({ onOpenSection }: { onOpenSection?: (id: string) => void }) {
  const fontSize = usePrefs(s => s.fontSize);
  const underlineLinks = usePrefs(s => s.underlineLinks);
  const displayNameStyles = usePrefs(s => s.displayNameStyles);
  const density = usePrefs(s => s.density);
  const messageDisplay = usePrefs(s => s.messageDisplay);
  const messageGroupGap = usePrefs(s => s.messageGroupGap);
  const zoom = usePrefs(s => s.zoom);
  const saturation = usePrefs(s => s.saturation);
  const saturateCustomColors = usePrefs(s => s.saturateCustomColors);
  const highContrast = usePrefs(s => s.highContrast);
  const syncContrast = usePrefs(s => s.syncContrast);
  const roleColors = usePrefs(s => s.roleColors);
  const showSwitchIndicators = usePrefs(s => s.showSwitchIndicators);
  const reducedMotionEnabled = usePrefs(s => s.reducedMotionEnabled);
  const syncReducedMotion = usePrefs(s => s.syncReducedMotion);
  const minNotificationDuration = usePrefs(s => s.minNotificationDuration);
  const playGifs = usePrefs(s => s.playGifs);
  const playAnimatedEmoji = usePrefs(s => s.playAnimatedEmoji);
  const stickerAnimation = usePrefs(s => s.stickerAnimation);
  const ttsRate = usePrefs(s => s.ttsRate);
  const imageDescriptions = usePrefs(s => s.showImageDescriptions);
  const legacyChatInput = usePrefs(s => s.legacyChatInput);

  return (
    <Page title="Accessibility">
      <div className="a11y-sticky">
        <div className="a11y-preview-label">Preview</div>
        <A11yPreview />
      </div>

      <Category title="Text Readability">
        <Row label="Chat font size" note="Scales message text. The interface around it keeps its size; use the zoom level below for that.">
          {id => <MarkerSlider ticks={FONT_TICKS} value={fontSize} onChange={v => setPref("fontSize", v)} label="Chat font size" format={px} describedBy={id} />}
        </Row>
        <SwitchRow label="Always underline links" note="Underline links in messages even when they are not hovered." checked={underlineLinks} onChange={v => setPref("underlineLinks", v)} />
        <SwitchRow label="Display name styles" note="Show fonts, effects and colours that people chose for their display name. Turn off to see plain names." checked={displayNameStyles} onChange={v => setPref("displayNameStyles", v)} />
      </Category>

      <Category title="Visual Density">
        <Row label="UI density" note="How much space the server list, channel list and member list leave between items.">
          {id => (
            <RadioGroup<Density>
              describedBy={id}
              name="UI density"
              value={density}
              onChange={v => setPref("density", v)}
              options={[
                { value: "compact", label: "Compact" },
                { value: "default", label: "Default" },
                { value: "cozy", label: "Spacious" },
              ]}
            />
          )}
        </Row>
        <Row label="Chat message display">
          <RadioGroup<MessageDisplay>
            name="Chat message display"
            value={messageDisplay}
            onChange={v => setPref("messageDisplay", v)}
            options={[
              { value: "cozy", label: "Standard", note: "Larger avatars, more breathing room around each message." },
              { value: "compact", label: "Compact", note: "Fit more messages on screen." },
            ]}
          />
        </Row>
        <Row label="Space between message groups" note="The gap between messages from different people.">
          {id => <MarkerSlider ticks={GAP_TICKS} value={messageGroupGap} onChange={v => setPref("messageGroupGap", v)} label="Space between message groups" format={px} describedBy={id} />}
        </Row>
        <Row label="Zoom level" note="Scales the whole app. Ctrl and +, Ctrl and -, and Ctrl and 0 also work from anywhere.">
          {id => <MarkerSlider ticks={ZOOM_TICKS} value={zoom} onChange={v => setPref("zoom", v)} label="Zoom level" format={percent} describedBy={id} />}
        </Row>
      </Category>

      <Category title="Color & Contrast">
        <Row label="Saturation" note="Lower it to mute the interface colours. Images, videos and other people's content keep their colours.">
          {id => <MarkerSlider ticks={SATURATION_TICKS} value={saturation} onChange={v => setPref("saturation", v)} label="Saturation" format={percent} describedBy={id} />}
        </Row>
        <SwitchRow
          label="Apply saturation to custom colors"
          note="Also mute role colours. Has no effect while saturation is 100%."
          checked={saturateCustomColors}
          disabled={saturation === 100}
          onChange={v => setPref("saturateCustomColors", v)}
        />
        <SwitchRow label="Enable high contrast mode" note="Stronger text, borders and focus rings on top of your theme." checked={highContrast} onChange={v => setPref("highContrast", v)} />
        <SwitchRow label="Sync contrast settings with computer" note="Turn high contrast on when your computer asks for more contrast." checked={syncContrast} onChange={v => setPref("syncContrast", v)} />
        <Row inline label="Role colors" note="Where the colour of a person's top role shows up.">
          <Select<RoleColors>
            label="Role colors"
            value={roleColors}
            onChange={v => setPref("roleColors", v)}
            options={[
              { value: "name", label: "In names" },
              { value: "dot", label: "Next to names" },
              { value: "none", label: "Hide" },
            ]}
          />
        </Row>
        <SwitchRow label="Show switch indicators" note="Add a check or a cross to switches, so on and off do not rely on colour alone." checked={showSwitchIndicators} onChange={v => setPref("showSwitchIndicators", v)} />
      </Category>

      <Category title="Reduced Motion">
        <SwitchRow label="Enable reduced motion" note="Turns off sliding, fading and other interface animations." checked={reducedMotionEnabled} onChange={v => setPref("reducedMotionEnabled", v)} />
        <SwitchRow label="Sync with computer" note="Also reduce motion when your computer asks for it." checked={syncReducedMotion} onChange={v => setPref("syncReducedMotion", v)} />
        <Row label="Minimum notification duration" note="How long pop-ups and toasts stay on screen at least.">
          {id => <MarkerSlider ticks={NOTIFICATION_TICKS} value={minNotificationDuration} onChange={v => setPref("minNotificationDuration", v)} label="Minimum notification duration" format={v => `${v} seconds`} describedBy={id} />}
        </Row>
        <SwitchRow label="Play GIFs when Vokko is focused" note="Otherwise GIFs show their first frame and play when you hover them." checked={playGifs} onChange={v => setPref("playGifs", v)} />
        <SwitchRow label="Play animated emoji" checked={playAnimatedEmoji} onChange={v => setPref("playAnimatedEmoji", v)} />
        <Row label="Sticker animations" note="Animated stickers can play all the time, only when you hover or focus them, or never.">
          {id => (
            <RadioGroup<StickerAnimation>
              describedBy={id}
              name="Sticker animations"
              value={stickerAnimation}
              onChange={v => setPref("stickerAnimation", v)}
              options={[
                { value: "always", label: "Always animate" },
                { value: "interaction", label: "Animate on interaction" },
                { value: "never", label: "Never animate" },
              ]}
            />
          )}
        </Row>
      </Category>

      <Category title="Audio & Screen Reader">
        <Row label="Text-to-speech rate" note="How fast messages are read aloud.">
          {id => (
            <>
              <MarkerSlider ticks={TTS_TICKS} value={ttsRate} onChange={v => setPref("ttsRate", v)} label="Text-to-speech rate" format={v => `${v}x`} describedBy={id} />
              <button type="button" className="btn btn-secondary btn-sm a11y-tts-preview" aria-label="Preview text-to-speech" disabled={!speechAvailable()} onClick={() => speak(TTS_SAMPLE, ttsRate)}>
                Preview
              </button>
            </>
          )}
        </Row>
        <SwitchRow label="Show image descriptions" note="Show the description (alt text) under images and attachments that have one." checked={imageDescriptions} onChange={v => setPref("showImageDescriptions", v)} />
        <SwitchRow label="Use legacy chat input" note="A plain text box without the live formatting preview or emoticon conversion, which some screen readers handle better. @mentions, #channels and :emoji: still autocomplete." checked={legacyChatInput} onChange={v => setPref("legacyChatInput", v)} />
      </Category>

      <Category title="Related settings">
        <button type="button" className="a11y-related" onClick={() => onOpenSection?.("appearance")}>
          <span className="a11y-related-text">
            <span className="a11y-related-title">Appearance</span>
            <span className="a11y-related-note">Theme, message display and chat appearance.</span>
          </span>
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </Category>
    </Page>
  );
}
