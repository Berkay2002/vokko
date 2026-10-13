import { useRef, useState, type ReactNode } from "react";
import { ChevronDown, MessageCircle, MoreHorizontal, Pencil, Plus } from "lucide-react";
import { snowflakeToTimestamp } from "../api/snowflake";
import { displayName, useStore } from "../api/store";
import type { GuildMember, GuildTag, User } from "../api/types";
import { BIO_MAX, PRONOUNS_MAX } from "../perks/catalog";
import { ProfileBanner } from "../perks/ProfileBanner";
import { themeVars, type ProfileLook } from "../perks/profile";
import { TagChip } from "../perks/TagChip";
import { loadStoredStatus, setOwnStatus } from "../shell/actions";
import { Avatar } from "../shell/Avatar";
import { useContextMenu, type MenuItem } from "../ui";
import type { ProfileDraft, Scope } from "./draft";
import { ImagePicker } from "./ImagePicker";
import { useImageUpload } from "./upload";
import { clip } from "./widgets";

/** Click-to-edit text: shows `display` until clicked, then an input with a focus ring. Enter (single line) or blur ends editing. */
function InlineEdit({ value, onChange, display, label, placeholder, max, multiline, className }: {
  value: string;
  onChange(next: string): void;
  display: ReactNode;
  label: string;
  placeholder?: string;
  max: number;
  multiline?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button type="button" className={`pe-inline-display${className ? ` ${className}` : ""}`} aria-label={`Edit ${label}`} onClick={() => setEditing(true)}>
        {display}
      </button>
    );
  }
  const shared = {
    className: `pe-inline-input${className ? ` ${className}` : ""}`,
    "aria-label": label,
    "data-inline-edit": "",
    autoFocus: true,
    placeholder,
    value,
    // counted in code points like the server (an input's maxLength counts UTF-16 units and would refuse valid emoji text)
    onChange: (e: { target: { value: string } }) => onChange(clip(e.target.value, max)),
    onBlur: () => setEditing(false),
  };
  return multiline ? (
    <textarea {...shared} rows={4} />
  ) : (
    <input
      {...shared}
      onKeyDown={e => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

export interface CardPreviewProps {
  user: User;
  member: GuildMember | null;
  guildName?: string;
  scope: Scope;
  draft: ProfileDraft;
  look: ProfileLook;
  setDraft(patch: Partial<ProfileDraft>): void;
  uploadChannel: string | null;
  /** "Change avatar decoration", "Change banner colour": scroll the left column to that tile and open it. */
  onOpenTile(id: string): void;
}

/** The profile as others see it, editable in place. */
export function CardPreview({ user, member, guildName, scope, draft, look, setDraft, uploadChannel, onOpenTile }: CardPreviewProps) {
  const guild = scope.kind === "guild";
  const menu = useContextMenu();
  const upload = useImageUpload(uploadChannel);
  const bannerUpload = useImageUpload(uploadChannel);
  const presence = useStore(s => s.presences[user.id]);
  const guilds = useStore(s => s.guilds);
  const guildOrder = useStore(s => s.guildOrder);
  const [pickingAvatar, setPickingAvatar] = useState(false);
  const [pickingBanner, setPickingBanner] = useState(false);
  const [statusEditing, setStatusEditing] = useState(false);
  const [statusText, setStatusText] = useState("");
  const avatarButton = useRef<HTMLButtonElement>(null);
  const bannerButton = useRef<HTMLButtonElement>(null);

  const tagGuilds = guildOrder.map(id => guilds[id]).filter((g): g is NonNullable<typeof g> & { tag: GuildTag } => !!g && !!g.tag);
  const tagGuild = draft.tagGuild ? guilds[draft.tagGuild] : undefined;
  const tag = tagGuild?.tag ?? null;
  const shownName = draft.name.trim() || (guild ? displayName(user) : user.username);
  const customStatus = presence?.custom_status ?? "";
  const since = guild && member ? new Date(member.joined_at) : new Date(snowflakeToTimestamp(user.id));

  const openAvatarMenu = () => {
    const rect = avatarButton.current?.getBoundingClientRect();
    if (!rect) return;
    const items: MenuItem[] = [
      { id: "avatar-change", label: "Change avatar", onSelect: () => setPickingAvatar(true) },
      { id: "avatar-decoration", label: "Change avatar decoration", disabled: guild, tooltip: guild ? "Part of your main profile" : undefined, onSelect: () => onOpenTile("avatar-decoration") },
      { id: "avatar-remove", label: "Remove avatar", danger: true, onSelect: () => setDraft({ avatar: null }) },
    ];
    menu.open({ clientX: rect.right - 24, clientY: rect.top + rect.height / 2 }, items);
  };

  const openBannerMenu = () => {
    const rect = bannerButton.current?.getBoundingClientRect();
    if (!rect) return;
    const items: MenuItem[] = [
      { id: "banner-change", label: "Change banner", onSelect: () => setPickingBanner(true) },
      { id: "banner-color", label: "Change banner colour", disabled: guild, tooltip: guild ? "Part of your main profile" : undefined, onSelect: () => onOpenTile("banner-color") },
      ...(look.banner ? [{ id: "banner-remove", label: "Remove banner", danger: true, onSelect: () => setDraft({ banner: null }) }] : []),
    ];
    menu.open({ clientX: rect.right, clientY: rect.bottom + 4 }, items);
  };

  const openTagMenu = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = [
      { id: "tag-none", label: "No server tag", checked: draft.tagGuild === null, onSelect: () => setDraft({ tagGuild: null }) },
      ...tagGuilds.map(g => ({ id: `tag-${g.id}`, label: `${g.tag.tag} · ${g.name}`, checked: draft.tagGuild === g.id, onSelect: () => setDraft({ tagGuild: g.id }) })),
    ];
    menu.open({ clientX: rect.left, clientY: rect.bottom + 4 }, items);
  };

  const commitStatus = () => {
    setStatusEditing(false);
    if (statusText.trim() !== customStatus) setOwnStatus(loadStoredStatus().status, statusText);
  };

  return (
    <div className={`pe-card${look.themeColors ? " pv-themed" : ""}`} style={themeVars(look.themeColors)} data-testid="pe-card">
      <ProfileBanner look={look} className="pe-card-banner">
        <button ref={bannerButton} type="button" className="pe-card-banner-edit" aria-label="Edit banner" aria-haspopup="menu" disabled={bannerUpload.busy} onClick={openBannerMenu}>
          <Pencil size={18} />
        </button>
      </ProfileBanner>
      <input
        ref={bannerUpload.inputRef}
        type="file"
        accept="image/*"
        hidden
        data-testid="pe-file-card-banner"
        onChange={e => void bannerUpload.pick(e.target.files?.[0]).then(file => file && setDraft({ banner: file }))}
      />
      <div className="pe-card-head">
        <button ref={avatarButton} type="button" className="pe-card-avatar" aria-label="Edit avatar" aria-haspopup="menu" disabled={upload.busy} onClick={openAvatarMenu}>
          <Avatar user={{ id: user.id, avatar: look.avatar }} size={120} decoration={look.decoration ?? false} status />
          <span className="pe-card-avatar-edit" aria-hidden="true">
            <Pencil size={20} />
          </span>
        </button>
        <input
          ref={upload.inputRef}
          type="file"
          accept="image/*"
          hidden
          data-testid="pe-file-card-avatar"
          onChange={e => void upload.pick(e.target.files?.[0]).then(file => file && setDraft({ avatar: file }))}
        />
        {statusEditing ? (
          <input
            className="pe-status-input"
            aria-label="Custom status"
            data-inline-edit=""
            autoFocus
            placeholder="What's on your mind?"
            value={statusText}
            onChange={e => setStatusText(clip(e.target.value, 128))}
            onBlur={commitStatus}
            onKeyDown={e => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        ) : (
          <button
            type="button"
            className={`pe-status-bubble${customStatus ? " set" : ""}`}
            onClick={() => {
              setStatusText(customStatus);
              setStatusEditing(true);
            }}
          >
            {customStatus ? null : <Plus size={16} aria-hidden="true" />}
            <span>{customStatus || "What's on your mind?"}</span>
          </button>
        )}
      </div>
      {pickingAvatar && <ImagePicker kind="avatar" channel={uploadChannel} onUpload={upload.choose} onChoose={avatar => setDraft({ avatar })} onClose={() => setPickingAvatar(false)} />}
      {pickingBanner && <ImagePicker kind="banner" channel={uploadChannel} onUpload={bannerUpload.choose} onChoose={banner => setDraft({ banner })} onClose={() => setPickingBanner(false)} />}
      {(upload.error || bannerUpload.error) && <p className="pe-field-error pe-card-error">{upload.error ?? bannerUpload.error}</p>}
      <div className="pe-card-body">
        <div className="pe-name">
          <InlineEdit
            className="pe-name-text"
            label="Display name"
            value={draft.name}
            max={32}
            placeholder={guild ? displayName(user) : user.username}
            onChange={name => setDraft({ name })}
            display={shownName}
          />
        </div>
        <div className="pe-names-row">
          <span className="pe-username">{user.username}</span>
          <span className="pe-dot-sep" aria-hidden="true">
            •
          </span>
          <InlineEdit
            className="pe-pronouns"
            label="Pronouns"
            value={draft.pronouns}
            max={PRONOUNS_MAX}
            placeholder="Add pronouns"
            onChange={pronouns => setDraft({ pronouns })}
            display={look.pronouns ? <span>{look.pronouns}</span> : <em>Add pronouns</em>}
          />
          {!guild && tagGuilds.length > 0 && (
            <button type="button" className="pe-tag-button" aria-haspopup="menu" aria-label="Server tag" onClick={openTagMenu}>
              {tag ? <TagChip tag={tag} guildName={tagGuild?.name} /> : <span className="pe-tag-none">No tag</span>}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="pe-actions" aria-label="Profile actions (preview)">
          <button type="button" className="btn btn-primary pe-message" disabled>
            <MessageCircle size={16} /> Message
          </button>
          <button type="button" className="btn btn-secondary pe-icon-button" disabled aria-label="More">
            <MoreHorizontal size={16} />
          </button>
        </div>
        <section className="pe-section">
          <h3>About Me</h3>
          <InlineEdit
            className="pe-bio"
            label="Bio"
            value={draft.bio}
            max={BIO_MAX}
            multiline
            placeholder="Tell us a bit about yourself"
            onChange={bio => setDraft({ bio })}
            display={look.bio ? <span className="pe-bio-text">{look.bio}</span> : <em>Tell us a bit about yourself</em>}
          />
        </section>
        <section className="pe-section">
          <h3>Member Since</h3>
          <p>{since.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</p>
        </section>
        {guild && guildName && <p className="pe-card-note">Server profile for {guildName}. Empty fields fall back to your main profile.</p>}
      </div>
    </div>
  );
}
