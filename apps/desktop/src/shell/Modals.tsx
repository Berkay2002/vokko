import { useEffect, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy, Hash, Plus, Users, Volume2 } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { request } from "../api/rest";
import { appStore, displayName, useStore } from "../api/store";
import { ChannelType, RelationshipType } from "../api/types";
import { Modal } from "../ui";
import { Avatar } from "./Avatar";
import { createChannel, createGroupDM, createGuild, createInvite, deleteGuild, joinGuildWithInvite, leaveGuild, type Invite } from "./actions";
import { closeModal, useModals } from "./modalStore";
import { QuickSwitcher } from "./QuickSwitcher";
import { UserSettings } from "./UserSettings";

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    const field = error.api.errors && Object.values(error.api.errors)[0];
    const detail = field && typeof field === "object" && "message" in field ? String((field as { message: unknown }).message) : null;
    return detail ?? error.message;
  }
  return "Something went wrong. Try again.";
}

function Confirm({ title, body, action, danger, onConfirm }: { title: string; body: ReactNode; action: string; danger?: boolean; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

function CreateServer() {
  const [step, setStep] = useState<"choose" | "create" | "join">("choose");
  const me = useStore(s => s.me);
  const [name, setName] = useState(me ? `${me.global_name ?? me.username}'s server` : "");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  if (step === "choose")
    return (
      <Modal open onClose={closeModal} title="Create a server" className="modal-create-server">
        <p className="modal-text center">Your server is where you and your friends hang out. Make yours and start talking.</p>
        <button type="button" className="choice-row" onClick={() => setStep("create")}>
          <span className="choice-icon">
            <Plus size={20} />
          </span>
          <span>Create My Own</span>
          <ChevronRight size={20} />
        </button>
        <div className="modal-subheading">Have an invite already?</div>
        <button type="button" className="btn btn-secondary btn-wide" onClick={() => setStep("join")}>
          Join a Server
        </button>
      </Modal>
    );

  if (step === "create")
    return (
      <Modal
        open
        onClose={closeModal}
        title="Customize your server"
        footer={
          <>
            <button type="button" className="btn btn-link" onClick={() => setStep("choose")}>
              Back
            </button>
            <button type="button" className="btn btn-primary" disabled={busy || name.trim().length < 2} onClick={() => run(() => createGuild(name.trim()))}>
              Create
            </button>
          </>
        }
      >
        <p className="modal-text center">Give your new server a personality with a name. You can always change it later.</p>
        <label className="field-label" htmlFor="server-name">
          Server name
        </label>
        <input id="server-name" className="input" value={name} maxLength={100} autoFocus onChange={e => setName(e.target.value)} onKeyDown={e => e.key === "Enter" && name.trim().length >= 2 && run(() => createGuild(name.trim()))} />
        {error && <p className="field-error">{error}</p>}
      </Modal>
    );

  return (
    <Modal
      open
      onClose={closeModal}
      title="Join a server"
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={() => setStep("choose")}>
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
  const category = type === ChannelType.GuildCategory;
  const parent = useStore(s => (parentId ? s.channels[parentId] : undefined));
  const slug = category ? name : name.toLowerCase().replace(/\s+/g, "-");
  const submit = () => {
    if (!slug.trim()) return;
    setBusy(true);
    createChannel(guildId, { name: slug.trim(), type, parent_id: category ? null : (parentId ?? null) })
      .then(closeModal)
      .catch(e => {
        setError(errorText(e));
        setBusy(false);
      });
  };
  const option = (value: ChannelType, icon: ReactNode, label: string, description: string) => (
    <button key={value} type="button" role="radio" aria-checked={type === value} className={`radio-row${type === value ? " selected" : ""}`} onClick={() => setType(value)}>
      <span className="radio-icon">{icon}</span>
      <span className="radio-text">
        <span className="radio-label">{label}</span>
        <span className="radio-desc">{description}</span>
      </span>
      <span className="radio-dot" />
    </button>
  );
  return (
    <Modal
      open
      onClose={closeModal}
      title={category ? "Create Category" : "Create Channel"}
      footer={
        <>
          <button type="button" className="btn btn-link" onClick={closeModal}>
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
            {option(ChannelType.GuildText, <Hash size={24} />, "Text", "Send messages, images, GIFs, emoji, opinions, and puns")}
            {option(ChannelType.GuildVoice, <Volume2 size={24} />, "Voice", "Hang out together with voice, video, and screen share")}
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
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

function CreateDM() {
  const friends = useStore(s => Object.values(s.relationships).filter(r => r.type === RelationshipType.Friend));
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const shown = friends.filter(r => !query || displayName(r.user).toLowerCase().includes(query.toLowerCase()) || r.user.username.includes(query.toLowerCase()));
  const toggle = (id: string) => setSelected(list => (list.includes(id) ? list.filter(x => x !== id) : list.length < 9 ? [...list, id] : list));
  return (
    <Modal
      open
      onClose={closeModal}
      title="Select Friends"
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
              createGroupDM(selected)
                .then(closeModal)
                .catch(() => setBusy(false));
            }}
          >
            {selected.length > 1 ? "Create Group DM" : "Create DM"}
          </button>
        </>
      }
    >
      <p className="modal-subtle">You can add {Math.max(0, 9 - selected.length)} more friends.</p>
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

function ServerSettings({ guildId }: { guildId: string }) {
  const guild = useStore(s => s.guilds[guildId]);
  const members = useStore(s => Object.keys(s.members[guildId] ?? {}).length);
  const isOwner = useStore(s => s.me?.id === guild?.owner_id);
  return (
    <Modal open onClose={closeModal} title="Server Settings" className="modal-wide">
      <div className="settings-readonly">
        <div className="settings-row">
          <span className="settings-key">Server name</span>
          <span>{guild?.name}</span>
        </div>
        <div className="settings-row">
          <span className="settings-key">Server ID</span>
          <span>{guildId}</span>
        </div>
        <div className="settings-row">
          <span className="settings-key">Members</span>
          <span className="inline">
            <Users size={14} /> {members}
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-key">Your role</span>
          <span>{isOwner ? "Owner" : "Member"}</span>
        </div>
        <p className="modal-subtle">Editing server settings is not implemented yet.</p>
      </div>
    </Modal>
  );
}

/** Renders whichever modal is open (one at a time). */
export function ModalHost() {
  const modal = useModals(s => s.modal);
  const guilds = useStore(s => s.guilds);
  const channels = useStore(s => s.channels);
  const serial = useModals(s => s.serial);
  const spec = modal;
  if (!spec) return null;
  const id = `${spec.type}-${serial}`;
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
      return <Confirm key={id} title={`Delete '${guilds[spec.guildId]?.name ?? "server"}'`} body={`Are you sure you want to delete ${guilds[spec.guildId]?.name ?? "this server"}? This action cannot be undone.`} action="Delete Server" danger onConfirm={() => deleteGuild(spec.guildId)} />;
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
      return <CreateDM key={id} />;
    case "quickSwitcher":
      return <QuickSwitcher key={id} />;
    case "serverSettings":
      return <ServerSettings key={id} guildId={spec.guildId} />;
    case "userSettings":
      return <UserSettings key={id} section={spec.section} />;
  }
}
