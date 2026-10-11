import { FONT_SIZES, setPref, usePrefs } from "../../ui";
import type { Density, MessageDisplay, ReducedMotion, RoleColors } from "../../ui/prefs";
import { Category, Field, Page, RadioGroup, Select, Slider, SwitchRow, Unavailable } from "./controls";

export function AccessibilityPage() {
  const fontSize = usePrefs(s => s.fontSize);
  const underlineLinks = usePrefs(s => s.underlineLinks);
  const density = usePrefs(s => s.density);
  const messageDisplay = usePrefs(s => s.messageDisplay);
  const roleColors = usePrefs(s => s.roleColors);
  const reducedMotion = usePrefs(s => s.reducedMotion);
  const playGifs = usePrefs(s => s.playGifs);
  const playAnimatedEmoji = usePrefs(s => s.playAnimatedEmoji);
  const imageDescriptions = usePrefs(s => s.showImageDescriptions);

  const sizeIndex = Math.max(0, FONT_SIZES.findIndex(n => n === fontSize));

  return (
    <Page title="Accessibility">
      <div className="sm-sticky">
        <div className="sm-sticky-card">
          <div className="sm-sticky-label">Preview</div>
          <p style={{ fontSize: `${fontSize}px` }}>This is how chat text looks at {fontSize}px.</p>
        </div>
      </div>
      <Category title="Text Readability">
        <Field label="Chat text size">
          <Slider
            label="Chat text size"
            value={sizeIndex}
            min={0}
            max={FONT_SIZES.length - 1}
            step={1}
            onChange={i => setPref("fontSize", FONT_SIZES[i] ?? 16)}
            format={i => `${FONT_SIZES[i] ?? 16}px`}
          />
        </Field>
        <SwitchRow label="Always underline links" checked={underlineLinks} onChange={v => setPref("underlineLinks", v)} />
      </Category>

      <Category title="Visual Density">
        <Field label="Interface density">
          <RadioGroup<Density>
            name="Interface density"
            value={density}
            onChange={v => setPref("density", v)}
            options={[
              { value: "compact", label: "Compact", note: "Tighter lists and menus." },
              { value: "default", label: "Default" },
              { value: "cozy", label: "Cozy", note: "More space around every item." },
            ]}
          />
        </Field>
        <Field label="Chat message display">
          <RadioGroup<MessageDisplay>
            name="Chat message display"
            value={messageDisplay}
            onChange={v => setPref("messageDisplay", v)}
            options={[
              { value: "cozy", label: "Cozy" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </Field>
      </Category>

      <Category title="Color & Contrast">
        <Field label="Show role colors">
          <Select<RoleColors>
            label="Show role colors"
            value={roleColors}
            onChange={v => setPref("roleColors", v)}
            options={[
              { value: "name", label: "Next to names" },
              { value: "dot", label: "As a dot" },
              { value: "none", label: "Do not show" },
            ]}
          />
        </Field>
        <Field label="Saturation">
          <Slider label="Saturation" value={100} min={0} max={100} step={1} disabled onChange={() => undefined} format={v => `${v}%`} />
        </Field>
        <SwitchRow label="High contrast mode" checked={false} disabled onChange={() => undefined} />
        <Unavailable>Saturation and high contrast are not available yet.</Unavailable>
      </Category>

      <Category title="Reduced Motion">
        <Field label="Reduce motion">
          <Select<ReducedMotion>
            label="Reduce motion"
            value={reducedMotion}
            onChange={v => setPref("reducedMotion", v)}
            options={[
              { value: "system", label: "Match system setting" },
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ]}
          />
        </Field>
        <SwitchRow label="Play GIFs automatically" checked={playGifs} onChange={v => setPref("playGifs", v)} />
        <SwitchRow label="Play animated emoji" checked={playAnimatedEmoji} onChange={v => setPref("playAnimatedEmoji", v)} />
      </Category>

      <Category title="Audio & Screen Reader">
        <SwitchRow label="Show image descriptions" note="Display alt text for attached images." checked={imageDescriptions} onChange={v => setPref("showImageDescriptions", v)} />
      </Category>
    </Page>
  );
}
