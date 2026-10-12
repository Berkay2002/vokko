import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { AVATAR_DECORATIONS, HEX_COLOR_RE, PROFILE_EFFECTS, PROFILE_THEMES, hexToInt, intToHex, themeGradient } from "../perks/catalog";
import { ProfileBanner } from "../perks/ProfileBanner";
import { Avatar } from "../shell/Avatar";
import { registerBuiltinTile, type ProfileEditorTile, type ProfileEditorTileProps } from "./registry";
import { useImageUpload } from "./upload";

const BANNER_COLORS = ["#5865f2", "#3d9e60", "#ffcb6e", "#dc4247", "#c45bd0", "#2b8fb5", "#6d7380", "#1e1f22"];
const DEFAULT_THEME: [number, number] = [hexToInt("#5865f2"), hexToInt("#8d96f7")];
const LOCKED_NOTE = "Part of your main profile";
const STRIP = { banner: null, bannerColor: "#2b2d31", themeColors: null } as const;

/** A tile and (when open) its inline panel, which spans the whole row of the tile grid. */
function Tile({ label, open, onToggle, locked, disabled, className, children, panel, onClick }: {
  label: string;
  open?: boolean;
  onToggle?(): void;
  locked?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  panel?: ReactNode;
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
        disabled={locked || disabled}
        title={locked ? LOCKED_NOTE : label}
        onClick={onClick ?? onToggle}
      >
        {children}
      </button>
      {open && panel && !locked && <div className="pe-panel">{panel}</div>}
    </>
  );
}

const Plus16 = () => <Plus size={16} className="pe-tile-plus" aria-hidden="true" />;

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
  return (
    <>
      <Tile label={label} locked={locked} disabled={upload.busy || !uploadChannel} className="pe-tile-avatar" onClick={upload.choose}>
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

const DecorationTile: ProfileEditorTile = ({ user, look, draft, setDraft, locked, open, setOpen }) => {
  const base = { id: user.id, avatar: look.avatar };
  return (
    <Tile
      label="Avatar decoration"
      open={open}
      onToggle={() => setOpen(!open)}
      locked={locked}
      className="pe-tile-avatar"
      panel={
        <div className="pe-grid" role="radiogroup" aria-label="Avatar decoration">
          <button type="button" role="radio" aria-checked={draft.decoration === null} className={`pe-choice${draft.decoration === null ? " selected" : ""}`} onClick={() => setDraft({ decoration: null })}>
            <Avatar user={base} size={48} decoration={false} />
            <span>None</span>
          </button>
          {AVATAR_DECORATIONS.map(d => (
            <button key={d.id} type="button" role="radio" aria-checked={draft.decoration === d.id} className={`pe-choice${draft.decoration === d.id ? " selected" : ""}`} onClick={() => setDraft({ decoration: d.id })}>
              <Avatar user={base} size={48} decoration={d.id} />
              <span>{d.name}</span>
            </button>
          ))}
        </div>
      }
    >
      <Avatar user={base} size={56} decoration={draft.decoration ?? false} />
      {!draft.decoration && <Plus16 />}
    </Tile>
  );
};

const EffectTile: ProfileEditorTile = ({ draft, setDraft, locked, open, setOpen }) => (
  <Tile
    label="Profile effect"
    open={open}
    onToggle={() => setOpen(!open)}
    locked={locked}
    className="pe-tile-effect"
    panel={
      <div className="pe-grid" role="radiogroup" aria-label="Profile effect">
        <button type="button" role="radio" aria-checked={draft.effect === null} className={`pe-choice${draft.effect === null ? " selected" : ""}`} onClick={() => setDraft({ effect: null })}>
          <ProfileBanner look={{ ...STRIP, effect: null }} className="pe-effect-strip" />
          <span>None</span>
        </button>
        {PROFILE_EFFECTS.map(e => (
          <button key={e.id} type="button" role="radio" aria-checked={draft.effect === e.id} className={`pe-choice${draft.effect === e.id ? " selected" : ""}`} onClick={() => setDraft({ effect: e.id })}>
            <ProfileBanner look={{ ...STRIP, effect: e.id }} className="pe-effect-strip" />
            <span>{e.name}</span>
          </button>
        ))}
      </div>
    }
  >
    <ProfileBanner look={{ ...STRIP, effect: draft.effect }} className="pe-effect-strip" />
    {!draft.effect && <Plus16 />}
  </Tile>
);

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
        <span className="pe-dot" style={{ background: intToHex(primary) }} />
        <span className="pe-dot" style={{ background: intToHex(accent) }} />
      </span>
    </Tile>
  );
};

const BannerImageTile: ProfileEditorTile = ({ look, locked, uploadChannel, setDraft }) => {
  const upload = useImageUpload(uploadChannel);
  const has = !!look.banner;
  return (
    <>
      <Tile label="Profile banner" locked={locked} disabled={upload.busy || !uploadChannel} className="pe-tile-wide pe-tile-banner" onClick={upload.choose}>
        {has ? <span className="pe-banner-fill" style={{ backgroundImage: `url("${look.banner}")` }} /> : <Plus16 />}
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
