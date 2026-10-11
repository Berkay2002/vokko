import { useMemo, useState } from "react";
import { Check, Info, Megaphone } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { Perm, basePermissions, channelPermissions, hasBit } from "../api/permissions";
import { followChannel } from "../api/rest";
import { useStore } from "../api/store";
import { ChannelType, type Channel, type Guild } from "../api/types";
import { Modal } from "../ui";
import { Select } from "../shell/settings/controls";
import { useThreadUi } from "./threadUi";
import "./threads.css";

interface Target {
  guild: Guild;
  channels: Channel[];
}

/**
 * Follow dialog of an announcement channel: pick a server where you have Manage Webhooks and one of its text or announcement channels;
 * new announcements are published there. (Vokko has no webhooks: the permission bit gates the feature.)
 */
export function FollowModal({ channelId, onClose }: { channelId: string; onClose(): void }) {
  const source = useStore(s => s.channels[channelId]);
  const meId = useStore(s => s.me?.id);
  const guilds = useStore(s => s.guilds);
  const guildOrder = useStore(s => s.guildOrder);
  const allChannels = useStore(s => s.channels);
  const members = useStore(s => s.members);

  const targets = useMemo<Target[]>(() => {
    if (!meId) return [];
    const out: Target[] = [];
    for (const guildId of guildOrder) {
      const guild = guilds[guildId];
      const roles = members[guildId]?.[meId]?.roles ?? [];
      if (!guild || !hasBit(basePermissions(guild, { id: meId, roles }), Perm.MANAGE_WEBHOOKS)) continue;
      const channels = Object.values(allChannels)
        .filter(c => c.guild_id === guildId && c.id !== channelId && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement))
        .filter(c => hasBit(channelPermissions(guild, { id: meId, roles }, c), Perm.MANAGE_WEBHOOKS | Perm.VIEW_CHANNEL))
        .sort((a, b) => a.position - b.position);
      if (channels.length > 0) out.push({ guild, channels });
    }
    return out;
  }, [meId, guildOrder, guilds, allChannels, members, channelId]);

  const [guildId, setGuildId] = useState<string>(() => targets.find(t => t.guild.id === source?.guild_id)?.guild.id ?? targets[0]?.guild.id ?? "");
  const target = targets.find(t => t.guild.id === guildId) ?? targets[0];
  const [targetId, setTargetId] = useState<string>("");
  const picked = target?.channels.find(c => c.id === targetId) ?? target?.channels[0];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Channel | null>(null);

  async function follow() {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    try {
      await followChannel(channelId, { webhook_channel_id: picked.id });
      setDone(picked);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not follow this channel. Try again.");
    }
    setBusy(false);
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Follow Announcement Channel"
      className="modal-compact"
      footer={
        done ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={busy || !picked} onClick={() => void follow()}>
              Follow
            </button>
          </>
        )
      }
    >
      <p className="modal-subtle thread-modal-parent">
        <Megaphone size={14} aria-hidden="true" /> {source?.name}
      </p>
      {done ? (
        <p className="follow-done" role="status">
          <Check size={18} aria-hidden="true" /> New announcements from <b>#{source?.name}</b> will be published in <b>#{done.name}</b>.
        </p>
      ) : targets.length === 0 ? (
        <p className="settings-unavailable">You need the Manage Webhooks permission in a server with a text channel to follow announcements into it.</p>
      ) : (
        <>
          <p>Get this channel&apos;s announcements in your own server. They are posted as messages in the channel you choose.</p>
          <div className="field-label thread-modal-label">Server</div>
          <Select<string>
            label="Server"
            value={target?.guild.id ?? ""}
            options={targets.map(t => ({ value: t.guild.id, label: t.guild.name }))}
            onChange={id => {
              setGuildId(id);
              setTargetId("");
            }}
          />
          <div className="field-label thread-modal-label">Channel</div>
          <Select<string> label="Channel" value={picked?.id ?? ""} options={(target?.channels ?? []).map(c => ({ value: c.id, label: `# ${c.name ?? ""}` }))} onChange={setTargetId} />
          <p className="modal-subtle thread-modal-hint">
            <Info size={14} aria-hidden="true" /> Attachments are not forwarded.
          </p>
        </>
      )}
      {error && <p className="field-error">{error}</p>}
    </Modal>
  );
}

/** Mounted once by the shell next to the create-thread dialog. */
export function FollowDialog() {
  const channelId = useThreadUi(s => s.follow);
  return channelId ? <FollowModal key={channelId} channelId={channelId} onClose={() => useThreadUi.setState({ follow: null })} /> : null;
}
