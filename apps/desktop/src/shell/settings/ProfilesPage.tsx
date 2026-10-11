import { useRef, useState } from "react";
import { ApiRequestError } from "../../api/errors";
import { request, uploadAttachment } from "../../api/rest";
import { appStore, displayName, useStore } from "../../api/store";
import type { Guild, GuildMember, GuildTag, User } from "../../api/types";
import { AVATAR_DECORATIONS, BIO_MAX, HEX_COLOR_RE, PRONOUNS_MAX, PROFILE_EFFECTS, PROFILE_THEMES, hexToInt, intToHex, themeGradient } from "../../perks/catalog";
import { ProfileBanner } from "../../perks/ProfileBanner";
import { resolveProfile, themeVars, type ProfileLook } from "../../perks/profile";
import { TagChip } from "../../perks/TagChip";
import { Avatar } from "../Avatar";
import { Field, Select } from "./controls";
import { SaveBar } from "./SaveBar";
import { blockedByUnsaved } from "./unsaved";
import { mergeMemberLocal } from "./shared";

const BANNER_COLORS = ["#5865f2", "#3d9e60", "#ffcb6e", "#dc4247", "#c45bd0", "#2b8fb5", "#6d7380", "#1e1f22"];
const DEFAULT_THEME: [number, number] = [hexToInt("#5865f2"), hexToInt("#8d96f7")];

type Theme = [number, number] | null;
/** Staged image: undefined = unchanged, null = removed, object = uploaded and waiting for Save. */
type Staged = undefined | null | { id: string; url: string };

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

const sameTheme = (a: Theme | undefined, b: Theme | undefined) => (!a && !b) || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

/** Upload / remove controls of one staged image (avatar or banner). */
function ImageField({ label, hint, current, staged, onStage }: { label: string; hint: string; current: string | null; staged: Staged; onStage(next: Staged): void }) {
  const channel = useStore(s => s.privateChannels[0] ?? Object.values(s.channels).find(c => c.guild_id)?.id);
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasImage = staged === undefined ? !!current : staged !== null;
  const pick = async (selected: File | undefined) => {
    if (!selected || !channel) return;
    setUploading(true);
    setError(null);
    try {
      const attachment = await uploadAttachment(channel, selected);
      onStage({ id: attachment.id, url: attachment.url });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUploading(false);
      if (file.current) file.current.value = "";
    }
  };
  return (
    <Field label={label} note={hint}>
      <div className="account-inline">
        <button type="button" className="btn btn-primary btn-sm" disabled={uploading || !channel} onClick={() => file.current?.click()}>
          {uploading ? "Uploading…" : `Change ${label}`}
        </button>
        <button type="button" className="btn btn-link btn-sm" disabled={uploading || !hasImage} onClick={() => onStage(null)}>
          Remove
        </button>
        <input ref={file} type="file" accept="image/*" hidden onChange={e => void pick(e.target.files?.[0])} />
      </div>
      {error && <p className="field-error">{error}</p>}
    </Field>
  );
}

function ThemeField({ value, onChange, note }: { value: Theme; onChange(next: Theme): void; note?: string }) {
  const [primary, accent] = value ?? DEFAULT_THEME;
  return (
    <Field label="Profile theme" note={note}>
      <div className="pf-theme-presets" role="radiogroup" aria-label="Theme presets">
        {PROFILE_THEMES.map(t => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={sameTheme(value, t.colors)}
            aria-label={t.name}
            title={t.name}
            className={`pf-theme-chip${sameTheme(value, t.colors) ? " selected" : ""}`}
            style={{ background: themeGradient(t.colors) }}
            onClick={() => onChange([t.colors[0], t.colors[1]])}
          />
        ))}
      </div>
      <div className="account-inline pf-theme-custom">
        <label className="pf-color-label">
          Primary
          <input type="color" className="pf-color" value={intToHex(primary)} onChange={e => onChange([hexToInt(e.target.value), accent])} />
        </label>
        <label className="pf-color-label">
          Accent
          <input type="color" className="pf-color" value={intToHex(accent)} onChange={e => onChange([primary, hexToInt(e.target.value)])} />
        </label>
        <button type="button" className="btn btn-link btn-sm" disabled={!value} onClick={() => onChange(null)}>
          Clear
        </button>
      </div>
    </Field>
  );
}

