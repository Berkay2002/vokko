import { useState, type ReactNode } from "react";
import { ImagePlus, Plus } from "lucide-react";
import { HEX_COLOR_RE, PROFILE_THEMES, hexToInt, intToHex, themeGradient } from "../perks/catalog";
import { BannerGif, ProfileBanner, isGifUrl } from "../perks/ProfileBanner";
import { Avatar } from "../shell/Avatar";
import { ImagePicker } from "./ImagePicker";
import { DecorationPicker, EffectPicker } from "./pickers";
import { previewName } from "./previewName";
import { registerBuiltinTile, type ProfileEditorTile, type ProfileEditorTileProps } from "./registry";
import { useImageUpload } from "./upload";

const BANNER_COLORS = ["#5865f2", "#3d9e60", "#ffcb6e", "#dc4247", "#c45bd0", "#2b8fb5", "#6d7380", "#1e1f22"];
const DEFAULT_THEME: [number, number] = [hexToInt("#5865f2"), hexToInt("#8d96f7")];
const LOCKED_NOTE = "Part of your main profile";
const STRIP = { banner: null, bannerColor: "#2b2d31", themeColors: null } as const;

/** A tile and (when open) its inline panel, which spans the whole row of the tile grid. Pickers registered from outside use it too. */
export function Tile({ label, open, onToggle, locked, disabled, empty, className, children, panel, modal, onClick }: {
  label: string;
  open?: boolean;
  onToggle?(): void;
  locked?: boolean;
  disabled?: boolean;
  /** Nothing chosen yet: a "+" in a dark circle sits centred over the tile's faded placeholder. */
  empty?: boolean;
  className?: string;
  children: ReactNode;
  panel?: ReactNode;
  /** A picker modal, shown while `open`; the tile toggles `open` like a panel tile does. */
  modal?: ReactNode;
  /** Replaces the toggle: tiles that act directly (file pickers). */
  onClick?(): void;
}) {
  return (
    <>
      <button
        type="button"
        className={`pe-tile${open ? " open" : ""}${className ? ` ${className}` : ""}`}
        aria-label={label}
        aria-expanded={panel && !onClick ? !!open : undefined}
        aria-haspopup={modal ? "dialog" : undefined}
        disabled={locked || disabled}
        title={locked ? LOCKED_NOTE : label}
        onClick={onClick ?? onToggle}
      >
        {children}
        {empty && !locked && <Plus size={16} className="pe-tile-plus" aria-hidden="true" />}
      </button>
      {open && panel && !locked && <div className="pe-panel">{panel}</div>}
      {open && modal && !locked && modal}
    </>
  );
}

/** Neutral tile for a picker that is not installed yet (nameplates, display name styles, frames): the slot registry replaces it. */
export const ComingSoonTile = (label: string): ProfileEditorTile =>
  function ComingSoon({ locked }) {
    return (
      <Tile label={label} locked={locked} disabled className="pe-tile-soon" onClick={() => undefined}>
        <span className="pe-soon-name">{label}</span>
        <span className="pe-soon-note">Coming soon</span>
      </Tile>
    );
  };

function AvatarImageTile({ label, look, user, locked, uploadChannel, setDraft }: ProfileEditorTileProps & { label: string }) {
  const upload = useImageUpload(uploadChannel);
  const [picking, setPicking] = useState(false);
  const setDraftAvatar = (avatar: { id: string; url: string }) => setDraft({ avatar });
  return (
    <>
      <Tile
        label={label}
        open={picking}
        onToggle={() => setPicking(true)}
        locked={locked}
        disabled={upload.busy || !uploadChannel}
        className="pe-tile-avatar"
        modal={<ImagePicker kind="avatar" channel={uploadChannel} onUpload={upload.choose} onChoose={setDraftAvatar} onClose={() => setPicking(false)} />}
      >
        <Avatar user={{ id: user.id, avatar: look.avatar }} size={56} decoration={false} />
        {upload.busy && <span className="pe-tile-busy">Uploading…</span>}
      </Tile>
      <input
        ref={upload.inputRef}
        type="file"
        accept="image/*"
        hidden
        data-testid={`pe-file-${label.toLowerCase().replace(/\s+/g, "-")}`}
        onChange={e => void upload.pick(e.target.files?.[0]).then(file => file && setDraft({ avatar: file }))}
      />
      {upload.error && <p className="pe-field-error">{upload.error}</p>}
    </>
  );
}

const AvatarTile: ProfileEditorTile = props => <AvatarImageTile {...props} label="Avatar" />;
const AnimatedAvatarTile: ProfileEditorTile = props => <AvatarImageTile {...props} label="Animated avatar" />;

const DecorationTile: ProfileEditorTile = props => {
  const { user, look, draft, setDraft, locked, open, setOpen } = props;
  const base = { id: user.id, avatar: look.avatar };
  return (
    <Tile
      label="Avatar decoration"
      open={open}
      onToggle={() => setOpen(!open)}
      locked={locked}
      empty={!draft.decoration}
      className="pe-tile-avatar"
      modal={<DecorationPicker user={user} look={look} value={draft.decoration} onApply={decoration => setDraft({ decoration })} onClose={() => setOpen(false)} />}
    >
      {draft.decoration ? <Avatar user={base} size={56} decoration={draft.decoration} /> : <span className="pe-ph"><Avatar user={base} size={56} decoration="pixel" /></span>}
    </Tile>
  );
};

const EffectTile: ProfileEditorTile = props => {
  const { user, look, draft, setDraft, locked, open, setOpen } = props;
  return (
    <Tile
      label="Profile effect"
      open={open}
      onToggle={() => setOpen(!open)}
      locked={locked}
      empty={!draft.effect}
      className="pe-tile-effect"
      modal={<EffectPicker user={user} look={look} name={previewName(props)} value={draft.effect} onApply={effect => setDraft({ effect })} onClose={() => setOpen(false)} />}
    >
      <ProfileBanner look={{ ...STRIP, effect: draft.effect }} className="pe-effect-strip" />
    </Tile>
  );
};

