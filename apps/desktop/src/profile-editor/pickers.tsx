import { useState } from "react";
import { ImagePlus, Pencil } from "lucide-react";
import type { DisplayNameStyles, User } from "../api/types";
import { AVATAR_DECORATIONS, NAME_EFFECTS, NAME_FONTS, NAMEPLATES, PROFILE_EFFECTS, decorationById, effectById, hexToInt, intToHex, nameEffectById, nameplateById } from "../perks/catalog";
import { Nameplate, StyledName } from "../perks/NameStyles";
import { sameNameStyle } from "../perks/NameStylePickers";
import { ProfileBanner } from "../perks/ProfileBanner";
import type { ProfileLook } from "../perks/profile";
import { Avatar } from "../shell/Avatar";
import { Modal } from "../ui";
import { NoneTile, PickerModal, PickerSection, PickerTile, PreviewCard } from "./PickerModal";

const STRIP = { banner: null, bannerColor: "#2b2d31", themeColors: null } as const;
const DEFAULT_COLOR = hexToInt("#8d96f7");
const COLOR_PRESETS = ["#8d96f7", "#57d28f", "#4fb0f5", "#c13cf5", "#e0245e", "#ff4d2d", "#d6a817"].map(hexToInt);

interface Common {
  user: User;
  look: ProfileLook;
  /** The name the previews show. */
  name: string;
  onClose(): void;
}

export function EffectPicker({ user, look, name, value, onApply, onClose }: Common & { value: string | null; onApply(next: string | null): void }) {
  const [sel, setSel] = useState(value);
  const def = effectById(sel);
  const strip = (id: string | null, label: string) => (
    <PickerTile key={id ?? "none"} selected={sel === id} label={label} onClick={() => setSel(id)}>
      <ProfileBanner look={{ ...STRIP, effect: id }} className="pe-effect-strip" />
    </PickerTile>
  );
  return (
    <PickerModal
      title="Change profile effect"
      onClose={onClose}
      onApply={() => onApply(sel)}
      canApply={sel !== value}
      grid={
        <>
          <PickerSection title="Your effects" label="Profile effect">
            <NoneTile selected={sel === null} onClick={() => setSel(null)} />
          </PickerSection>
          <PickerSection title="Effects" label="Profile effects">
            {PROFILE_EFFECTS.map(e => strip(e.id, e.name))}
          </PickerSection>
        </>
      }
      preview={<PreviewCard user={user} look={{ ...look, effect: sel }} name={name} />}
      info={{ name: def?.name ?? "None", description: def ? `Animated ${def.name.toLowerCase()} that play over your profile card.` : "No effect plays over your profile." }}
    />
  );
}

export function DecorationPicker({ user, look, value, onApply, onClose }: Omit<Common, "name"> & { value: string | null; onApply(next: string | null): void }) {
  const [sel, setSel] = useState(value);
  const def = decorationById(sel);
  const base = { id: user.id, avatar: look.avatar };
  return (
    <PickerModal
      title="Change avatar decoration"
      onClose={onClose}
      onApply={() => onApply(sel)}
      canApply={sel !== value}
      grid={
        <>
          <PickerSection title="Your decorations" label="Avatar decoration">
            <NoneTile selected={sel === null} onClick={() => setSel(null)} />
          </PickerSection>
          <PickerSection title="Decorations" label="Avatar decorations">
            {AVATAR_DECORATIONS.map(d => (
              <PickerTile key={d.id} selected={sel === d.id} label={d.name} onClick={() => setSel(d.id)}>
                <Avatar user={base} size={56} decoration={d.id} />
              </PickerTile>
            ))}
          </PickerSection>
        </>
      }
      preview={
        <div className="pe-pk-avatars">
          <div className="pe-pk-stage">
            <Avatar user={base} size={140} decoration={sel ?? false} />
          </div>
          <div className="pe-pk-sizes">
            <Avatar user={base} size={64} decoration={sel ?? false} />
            <Avatar user={base} size={48} decoration={sel ?? false} status />
            <Avatar user={base} size={40} decoration={sel ?? false} />
            <Avatar user={base} size={32} decoration={sel ?? false} status />
          </div>
        </div>
      }
      info={{ name: def?.name ?? "None", description: def ? "A ring that shows around your avatar wherever it appears." : "Your avatar shows without a decoration." }}
    />
  );
}

export function NameplatePicker({ user, look, name, value, onApply, onClose }: Common & { value: string | null; onApply(next: string | null): void }) {
  const [sel, setSel] = useState(value);
  const def = nameplateById(sel);
  const base = { id: user.id, avatar: look.avatar };
  const skeleton = (key: string) => (
    <div key={key} className="pe-pk-member">
      <span className="pe-pk-skel-dot" />
      <span className="pe-pk-skel-bar" />
    </div>
  );
  return (
    <PickerModal
      title="Change nameplate"
      onClose={onClose}
      onApply={() => onApply(sel)}
      canApply={sel !== value}
      grid={
        <>
          <PickerSection title="Your nameplates" label="Nameplate" layout="rows">
            <NoneTile selected={sel === null} onClick={() => setSel(null)} className="row" />
          </PickerSection>
          <PickerSection title="Nameplates" label="Nameplates" layout="rows">
            {NAMEPLATES.map(n => (
              <PickerTile key={n.id} selected={sel === n.id} label={n.name} onClick={() => setSel(n.id)} className="row">
                <span className="pf-nameplate-row has-nameplate">
                  <Nameplate id={n.id} />
                  <Avatar user={base} size={24} decoration={false} />
                  <span className="pe-pk-skel-bar" />
                </span>
              </PickerTile>
            ))}
          </PickerSection>
        </>
      }
      preview={
        <div className="pe-pk-members" aria-label="Member list preview">
          {skeleton("a")}
          {skeleton("b")}
          <div className="pe-pk-member">
            <span className={`pf-nameplate-row${sel ? " has-nameplate" : ""}`}>
              <Nameplate id={sel} />
              <Avatar user={base} size={32} decoration={false} />
              <span className="pf-nameplate-name">{name}</span>
            </span>
          </div>
          {skeleton("c")}
          {skeleton("d")}
        </div>
      }
      info={{ name: def?.name ?? "None", description: def ? "A background behind your name in member and direct message lists." : "Your name shows on the plain list background." }}
    />
  );
}