function BannerColorField({ value, onChange }: { value: string | null; onChange(next: string | null): void }) {
  const [text, setText] = useState(value ?? "");
  const invalid = text !== "" && !HEX_COLOR_RE.test(text);
  const apply = (v: string) => {
    setText(v);
    if (v === "") onChange(null);
    else if (HEX_COLOR_RE.test(v)) onChange(v.toLowerCase());
  };
  return (
    <Field label="Banner colour">
      <div className="swatches">
        {BANNER_COLORS.map(c => (
          <button key={c} type="button" className={`swatch${value?.toLowerCase() === c ? " selected" : ""}`} style={{ background: c }} aria-label={c} onClick={() => apply(c)} />
        ))}
      </div>
      <input className="input pf-hex" aria-label="Banner colour hex" placeholder="#rrggbb" maxLength={7} value={text} onChange={e => apply(e.target.value.trim())} />
      {invalid && <p className="field-error">Use a hex colour like #5865f2.</p>}
    </Field>
  );
}

function TextFields({ pronouns, bio, onPronouns, onBio }: { pronouns: string; bio: string; onPronouns(v: string): void; onBio(v: string): void }) {
  return (
    <>
      <Field label="Pronouns">
        <input className="input" aria-label="Pronouns" maxLength={PRONOUNS_MAX} value={pronouns} onChange={e => onPronouns(e.target.value)} />
        <div className="char-count">{PRONOUNS_MAX - pronouns.length}</div>
      </Field>
      <Field label="About me">
        <textarea className="input textarea" aria-label="About me" rows={4} maxLength={BIO_MAX} value={bio} onChange={e => onBio(e.target.value)} />
        <div className="char-count">{BIO_MAX - bio.length}</div>
      </Field>
    </>
  );
}

/** The popout profile card, static, for the live preview. */
function PreviewCard({ user, look, tag, guildName }: { user: User; look: ProfileLook; tag?: GuildTag | null; guildName?: string }) {
  const previewUser = { id: user.id, avatar: look.avatar, avatar_decoration: look.decoration };
  return (
    <div className="profile-preview">
      <div className="field-label">Preview</div>
      <div className={`profile-card static${look.themeColors ? " pv-themed" : ""}`} style={themeVars(look.themeColors)}>
        <ProfileBanner look={look} className="profile-banner" />
        <div className="profile-avatar">
          <Avatar user={previewUser} size={80} decoration={look.decoration} status />
        </div>
        <div className="profile-body">
          <div className="pv-name-row">
            <span className="profile-name">{displayName(user)}</span>
            {tag && <TagChip tag={tag} guildName={guildName} />}
          </div>
          <div className="profile-username">{user.username}</div>
          {look.pronouns && <div className="pv-pronouns">{look.pronouns}</div>}
          {look.bio && (
            <section className="profile-section">
              <h3>About Me</h3>
              <p>{look.bio}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function DecorationGrid({ user, avatar, value, onChange }: { user: User; avatar: string | null; value: string | null; onChange(next: string | null): void }) {
  const base = { id: user.id, avatar };
  return (
    <Field label="Avatar decoration">
      <div className="pf-grid" role="radiogroup" aria-label="Avatar decoration">
        <button type="button" role="radio" aria-checked={value === null} className={`pf-tile${value === null ? " selected" : ""}`} onClick={() => onChange(null)}>
          <Avatar user={base} size={56} decoration={false} />
          <span className="pf-tile-name">None</span>
        </button>
        {AVATAR_DECORATIONS.map(d => (
          <button key={d.id} type="button" role="radio" aria-checked={value === d.id} className={`pf-tile${value === d.id ? " selected" : ""}`} onClick={() => onChange(d.id)}>
            <Avatar user={base} size={56} decoration={d.id} />
            <span className="pf-tile-name">{d.name}</span>
          </button>
        ))}
      </div>
    </Field>
  );
}

const STRIP = { banner: null, bannerColor: "#2b2d31", themeColors: null } as const;

function EffectGrid({ value, onChange }: { value: string | null; onChange(next: string | null): void }) {
  return (
    <Field label="Profile effect">
      <div className="pf-grid" role="radiogroup" aria-label="Profile effect">
        <button type="button" role="radio" aria-checked={value === null} className={`pf-tile${value === null ? " selected" : ""}`} onClick={() => onChange(null)}>
          <ProfileBanner look={{ ...STRIP, effect: null }} className="pf-effect-strip" />
          <span className="pf-tile-name">None</span>
        </button>
        {PROFILE_EFFECTS.map(e => (
          <button key={e.id} type="button" role="radio" aria-checked={value === e.id} className={`pf-tile${value === e.id ? " selected" : ""}`} onClick={() => onChange(e.id)}>
            <ProfileBanner look={{ ...STRIP, effect: e.id }} className="pf-effect-strip" />
            <span className="pf-tile-name">{e.name}</span>
          </button>
        ))}
      </div>
    </Field>
  );
}

function UserProfileTab({ me }: { me: User }) {
  const guilds = useStore(s => s.guilds);
  const guildOrder = useStore(s => s.guildOrder);
  const init = () => ({
    avatar: undefined as Staged,
    banner: undefined as Staged,
    bannerColor: me.banner_color as string | null,
    theme: (me.theme_colors ?? null) as Theme,
    pronouns: me.pronouns ?? "",
    bio: me.bio ?? "",
    decoration: me.avatar_decoration ?? null,
    effect: me.profile_effect ?? null,
    tagGuild: me.primary_guild?.guild_id ?? null,
  });
  const [draft, setDraft] = useState(init);
  const [formKey, setFormKey] = useState(0);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const set = (patch: Partial<ReturnType<typeof init>>) => setDraft(d => ({ ...d, ...patch }));

  const tagGuilds = guildOrder.map(id => guilds[id]).filter((g): g is Guild & { tag: GuildTag } => !!g && !!g.tag);
  const initial = init();
  const dirty =
    draft.avatar !== undefined ||
    draft.banner !== undefined ||
    (draft.bannerColor ?? null) !== (initial.bannerColor ?? null) ||
    !sameTheme(draft.theme, initial.theme) ||
    draft.pronouns.trim() !== initial.pronouns ||
    draft.bio.trim() !== initial.bio ||
    draft.decoration !== initial.decoration ||
    draft.effect !== initial.effect ||
    draft.tagGuild !== initial.tagGuild;

  const reset = () => {
    setDraft(init());
    setFormKey(k => k + 1);
    setState({ busy: false, error: null });
  };

  const save = async () => {
    const patch: Record<string, unknown> = {};
    if (draft.avatar !== undefined) patch.avatar_attachment_id = draft.avatar?.id ?? null;
    if (draft.banner !== undefined) patch.banner_attachment_id = draft.banner?.id ?? null;
    if ((draft.bannerColor ?? null) !== (initial.bannerColor ?? null)) patch.banner_color = draft.bannerColor;
    if (!sameTheme(draft.theme, initial.theme)) patch.theme_colors = draft.theme;
    if (draft.pronouns.trim() !== initial.pronouns) patch.pronouns = draft.pronouns.trim() || null;
    if (draft.bio.trim() !== initial.bio) patch.bio = draft.bio.trim() || null;
    if (draft.decoration !== initial.decoration) patch.avatar_decoration = draft.decoration;
    if (draft.effect !== initial.effect) patch.profile_effect = draft.effect;
    if (draft.tagGuild !== initial.tagGuild) patch.primary_guild_id = draft.tagGuild;
    setState({ busy: true, error: null });
    try {
      const user = await request<User>("PATCH", "/users/@me", patch);
      appStore.getState().setMe(user);
      appStore.getState().cacheUsers([user]);
      setDraft(d => ({ ...d, avatar: undefined, banner: undefined }));
      setState({ busy: false, error: null });
    } catch (e) {
      setState({ busy: false, error: errorText(e) });
    }
  };

  const avatarUrl = draft.avatar === undefined ? me.avatar : draft.avatar?.url ?? null;
  const bannerUrl = draft.banner === undefined ? me.banner ?? null : draft.banner?.url ?? null;
  const look: ProfileLook = {
    avatar: avatarUrl,
    banner: bannerUrl,
    bannerColor: draft.bannerColor,
    bio: draft.bio.trim() || null,
    pronouns: draft.pronouns.trim() || null,
    themeColors: draft.theme,
    decoration: draft.decoration,
    effect: draft.effect,
  };
  const tagGuild = draft.tagGuild ? guilds[draft.tagGuild] : undefined;

  return (
    <>
      <div className="profiles-layout">
        <div className="profiles-form" key={formKey}>
          <ImageField label="Avatar" hint="GIF and WebP avatars animate. Up to 8 MiB." current={me.avatar} staged={draft.avatar} onStage={avatar => set({ avatar })} />
          <ImageField label="Banner" hint="Up to 10 MiB, shown at 17:6" current={me.banner ?? null} staged={draft.banner} onStage={banner => set({ banner })} />
          <BannerColorField value={draft.bannerColor} onChange={bannerColor => set({ bannerColor })} />
          <ThemeField value={draft.theme} onChange={theme => set({ theme })} />
          <TextFields pronouns={draft.pronouns} bio={draft.bio} onPronouns={pronouns => set({ pronouns })} onBio={bio => set({ bio })} />
          <DecorationGrid user={me} avatar={avatarUrl} value={draft.decoration} onChange={decoration => set({ decoration })} />
          <EffectGrid value={draft.effect} onChange={effect => set({ effect })} />
          <Field label="Server tag">
            {tagGuilds.length === 0 ? (
              <p className="settings-todo">None of your servers has a tag yet.</p>
            ) : (
              <div className="account-inline">
                <Select
                  label="Server tag"
                  value={draft.tagGuild ?? ""}
                  options={[{ value: "", label: "None" }, ...tagGuilds.map(g => ({ value: g.id, label: `${g.tag.tag} · ${g.name}` }))]}
                  onChange={v => set({ tagGuild: v || null })}
                />
                {tagGuild?.tag && <TagChip tag={tagGuild.tag} guildName={tagGuild.name} />}
              </div>
            )}
          </Field>
        </div>
        <PreviewCard user={me} look={look} tag={tagGuild?.tag} guildName={tagGuild?.name} />
      </div>
      <SaveBar visible={dirty} busy={state.busy} error={state.error} onReset={reset} onSave={() => void save()} />
    </>
  );
}

function ServerForm({ me, guild }: { me: User; guild: Guild }) {
  const member = useStore(s => s.members[guild.id]?.[me.id]);
  const init = () => ({
    avatar: undefined as Staged,
    banner: undefined as Staged,
    theme: (member?.theme_colors ?? null) as Theme,
    pronouns: member?.pronouns ?? "",
    bio: member?.bio ?? "",
  });
  const [draft, setDraft] = useState(init);
  const [formKey, setFormKey] = useState(0);
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const set = (patch: Partial<ReturnType<typeof init>>) => setDraft(d => ({ ...d, ...patch }));
  const initial = init();
  const dirty = draft.avatar !== undefined || draft.banner !== undefined || !sameTheme(draft.theme, initial.theme) || draft.pronouns.trim() !== initial.pronouns || draft.bio.trim() !== initial.bio;

  const reset = () => {
    setDraft(init());
    setFormKey(k => k + 1);
    setState({ busy: false, error: null });
  };

  const save = async () => {
    const patch: Record<string, unknown> = {};
    if (draft.avatar !== undefined) patch.avatar_attachment_id = draft.avatar?.id ?? null;
    if (draft.banner !== undefined) patch.banner_attachment_id = draft.banner?.id ?? null;
    if (!sameTheme(draft.theme, initial.theme)) patch.theme_colors = draft.theme;
    if (draft.pronouns.trim() !== initial.pronouns) patch.pronouns = draft.pronouns.trim() || null;
    if (draft.bio.trim() !== initial.bio) patch.bio = draft.bio.trim() || null;
    setState({ busy: true, error: null });
    try {
      const updated = await request<GuildMember>("PATCH", `/guilds/${guild.id}/members/@me`, patch);
      mergeMemberLocal(guild.id, updated);
      setDraft(d => ({ ...d, avatar: undefined, banner: undefined }));
      setState({ busy: false, error: null });
    } catch (e) {
      setState({ busy: false, error: errorText(e) });
    }
  };

  const avatarUrl = draft.avatar === undefined ? member?.avatar ?? null : draft.avatar?.url ?? null;
  const bannerUrl = draft.banner === undefined ? member?.banner ?? null : draft.banner?.url ?? null;
  const look = resolveProfile(me, { avatar: avatarUrl, banner: bannerUrl, bio: draft.bio.trim() || null, pronouns: draft.pronouns.trim() || null, theme_colors: draft.theme });
  const mine = me.primary_guild?.guild_id === guild.id ? me.primary_guild : null;

  return (
    <>
      <div className="profiles-layout">
        <div className="profiles-form" key={formKey}>
          <p className="settings-todo">Overrides your profile only in this server.</p>
          <ImageField label="Server avatar" hint="GIF and WebP avatars animate. Up to 8 MiB." current={member?.avatar ?? null} staged={draft.avatar} onStage={avatar => set({ avatar })} />
          <ImageField label="Server banner" hint="Up to 10 MiB, shown at 17:6" current={member?.banner ?? null} staged={draft.banner} onStage={banner => set({ banner })} />
          <ThemeField value={draft.theme} onChange={theme => set({ theme })} note="Clear a field to fall back to your main profile." />
          <TextFields pronouns={draft.pronouns} bio={draft.bio} onPronouns={pronouns => set({ pronouns })} onBio={bio => set({ bio })} />
        </div>
        <PreviewCard user={me} look={look} tag={mine} guildName={mine ? guild.name : undefined} />
      </div>
      <SaveBar visible={dirty} busy={state.busy} error={state.error} onReset={reset} onSave={() => void save()} />
    </>
  );
}

function ServerProfilesTab({ me }: { me: User }) {
  const guilds = useStore(s => s.guilds);
  const guildOrder = useStore(s => s.guildOrder);
  const list = guildOrder.map(id => guilds[id]).filter((g): g is Guild => !!g);
  const [selected, setSelected] = useState<string>(list[0]?.id ?? "");
  const guild = guilds[selected] ?? list[0];
  if (!guild) return <p className="settings-todo">You are not in any servers yet.</p>;
  return (
    <>
      <Field label="Server">
        <Select label="Server" value={guild.id} options={list.map(g => ({ value: g.id, label: g.name }))} onChange={setSelected} />
      </Field>
      <ServerForm key={guild.id} me={me} guild={guild} />
    </>
  );
}

export function ProfilesPage({ me }: { me: User }) {
  const [tab, setTab] = useState<"user" | "server">("user");
  // A dirty draft would be dropped with the tab, so the unsaved guard answers the click with a shake instead.
  const go = (next: "user" | "server") => {
    if (next !== tab && !blockedByUnsaved()) setTab(next);
  };
  return (
    <div className="settings-page profiles-page">
      <h1>Profiles</h1>
      <div className="pf-tabs" role="tablist" aria-label="Profile type">
        <button type="button" role="tab" aria-selected={tab === "user"} className={`pf-tab${tab === "user" ? " active" : ""}`} onClick={() => go("user")}>
          User Profile
        </button>
        <button type="button" role="tab" aria-selected={tab === "server"} className={`pf-tab${tab === "server" ? " active" : ""}`} onClick={() => go("server")}>
          Per-server profiles
        </button>
      </div>
      {tab === "user" ? <UserProfileTab me={me} /> : <ServerProfilesTab me={me} />}
    </div>
  );
}
