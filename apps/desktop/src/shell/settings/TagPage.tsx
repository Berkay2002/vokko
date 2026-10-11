import { useState } from "react";
import {
  Bird, Bone, Brain, Bug, Cat, Clover, Cloud, Compass, Crosshair, Crown, Diamond, DollarSign, Dog, Droplet, Droplets, Flame, Flower, Flower2, Gem, Heart, Leaf, LeafyGreen, Moon, Mountain, Orbit, Rabbit, Skull, Snail, Snowflake, Sparkles, Sprout, Sun, Sword, Trophy, Turtle, Umbrella, Volume2, Wallet, Wind, Worm, Zap, type LucideIcon,
} from "lucide-react";
import { Category, Field, Page, SwitchRow } from "./controls";
import { DEVICE_NOTE, HEX_RE, useDeviceSetting } from "./deviceSettings";

export const BADGES: { id: string; label: string; Icon: LucideIcon }[] = [
  { id: "sword", label: "Sword", Icon: Sword },
  { id: "water-drop", label: "Water drop", Icon: Droplet },
  { id: "skull", label: "Skull", Icon: Skull },
  { id: "toadstool", label: "Toadstool", Icon: Umbrella },
  { id: "moon", label: "Moon", Icon: Moon },
  { id: "lightning", label: "Lightning", Icon: Zap },
  { id: "leaf", label: "Leaf", Icon: Leaf },
  { id: "heart", label: "Heart", Icon: Heart },
  { id: "fire", label: "Fire", Icon: Flame },
  { id: "compass", label: "Compass", Icon: Compass },
  { id: "crosshairs", label: "Crosshairs", Icon: Crosshair },
  { id: "flower", label: "Flower", Icon: Flower },
  { id: "force", label: "Force", Icon: Orbit },
  { id: "gem", label: "Gem", Icon: Gem },
  { id: "lava", label: "Lava", Icon: Mountain },
  { id: "psychic", label: "Psychic", Icon: Brain },
  { id: "smoke", label: "Smoke", Icon: Cloud },
  { id: "snow", label: "Snow", Icon: Snowflake },
  { id: "sound", label: "Sound", Icon: Volume2 },
  { id: "sun", label: "Sun", Icon: Sun },
  { id: "wind", label: "Wind", Icon: Wind },
  { id: "bunny", label: "Bunny", Icon: Rabbit },
  { id: "dog", label: "Dog", Icon: Dog },
  { id: "frog", label: "Frog", Icon: Turtle },
  { id: "goat", label: "Goat", Icon: Bone },
  { id: "cat", label: "Cat", Icon: Cat },
  { id: "diamond", label: "Diamond", Icon: Diamond },
  { id: "crown", label: "Crown", Icon: Crown },
  { id: "trophy", label: "Trophy", Icon: Trophy },
  { id: "money-bag", label: "Money bag", Icon: Wallet },
  { id: "dollar-sign", label: "Dollar sign", Icon: DollarSign },
  { id: "clover", label: "Clover", Icon: Clover },
  { id: "blossom", label: "Blossom", Icon: Sparkles },
  { id: "potted-plant", label: "Potted plant", Icon: Sprout },
  { id: "maple-leaf", label: "Maple leaf", Icon: LeafyGreen },
  { id: "wilted-flower", label: "Wilted flower", Icon: Flower2 },
  { id: "butterfly", label: "Butterfly", Icon: Bird },
  { id: "snail", label: "Snail", Icon: Snail },
  { id: "caterpillar", label: "Caterpillar", Icon: Worm },
  { id: "spider", label: "Spider", Icon: Bug },
  { id: "bee", label: "Bee", Icon: Droplets },
];

const COLOR_PRESETS: { primary: string; accent: string }[] = [
  { primary: "#5865f2", accent: "#8d96f7" },
  { primary: "#1f8b4c", accent: "#57d28f" },
  { primary: "#d22d39", accent: "#f47b84" },
  { primary: "#f8a300", accent: "#ffd166" },
  { primary: "#0074e3", accent: "#74b7f5" },
  { primary: "#b3269c", accent: "#e47fd2" },
  { primary: "#7b4fd6", accent: "#b79bf0" },
  { primary: "#36b5b0", accent: "#8fe3df" },
];

const DEFAULT_TAG = { enabled: false, name: "", badge: "sword", primary: COLOR_PRESETS[0]!.primary, accent: COLOR_PRESETS[0]!.accent };

const NAME_RE = /^[A-Za-z0-9]{0,4}$/;