export function NameStylePicker({ user, look, name, nameplate, value, onApply, onClose }: Common & { nameplate: string | null; value: DisplayNameStyles | null; onApply(next: DisplayNameStyles | null): void }) {
  const [sel, setSel] = useState(value);
  const current: DisplayNameStyles = sel ?? { font_id: "default", effect_id: "solid", colors: [DEFAULT_COLOR] };
  const uses = nameEffectById(current.effect_id)?.colors ?? 1;
  const colors: [number, number] = [current.colors[0] ?? DEFAULT_COLOR, current.colors[1] ?? current.colors[0] ?? COLOR_PRESETS[1]];
  const update = (patch: Partial<DisplayNameStyles>) => {
    const next = { ...current, ...patch };
    const count = nameEffectById(next.effect_id)?.colors ?? 1;
    const pair: [number, number] = [next.colors[0] ?? colors[0], next.colors[1] ?? colors[1]];
    setSel({ ...next, colors: count === 2 ? pair : [pair[0]] });
  };
  const swatches = (index: 0 | 1, label: string) => (
    <div className="pe-pk-swatches" role="radiogroup" aria-label={label}>
      <label className="pe-pk-swatch custom" title="Custom colour">
        <Pencil size={16} aria-hidden="true" />
        <input type="color" aria-label={`${label}, custom`} value={intToHex(colors[index])} onChange={e => update({ colors: index === 0 ? [hexToInt(e.target.value), colors[1]] : [colors[0], hexToInt(e.target.value)] })} />
      </label>
      {COLOR_PRESETS.map(c => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={colors[index] === c}
          aria-label={intToHex(c)}
          className={`pe-pk-swatch${colors[index] === c ? " selected" : ""}`}
          style={{ background: intToHex(c) }}
          onClick={() => update({ colors: index === 0 ? [c, colors[1]] : [colors[0], c] })}
        />
      ))}
    </div>
  );
  const base = { id: user.id, avatar: look.avatar };
  const styled = <StyledName styles={sel} className="pe-pk-styled">{name}</StyledName>;
  return (
    <PickerModal
      title="Change display name style"
      className="pe-picker-name"
      onClose={onClose}
      onApply={() => onApply(sel)}
      canApply={!sameNameStyle(sel, value)}
      grid={
        <>
          <PickerSection title="Choose a font" label="Display name font" layout="samples">
            <NoneTile selected={sel === null} onClick={() => setSel(null)} className="sample" />
            {NAME_FONTS.map(f => (
              <PickerTile key={f.id} selected={!!sel && current.font_id === f.id} label={f.name} onClick={() => update({ font_id: f.id })} className="sample">
                <StyledName styles={{ ...current, font_id: f.id }} className="pe-pk-gg">
                  Gg
                </StyledName>
              </PickerTile>
            ))}
          </PickerSection>
          <PickerSection title="Choose an effect" label="Display name effect" layout="samples">
            {NAME_EFFECTS.map(e => (
              <PickerTile key={e.id} selected={!!sel && current.effect_id === e.id} label={e.name} onClick={() => update({ effect_id: e.id })} className="sample">
                <StyledName styles={{ ...current, effect_id: e.id, colors }} className="pe-pk-effect-name">
                  {e.name}
                </StyledName>
              </PickerTile>
            ))}
          </PickerSection>
          <section className="pe-pk-section">
            <h3 className="pe-pk-heading">Choose a colour</h3>
            {swatches(0, "Display name colour")}
            {uses === 2 && (
              <>
                <h3 className="pe-pk-heading">Choose a second colour</h3>
                {swatches(1, "Display name second colour")}
              </>
            )}
          </section>
        </>
      }
      preview={
        <div className="pe-pk-name-preview">
          <PreviewCard user={user} look={{ ...look, effect: null }} name={name} nameNode={styled} />
          <div className="pe-pk-message">
            <Avatar user={base} size={40} decoration={false} />
            <div>
              <div className="pe-pk-message-head">
                <StyledName styles={sel} className="pe-pk-styled">
                  {name}
                </StyledName>
                <span className="pe-pk-time">18:46</span>
              </div>
              <div className="pe-pk-message-text">Let your display name shine</div>
            </div>
          </div>
          <div className={`pf-nameplate-row${nameplate ? " has-nameplate" : ""}`}>
            <Nameplate id={nameplate} />
            <Avatar user={base} size={24} decoration={false} />
            <StyledName styles={sel} className="pf-nameplate-name">
              {name}
            </StyledName>
          </div>
          <p className="pe-pk-note">Styled names show in the Vokko client only.</p>
        </div>
      }
    />
  );
}

/** "Choose an image": Vokko has no GIF picker or avatar history, so this is the upload tile alone. */
export function AvatarPicker({ onUpload, onClose }: { onUpload(): void; onClose(): void }) {
  return (
    <Modal open onClose={onClose} title="Choose an image" className="pe-picker pe-picker-narrow">
      <button
        type="button"
        className="pe-pk-upload"
        onClick={() => {
          onUpload();
          onClose();
        }}
      >
        <ImagePlus size={32} aria-hidden="true" />
        Upload image
      </button>
    </Modal>
  );
}
