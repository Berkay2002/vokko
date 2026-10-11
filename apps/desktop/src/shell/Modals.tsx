import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, Camera, MessagesSquare, Check, ChevronRight, Copy, Gamepad2, GraduationCap, Hash, Heart, MapPin, Palette, Plus, Users, Volume2, type LucideIcon } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { request, uploadAttachment } from "../api/rest";
import { appStore, displayName, useStore } from "../api/store";
import { ChannelType, RelationshipType } from "../api/types";
import { Modal } from "../ui";
import { Avatar } from "./Avatar";
import { createChannel, createGroupDM, createGuild, createInvite, deleteGuild, joinGuildWithInvite, leaveGuild, type Invite } from "./actions";
import { ChannelSettings } from "./ChannelSettings";
import { FullProfileModal } from "./DmProfilePanel";
import { BanModal, KickModal, NicknameModal, TimeoutModal } from "./ModerationModals";
import { NOTIFY_LABELS, setNotifyLevel, toggleFlag, useLocalState, type NotifyLevel } from "./localState";
import { closeModal, useModals, type ModalSpec } from "./modalStore";
import { QuickSwitcher } from "./QuickSwitcher";
import { ServerSettings } from "./ServerSettings";
import { RadioGroup, SwitchRow, Toggle } from "./settings/controls";
import { SERVER_TEMPLATES, type ServerTemplate } from "./templates";
import { UserSettings } from "./UserSettings";

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const field = error.api.errors && Object.values(error.api.errors)[0];
    const detail = field && typeof field === "object" && "message" in field ? String((field as { message: unknown }).message) : null;
    return detail ?? error.message;
  }
  return "Something went wrong. Try again.";
}

