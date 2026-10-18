// Group DM management: the group icon, Edit Group (name + icon) and the member list (desktop right column, phone Details).
import { useMemo, useRef, useState } from "react";
import { Camera, Crown, Plus, UserPlus, X } from "lucide-react";
import { uploadAttachment } from "../api/rest";
import { displayName, dmName, useStore } from "../api/store";
import type { Channel, Snowflake, User } from "../api/types";
import { Modal, Tooltip, useContextMenu } from "../ui";
import { Avatar, GuildIcon } from "./Avatar";
import { editGroup, removeGroupRecipient } from "./actions";
import { groupMemberItems } from "./menus";
import { closeModal, openModal } from "./modalStore";
import { openProfile } from "./ProfileCard";
import "./groupDm.css";

const collator = new Intl.Collator(undefined, { sensitivity: "base" });
const IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

/** The group's own icon when it has one, else the name's initials (the sidebar keeps its stacked avatars for groups without one). */
export function GroupIcon({ channel, size }: { channel: Channel; size: number }) {
  return <GuildIcon guild={{ name: dmName(channel), icon: channel.icon ?? null }} size={size} className="group-icon" />;
}

export function EditGroupModal({ channelId }: { channelId: Snowflake }) {
  const channel = useStore(s => s.channels[channelId]);
  const [name, setName] = useState(channel?.name ?? "");
  // undefined: unchanged; {id: null}: remove the icon; {id}: a fresh upload.
  const [icon, setIcon] = useState<{ id: Snowflake | null; url: string | null } | undefined>(undefined);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  if (!channel) return null;
  const shownIcon = icon ? icon.url : (channel.icon ?? null);
  const fallbackName = (channel.recipients ?? []).map(u => displayName(u)).join(", ");

  const pick = async (selected: File | undefined) => {
    if (!selected) return;
    setUploading(true);
    setError(null);
    try {
      const attachment = await uploadAttachment(channel.id, selected);
      setIcon({ id: attachment.id, url: attachment.url });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };
  const save = () => {
    const body: { name?: string; icon_attachment_id?: Snowflake | null } = {};
    if (name.trim() !== (channel.name ?? "")) body.name = name.trim();
    if (icon) body.icon_attachment_id = icon.id;
    if (Object.keys(body).length === 0) return closeModal();
    setBusy(true);
    setError(null);
    editGroup(channel.id, body).then(closeModal, e => {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    });
  };

  return (
    <Modal
      open
      onClose={closeModal}
      title="Edit Group"
      className="modal-edit-group"
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || uploading} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <button type="button" className="icon-uploader edit-group-icon" aria-label="Change group icon" disabled={uploading} onClick={() => file.current?.click()}>
        {shownIcon ? <img src={shownIcon} alt="" width={80} height={80} /> : <Camera size={28} />}
        <span className="icon-uploader-label">{uploading ? "…" : shownIcon ? "Change" : "Upload"}</span>
        <span className="icon-uploader-plus">
          <Plus size={14} />
        </span>
      </button>
      <input ref={file} type="file" accept={IMAGE_TYPES} hidden onChange={e => void pick(e.target.files?.[0])} />
      {shownIcon && (
        <button type="button" className="link-button edit-group-remove" onClick={() => setIcon({ id: null, url: null })}>
          Remove Icon
        </button>
      )}
      <label className="field-label" htmlFor="group-name">
        Group name
      </label>
      <input
        id="group-name"
        className="input"
        value={name}
        maxLength={100}
        placeholder={fallbackName}
        autoFocus
        onChange={e => setName(e.target.value)}
        onKeyDown={e => e.key === "Enter" && !busy && !uploading && save()}
      />
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

function GroupMemberRow({ channel, user, owner, offline, canRemove }: { channel: Channel; user: User; owner: boolean; offline: boolean; canRemove: boolean }) {
  const menu = useContextMenu();
  const name = displayName(user);
  return (
    <div className="group-member" role="listitem">
      <button
        type="button"
        className={`member-row${offline ? " offline" : ""}`}
        onClick={e => openProfile(e.currentTarget, user.id, null)}
        onContextMenu={e => menu.open(e, groupMemberItems(channel, user, e.currentTarget))}
      >
        <Avatar user={user} size={32} status dim={offline} />
        <span className="member-text">
          <span className="member-name">
            {name}
            {owner && (
              <span className="group-owner" role="img" aria-label="Group Owner" title="Group Owner">
                <Crown size={14} />
              </span>
            )}
          </span>
        </span>
      </button>
      {canRemove && (
        <Tooltip content="Remove From Group" side="left">
          <button type="button" className="group-member-remove" aria-label={`Remove ${name} from group`} onClick={() => void removeGroupRecipient(channel.id, user.id)}>
            <X size={16} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/** "Members — N": everyone in the group including yourself, by name; the owner wears a crown and can remove others. */
export function GroupMembers({ channel }: { channel: Channel }) {
  const me = useStore(s => s.me);
  const presences = useStore(s => s.presences);
  const people = useMemo(
    () => [...(me ? [me] : []), ...(channel.recipients ?? []).filter(u => u.id !== me?.id)].sort((a, b) => collator.compare(displayName(a), displayName(b))),
    [me, channel.recipients],
  );
  const amOwner = !!me && channel.owner_id === me.id;
  return (
    <aside className="member-list group-members" aria-label="Members">
      <div className="member-list-scroller">
        <h2 className="member-section-title first">Members — {people.length}</h2>
        <div role="list" aria-label="Members">
          {people.map(u => (
            <GroupMemberRow
              key={u.id}
              channel={channel}
              user={u}
              owner={channel.owner_id === u.id}
              offline={(presences[u.id]?.status ?? "offline") === "offline"}
              canRemove={amOwner && u.id !== me?.id}
            />
          ))}
        </div>
        <button
          type="button"
          className="btn btn-secondary group-members-add"
          onClick={() => openModal({ type: "createDM", base: (channel.recipients ?? []).map(r => r.id), groupId: channel.id })}
        >
          <UserPlus size={16} />
          Add Friends to DM
        </button>
      </div>
    </aside>
  );
}