export function TagPage({ guildId, canEdit }: { guildId: string; canEdit: boolean }) {
  const [tag, setTag] = useDeviceSetting(guildId, "tag", DEFAULT_TAG);
  const [draftName, setDraftName] = useState(tag.name);
  const [primaryText, setPrimaryText] = useState(tag.primary);
  const [accentText, setAccentText] = useState(tag.accent);

  const nameValid = NAME_RE.test(draftName);
  const nameError = nameValid ? null : /^[A-Za-z0-9]+$/.test(draftName) ? "Tags can be at most 4 characters." : "Tags can only contain letters and numbers (up to 4).";
  const badge = BADGES.find(b => b.id === tag.badge) ?? BADGES[0]!;
  const BadgeIcon = badge.Icon;
  const disabled = !canEdit;
  const update = (patch: Partial<typeof tag>) => setTag({ ...tag, ...patch });
  const setColors = (primary: string, accent: string) => {
    setPrimaryText(primary);
    setAccentText(accent);
    update({ primary, accent });
  };
  const isDefaultColors = tag.primary.toLowerCase() === DEFAULT_TAG.primary && tag.accent.toLowerCase() === DEFAULT_TAG.accent;
  const previewName = (nameValid ? draftName : tag.name) || "TAG";

  return (
    <Page title="Server Tag">
      {!canEdit && <p className="settings-todo">You need the Manage Server permission to change the server tag.</p>}
      <p className="settings-todo">Create a tag that your server members can display next to their name!</p>
      <div className="ss-tag-preview" aria-label="Server tag preview">
        <span className="ss-tag-chip" style={{ color: tag.accent, background: `${tag.primary}33`, borderColor: tag.primary }}>
          <BadgeIcon size={14} aria-hidden="true" />
          <span className="ss-tag-chip-text">{previewName.toUpperCase()}</span>
        </span>
        <span className="ss-tag-preview-note">{tag.enabled ? "Members can display this tag." : "Server Tag is off."}</span>
      </div>
      <SwitchRow label="Enable Server Tag" checked={tag.enabled} disabled={disabled} onChange={enabled => update({ enabled })} />
      <Category title="Choose Name">
        <Field label="Tag" note="Changing the tag requires members to reapply it to their profile.">
          <input
            className="input ss-tag-name"
            aria-label="Server tag name"
            value={draftName}
            maxLength={12}
            disabled={disabled}
            placeholder="TAG"
            onChange={e => {
              setDraftName(e.target.value);
              if (NAME_RE.test(e.target.value)) update({ name: e.target.value });
            }}
          />
          {nameError && <p className="field-error">{nameError}</p>}
        </Field>
      </Category>
      <Category title="Choose Badge">
        <div className="ss-badge-grid" role="radiogroup" aria-label="Server tag badge">
          {BADGES.map(({ id, label, Icon }) => (
            <button key={id} type="button" role="radio" aria-checked={tag.badge === id} aria-label={label} title={label} disabled={disabled} className={`ss-badge${tag.badge === id ? " selected" : ""}`} onClick={() => update({ badge: id })}>
              <Icon size={20} aria-hidden="true" />
            </button>
          ))}
        </div>
      </Category>
      <Category title="Choose Color">
        <div className="ss-swatch-row" role="radiogroup" aria-label="Color presets">
          {COLOR_PRESETS.map(p => {
            const on = tag.primary === p.primary && tag.accent === p.accent;
            return <button key={p.primary} type="button" role="radio" aria-checked={on} aria-label={`Preset ${p.primary} and ${p.accent}`} disabled={disabled} className={`ss-swatch${on ? " selected" : ""}`} style={{ background: `linear-gradient(135deg, ${p.primary} 50%, ${p.accent} 50%)` }} onClick={() => setColors(p.primary, p.accent)} />;
          })}
        </div>
        <div className="ss-color-inputs">
          <Field label="Custom Colors: Primary">
            <input
              className="input"
              aria-label="Primary color"
              value={primaryText}
              maxLength={7}
              disabled={disabled}
              onChange={e => {
                setPrimaryText(e.target.value);
                if (HEX_RE.test(e.target.value)) update({ primary: e.target.value });
              }}
            />
            {!HEX_RE.test(primaryText) && <p className="field-error">Use a hex color like #5865f2.</p>}
          </Field>
          <Field label="Accent">
            <input
              className="input"
              aria-label="Accent color"
              value={accentText}
              maxLength={7}
              disabled={disabled}
              onChange={e => {
                setAccentText(e.target.value);
                if (HEX_RE.test(e.target.value)) update({ accent: e.target.value });
              }}
            />
            {!HEX_RE.test(accentText) && <p className="field-error">Use a hex color like #8d96f7.</p>}
          </Field>
        </div>
        <button type="button" className="btn btn-link btn-sm" disabled={disabled || isDefaultColors} onClick={() => setColors(DEFAULT_TAG.primary, DEFAULT_TAG.accent)}>
          Reset to default colors
        </button>
      </Category>
      <p className="settings-todo">Your Server Profile is private. Users will not be able to see it from a Server Tag.</p>
      <p className="settings-todo">{DEVICE_NOTE}</p>
    </Page>
  );
}