function Confirm({ title, body, action, danger, onConfirm, requireText }: { title: string; body: ReactNode; action: string; danger?: boolean; onConfirm: () => Promise<void>; /** Typed confirmation, e.g. the server name. */ requireText?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [mismatch, setMismatch] = useState(false);
  return (
    <Modal
      open
      onClose={closeModal}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={closeModal}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            disabled={busy}
            onClick={() => {
              if (requireText !== undefined && typed.trim() !== requireText) {
                setMismatch(true);
                return;
              }
              setBusy(true);
              onConfirm()
                .then(closeModal)
                .catch(e => {
                  setError(errorText(e));
                  setBusy(false);
                });
            }}
          >
            {action}
          </button>
        </>
      }
    >
      <p className="modal-text">{body}</p>
      {requireText !== undefined && (
        <>
          <label className={`field-label${mismatch ? " error" : ""}`} htmlFor="confirm-text">
            Enter server name
          </label>
          <input id="confirm-text" className="input" value={typed} autoFocus onChange={e => (setTyped(e.target.value), setMismatch(false))} />
          {mismatch && <p className="field-error">You didn&apos;t enter the server name correctly</p>}
        </>
      )}
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  gaming: Gamepad2,
  "school-club": GraduationCap,
  "study-group": BookOpen,
  friends: Heart,
  creators: Palette,
  community: MapPin,
};

function CreateServer() {
  const [step, setStep] = useState<"choose" | "purpose" | "customize" | "join">("choose");
  const [template, setTemplate] = useState<ServerTemplate | undefined>(undefined);
  const me = useStore(s => s.me);
  const uploadChannel = useStore(s => s.privateChannels[0] ?? Object.values(s.channels).find(c => c.guild_id)?.id);
  const [name, setName] = useState(me ? `${me.global_name ?? me.username}'s server` : "");
  const [code, setCode] = useState("");
  const [icon, setIcon] = useState<{ id: string; url: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const run = (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    task()
      .then(closeModal)
      .catch(e => {
        setError(errorText(e));
        setBusy(false);
      });
  };

  const pickIcon = async (selected: File | undefined) => {
    if (!selected || !uploadChannel) return;
    setUploading(true);
    setError(null);
    try {
      const attachment = await uploadAttachment(uploadChannel, selected);
      setIcon({ id: attachment.id, url: attachment.url });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUploading(false);
    }
  };

  if (step === "choose")
    return (
      <Modal open onClose={closeModal} title="Create Your Server" className="modal-create-server">
        <p className="modal-text center">Your server is where you and your friends hang out. Make yours and start talking.</p>
        <button
          type="button"
          className="choice-row"
          onClick={() => {
            setTemplate(undefined);
            setStep("purpose");
          }}
        >
          <span className="choice-icon">
            <Plus size={20} />
          </span>
          <span>Create My Own</span>
          <ChevronRight size={20} />
        </button>
        <div className="modal-subheading">Start from a template</div>
        {SERVER_TEMPLATES.map(t => {
          const Icon = TEMPLATE_ICONS[t.id] ?? Hash;
          return (
            <button
              key={t.id}
              type="button"
              className="choice-row"
              onClick={() => {
                setTemplate(t);
                setStep("customize");
              }}
            >
              <span className="choice-icon">
                <Icon size={20} />
              </span>
              <span>{t.label}</span>
              <ChevronRight size={20} />
            </button>
          );
        })}
        <div className="modal-subheading">Have an invite already?</div>
        <button type="button" className="btn btn-secondary btn-wide" onClick={() => setStep("join")}>
          Join a Server
        </button>
      </Modal>
    );

  if (step === "purpose")
    return (
      <Modal
        open
        onClose={closeModal}
        title="Tell Us More About Your Server"
        footer={
          <>
            <button type="button" className="btn btn-link footer-back" onClick={() => setStep("choose")}>
              Back
            </button>
          </>
        }
      >
        <p className="modal-text center">In order to help you with your setup, is your new server for just a few friends or a larger community?</p>
        <button type="button" className="choice-row" onClick={() => setStep("customize")}>
          <span className="choice-icon muted">
            <Users size={20} />
          </span>
          <span>For me and my friends</span>
          <ChevronRight size={20} />
        </button>
        <button type="button" className="choice-row" onClick={() => setStep("customize")}>
          <span className="choice-icon muted">
            <Users size={20} />
          </span>
          <span>For a club or community</span>
          <ChevronRight size={20} />
        </button>
        <p className="modal-text center skip">
          Not sure? You can <button type="button" className="link-button" onClick={() => setStep("customize")}>skip this question</button> for now.
        </p>
      </Modal>
    );

  if (step === "customize")
    return (
      <Modal
        open
        onClose={closeModal}
        title="Customize Your Server"
        footer={
          <>
            <button type="button" className="btn btn-link footer-back" onClick={() => setStep(template ? "choose" : "purpose")}>
              Back
            </button>
            <button type="button" className="btn btn-primary" disabled={busy || uploading || name.trim().length < 2} onClick={() => run(() => createGuild(name.trim(), icon?.id, template))}>
              Create
            </button>
          </>
        }
      >
        <p className="modal-text center">Give your new server a personality with a name and an icon. You can always change it later.</p>
        <button type="button" className="icon-uploader" aria-label="Upload an icon" disabled={uploading || !uploadChannel} onClick={() => file.current?.click()}>
          {icon ? <img src={icon.url} alt="" width={80} height={80} /> : <Camera size={28} />}
          <span className="icon-uploader-label">{uploading ? "…" : "Upload"}</span>
          <span className="icon-uploader-plus">
            <Plus size={14} />
          </span>
        </button>
        <input ref={file} type="file" accept="image/*" hidden onChange={e => void pickIcon(e.target.files?.[0])} />
        <label className="field-label" htmlFor="server-name">
          Server name <span className="required">*</span>
        </label>
        <input id="server-name" className="input" value={name} maxLength={100} autoFocus onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && name.trim().length >= 2 && run(() => createGuild(name.trim(), icon?.id, template))} />
        {error && <p className="field-error">{error}</p>}
      </Modal>
    );

  return (
    <Modal
      open
      onClose={closeModal}
      title="Join a Server"
      footer={
        <>
          <button type="button" className="btn btn-link footer-back" onClick={() => setStep("choose")}>
            Back
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !code.trim()} onClick={() => run(() => joinGuildWithInvite(code))}>
            Join Server
          </button>
        </>
      }
    >
      <p className="modal-text center">Enter an invite below to join an existing server.</p>
      <label className="field-label" htmlFor="invite-code">
        Invite link <span className="required">*</span>
      </label>
      <input id="invite-code" className="input" value={code} placeholder="hTKzmak or vokko.gg/hTKzmak" autoFocus onChange={e => setCode(e.target.value)} onKeyDown={e => e.key === "Enter" && code.trim() && run(() => joinGuildWithInvite(code))} />
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

function InviteModal({ channelId }: { channelId: string }) {
  const channel = useStore(s => s.channels[channelId]);
  const guild = useStore(s => (channel?.guild_id ? s.guilds[channel.guild_id] : undefined));
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    createInvite(channelId)
      .then(i => live && setInvite(i))
      .catch(e => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [channelId]);
  const link = invite ? `vokko.gg/${invite.code}` : "";
  return (
    <Modal open onClose={closeModal} title={guild ? `Invite friends to ${guild.name}` : "Invite friends"}>
      <p className="modal-subtle">
        Sending invite to <Hash size={14} className="inline-icon" /> {channel?.name}
      </p>
      <label className="field-label" htmlFor="invite-link">
        Or send a server invite link to a friend
      </label>
      <div className="copy-field">
        <input id="invite-link" className="input" readOnly value={invite ? link : error ? "" : "Generating…"} onFocus={e => e.currentTarget.select()} />
        <button
          type="button"
          className={`btn ${copied ? "btn-success" : "btn-primary"}`}
          disabled={!invite}
          onClick={() => {
            void navigator.clipboard?.writeText(link);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? (
            <>
              <Check size={16} /> Copied
            </>
          ) : (
            <>
              <Copy size={16} /> Copy
            </>
          )}
        </button>
      </div>
      <p className="modal-subtle">Your invite link expires in 24 hours.</p>
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

function CreateChannelModal({ guildId, parentId, channelType }: { guildId: string; parentId?: string | null; channelType?: ChannelType }) {
  const [type, setType] = useState<ChannelType>(channelType ?? ChannelType.GuildText);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const category = type === ChannelType.GuildCategory;
  const parent = useStore(s => (parentId ? s.channels[parentId] : undefined));
  const slug = category ? name : name.toLowerCase().replace(/\s+/g, "-");
  const submit = () => {
    if (!slug.trim()) return;
    setBusy(true);
    const body = {
      name: slug.trim(),
      type,
      parent_id: category ? null : (parentId ?? null),
      // Private channel: @everyone is denied VIEW_CHANNEL (bit 10).
      ...(isPrivate ? { permission_overwrites: [{ id: guildId, type: 0, allow: "0", deny: String(1n << 10n) }] } : {}),
    };
    createChannel(guildId, body as Parameters<typeof createChannel>[1])
      .then(closeModal)
      .catch(e => {
        setError(errorText(e));
        setBusy(false);
      });
  };
  const option = (value: ChannelType, icon: ReactNode, label: string, description: string, disabled?: boolean) => (
    <button
      key={`${value}-${label}`}
      type="button"
      role="radio"
      aria-checked={!disabled && type === value}
      aria-disabled={disabled || undefined}
      title={disabled ? "Not available yet" : undefined}
      className={`radio-row${!disabled && type === value ? " selected" : ""}${disabled ? " disabled" : ""}`}
      onClick={() => !disabled && setType(value)}
    >
      <span className="radio-dot" />
      <span className="radio-text">
        <span className="radio-label">
          {icon}
          {label}
        </span>
        <span className="radio-desc">{description}</span>
      </span>
    </button>
  );
  return (
    <Modal
      open
      onClose={closeModal}
      title={category ? "Create Category" : "Create Channel"}
      className="modal-compact"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={closeModal}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !slug.trim()} onClick={submit}>
            {category ? "Create Category" : "Create Channel"}
          </button>
        </>
      }
    >
      {parent && !category && <p className="modal-subtle">in {parent.name}</p>}
      {!category && (
        <>
          <div className="field-label">Channel type</div>
          <div role="radiogroup" className="radio-group">
            {option(ChannelType.GuildText, <Hash size={16} />, "Text", "Send messages, images, GIFs, emoji, opinions, and puns")}
            {option(ChannelType.GuildVoice, <Volume2 size={16} />, "Voice", "Hang out together with voice, video, and screen share")}
            {option(ChannelType.GuildText, <MessagesSquare size={16} />, "Forum", "Create a space for organized discussions", true)}
          </div>
        </>
      )}
      <label className="field-label" htmlFor="channel-name">
        {category ? "Category name" : "Channel name"}
      </label>
      <div className="input-prefixed">
        {!category && (type === ChannelType.GuildVoice ? <Volume2 size={16} /> : <Hash size={16} />)}
        <input id="channel-name" className="input" value={name} maxLength={100} autoFocus placeholder={category ? "New Category" : "new-channel"} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && submit()} />
      </div>
      <div className="switch-row">
        <div className="switch-row-text">
          <div className="switch-row-label">{category ? "Private Category" : "Private Channel"}</div>
          <div className="switch-row-note">Only selected members and roles will be able to view this {category ? "category" : "channel"}.</div>
        </div>
        <Toggle checked={isPrivate} onChange={setIsPrivate} label="Private" />
      </div>
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

function NotificationSettingsModal({ scopeId, title, guild }: { scopeId: string; title: string; guild?: boolean }) {
  const level = useLocalState(s => s.notify[scopeId] ?? "default");
  const everyone = useLocalState(s => !!s.suppressEveryone[scopeId]);
  const roles = useLocalState(s => !!s.suppressRoles[scopeId]);
  const options = (Object.keys(NOTIFY_LABELS) as Exclude<NotifyLevel, "default">[]).map(value => ({ value, label: NOTIFY_LABELS[value] }));
  return (
    <Modal open onClose={closeModal} title="Notification Settings" className="modal-compact">
      <p className="modal-subtle">{title}</p>
      <div className="field-label">Server notification settings</div>
      <RadioGroup<NotifyLevel> name="Notification level" value={level === "default" && guild ? "all" : level} options={guild ? options : [{ value: "default", label: "Use Server Default" }, ...options]} onChange={next => setNotifyLevel(scopeId, next)} />
      <SwitchRow label="Suppress @everyone and @here" checked={everyone} onChange={() => toggleFlag("suppressEveryone", scopeId)} />
      <SwitchRow label="Suppress All Role @mentions" checked={roles} onChange={() => toggleFlag("suppressRoles", scopeId)} />
      <p className="modal-subtle">These choices are saved on this device.</p>
    </Modal>
  );
}

function CreateDM({ base = [] }: { base?: string[] }) {
  const friends = useStore(s => Object.values(s.relationships).filter(r => r.type === RelationshipType.Friend && !base.includes(r.id)));
  const [selected, setSelected] = useState<string[]>([]);
  const room = 9 - base.length;
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const shown = friends.filter(r => !query || displayName(r.user).toLowerCase().includes(query.toLowerCase()) || r.user.username.includes(query.toLowerCase()));
  const toggle = (id: string) => setSelected(list => (list.includes(id) ? list.filter(x => x !== id) : list.length < room ? [...list, id] : list));
  return (
    <Modal
      open
      onClose={closeModal}
      title={base.length > 0 ? "Add Friends to DM" : "Select Friends"}
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={closeModal}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || selected.length === 0}
            onClick={() => {
              setBusy(true);
              createGroupDM([...base, ...selected])
                .then(closeModal)
                .catch(() => setBusy(false));
            }}
          >
            {selected.length + base.length > 1 ? "Create Group DM" : "Create DM"}
          </button>
        </>
      }
    >
      <p className="modal-subtle">You can add {Math.max(0, room - selected.length)} more friends.</p>
      <input className="input" placeholder="Type the username of a friend" value={query} autoFocus onChange={e => setQuery(e.target.value)} />
      <ul className="pick-list">
        {shown.map(r => (
          <li key={r.id}>
            <button type="button" className="pick-row" onClick={() => toggle(r.id)} aria-pressed={selected.includes(r.id)}>
              <Avatar user={r.user} size={32} status />
              <span className="pick-name">{displayName(r.user)}</span>
              <span className="pick-handle">{r.user.username}</span>
              <span className={`checkbox${selected.includes(r.id) ? " checked" : ""}`}>{selected.includes(r.id) && <Check size={14} />}</span>
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="pick-empty">No friends found.</li>}
      </ul>
    </Modal>
  );
}

/** Renders the open modal, with a settings screen kept mounted underneath when a small dialog was opened from it. */
export function ModalHost() {
  const modal = useModals(s => s.modal);
  const serial = useModals(s => s.serial);
  const base = useModals(s => s.base);
  const guilds = useStore(s => s.guilds);
  const channels = useStore(s => s.channels);
  // A parked settings screen whose guild/channel was deleted from the dialog on top has nothing left to show.
  const gone = (spec: ModalSpec) =>
    (spec.type === "serverSettings" && !guilds[spec.guildId]) || ((spec.type === "channelSettings" || spec.type === "editChannel") && !channels[spec.channelId]);
  const goneModal = !!modal && gone(modal);
  useEffect(() => {
    if (goneModal) closeModal();
  }, [goneModal]);
  if (!modal || goneModal) return null;
  return (
    <>
      {base && !gone(base.spec) && <ModalView spec={base.spec} id={`${base.spec.type}-${base.serial}`} />}
      <ModalView spec={modal} id={`${modal.type}-${serial}`} />
    </>
  );
}

function ModalView({ spec, id }: { spec: ModalSpec; id: string }) {
  const guilds = useStore(s => s.guilds);
  const channels = useStore(s => s.channels);
  switch (spec.type) {
    case "createServer":
      return <CreateServer key={id} />;
    case "invite":
      return <InviteModal key={id} channelId={spec.channelId} />;
    case "createChannel":
      return <CreateChannelModal key={id} guildId={spec.guildId} parentId={spec.parentId} channelType={spec.channelType} />;
    case "leaveServer":
      return <Confirm key={id} title={`Leave '${guilds[spec.guildId]?.name ?? "server"}'`} body={`Are you sure you want to leave ${guilds[spec.guildId]?.name ?? "this server"}? You won't be able to rejoin this server unless you are re-invited.`} action="Leave Server" danger onConfirm={() => leaveGuild(spec.guildId)} />;
    case "deleteServer":
      return <Confirm key={id} title={`Delete '${guilds[spec.guildId]?.name ?? "server"}'`} body={`Are you sure you want to delete ${guilds[spec.guildId]?.name ?? "this server"}? This action cannot be undone.`} action="Delete Server" danger requireText={guilds[spec.guildId]?.name ?? ""} onConfirm={() => deleteGuild(spec.guildId)} />;
    case "deleteChannel":
      return (
        <Confirm
          key={id}
          title="Delete Channel"
          body={`Are you sure you want to delete #${channels[spec.channelId]?.name ?? "channel"}? This cannot be undone.`}
          action="Delete Channel"
          danger
          onConfirm={async () => {
            await request<void>("DELETE", `/channels/${spec.channelId}`);
            appStore.getState().removeChannel(spec.channelId);
          }}
        />
      );
    case "createDM":
      return <CreateDM key={id} base={spec.base} />;
    case "quickSwitcher":
      return <QuickSwitcher key={id} />;
    case "profile":
      return <FullProfileModal key={id} userId={spec.userId} guildId={spec.guildId} />;
    case "serverSettings":
      return <ServerSettings key={id} guildId={spec.guildId} section={spec.section} />;
    case "editChannel":
      return <ChannelSettings key={id} channelId={spec.channelId} />;
    case "channelSettings":
      return <ChannelSettings key={id} channelId={spec.channelId} section={spec.section} />;
    case "kickMember":
      return <KickModal key={id} guildId={spec.guildId} userId={spec.userId} />;
    case "banMember":
      return <BanModal key={id} guildId={spec.guildId} userId={spec.userId} />;
    case "timeoutMember":
      return <TimeoutModal key={id} guildId={spec.guildId} userId={spec.userId} />;
    case "nickname":
      return <NicknameModal key={id} guildId={spec.guildId} userId={spec.userId} />;
    case "notificationSettings":
      return <NotificationSettingsModal key={id} scopeId={spec.scopeId} title={spec.title} guild={spec.guild} />;
    case "userSettings":
      return <UserSettings key={id} section={spec.section} />;
  }
}