const BannerColorTile: ProfileEditorTile = ({ draft, setDraft, locked, open, setOpen }) => {
  const [text, setText] = useState(draft.bannerColor ?? "");
  const invalid = text !== "" && !HEX_COLOR_RE.test(text);
  const apply = (v: string) => {
    setText(v);
    if (v === "") setDraft({ bannerColor: null });
    else if (HEX_COLOR_RE.test(v)) setDraft({ bannerColor: v.toLowerCase() });
  };
  return (
    <Tile
      label="Banner colour"
      open={open}
      onToggle={() => setOpen(!open)}
      locked={locked}
      className="pe-tile-wide pe-tile-color"
      panel={
        <>
          <div className="pe-swatches">
            {BANNER_COLORS.map(c => (
              <button key={c} type="button" className={`pe-swatch${draft.bannerColor?.toLowerCase() === c ? " selected" : ""}`} style={{ background: c }} aria-label={c} onClick={() => apply(c)} />
            ))}
          </div>
          <input className="input pe-hex" aria-label="Banner colour hex" placeholder="#rrggbb" maxLength={7} value={text} onChange={e => apply(e.target.value.trim())} />
          {invalid && <p className="pe-field-error">Use a hex colour like #5865f2.</p>}
        </>
      }
    >
      <span className="pe-color-fill" style={{ background: draft.bannerColor ?? "var(--brand-500)" }} />
    </Tile>
  );
};

const ThemeTile: ProfileEditorTile = ({ draft, setDraft, locked, open, setOpen }) => {
  const [primary, accent] = draft.theme ?? DEFAULT_THEME;
  const same = (a: [number, number]) => !!draft.theme && draft.theme[0] === a[0] && draft.theme[1] === a[1];
  return (
    <Tile
      label="Profile theme"
      open={open}
      onToggle={() => setOpen(!open)}
      locked={locked}
      className="pe-tile-wide pe-tile-theme"
      panel={
        <>
          <div className="pe-swatches" role="radiogroup" aria-label="Theme presets">
            {PROFILE_THEMES.map(t => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={same(t.colors)}
                aria-label={t.name}
                title={t.name}
                className={`pe-swatch${same(t.colors) ? " selected" : ""}`}
                style={{ background: themeGradient(t.colors) }}
                onClick={() => setDraft({ theme: [t.colors[0], t.colors[1]] })}
              />
            ))}
          </div>
          <div className="pe-inline">
            <label className="pe-color-label">
              Primary
              <input type="color" className="pe-color" value={intToHex(primary)} onChange={e => setDraft({ theme: [hexToInt(e.target.value), accent] })} />
            </label>
            <label className="pe-color-label">
              Accent
              <input type="color" className="pe-color" value={intToHex(accent)} onChange={e => setDraft({ theme: [primary, hexToInt(e.target.value)] })} />
            </label>
            <button type="button" className="btn btn-link btn-sm" disabled={!draft.theme} onClick={() => setDraft({ theme: null })}>
              Clear
            </button>
          </div>
        </>
      }
    >
      <span className="pe-theme-fill" style={{ background: themeGradient(draft.theme ?? DEFAULT_THEME) }}>
        <span className="pe-theme-swatch" style={{ background: intToHex(primary) }} />
        <span className="pe-theme-swatch" style={{ background: intToHex(accent) }} />
      </span>
    </Tile>
  );
};

const BannerImageTile: ProfileEditorTile = ({ look, locked, uploadChannel, setDraft }) => {
  const upload = useImageUpload(uploadChannel);
  const [picking, setPicking] = useState(false);
  const has = !!look.banner;
  return (
    <>
      <Tile
        label="Profile banner"
        open={picking}
        onToggle={() => setPicking(true)}
        locked={locked}
        disabled={upload.busy || !uploadChannel}
        className="pe-tile-wide pe-tile-banner"
        modal={<ImagePicker kind="banner" channel={uploadChannel} onUpload={upload.choose} onChoose={banner => setDraft({ banner })} onClose={() => setPicking(false)} />}
      >
        {look.banner && isGifUrl(look.banner) ? (
          <BannerGif src={look.banner} />
        ) : look.banner ? (
          <span className="pe-banner-fill" style={{ backgroundImage: `url("${look.banner}")` }} />
        ) : (
          <span className="pe-tile-empty">
            <ImagePlus size={20} aria-hidden="true" />
            Upload banner
          </span>
        )}
        {upload.busy && <span className="pe-tile-busy">Uploading…</span>}
      </Tile>
      <input
        ref={upload.inputRef}
        type="file"
        accept="image/*"
        hidden
        data-testid="pe-file-profile-banner"
        onChange={e => void upload.pick(e.target.files?.[0]).then(file => file && setDraft({ banner: file }))}
      />
      {has && !locked && (
        <button type="button" className="btn btn-link btn-sm pe-remove" onClick={() => setDraft({ banner: null })}>
          Remove banner
        </button>
      )}
      {upload.error && <p className="pe-field-error">{upload.error}</p>}
    </>
  );
};

registerBuiltinTile("avatar", AvatarTile);
registerBuiltinTile("animated-avatar", AnimatedAvatarTile);
registerBuiltinTile("avatar-decoration", DecorationTile);
registerBuiltinTile("profile-effect", EffectTile);
registerBuiltinTile("banner-color", BannerColorTile);
registerBuiltinTile("profile-theme", ThemeTile);
registerBuiltinTile("profile-banner", BannerImageTile);
