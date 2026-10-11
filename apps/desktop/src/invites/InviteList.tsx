// The invites table of Server Settings > Invites (all of a server's invites) and of Channel Settings > Invites (one channel's):
// inviter, code, uses, time left, revoke. Kept current by INVITE_CREATE / INVITE_DELETE.

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { gateway } from "../api/gateway";
import { displayName, useStore } from "../api/store";
import type { InviteMetadata, Snowflake } from "../api/types";
import { Avatar } from "../shell/Avatar";
import { listChannelInvites, listGuildInvites, revokeInvite, timeLeft } from "./api";
import "./invites.css";

function errorText(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
}

/** `channelId` lists one channel's invites (MANAGE_CHANNELS), otherwise the whole server's (MANAGE_GUILD). */
export function InviteList({ guildId, channelId, canManage }: { guildId: Snowflake; channelId?: Snowflake; canManage: boolean }) {
  const channels = useStore(s => s.channels);
  const [invites, setInvites] = useState<InviteMetadata[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canManage) return;
    try {
      setInvites(await (channelId ? listChannelInvites(channelId) : listGuildInvites(guildId)));
      setError(null);
    } catch (e) {
      setError(errorText(e));
      setInvites(current => current ?? []);
    }
  }, [canManage, channelId, guildId]);

  useEffect(() => {
    void load();
    const relevant = (d: { guild_id: Snowflake; channel_id: Snowflake }) => d.guild_id === guildId && (!channelId || d.channel_id === channelId);
    const offCreate = gateway.on("INVITE_CREATE", invite => {
      if (relevant({ guild_id: invite.guild.id, channel_id: invite.channel.id })) setInvites(current => (current && !current.some(i => i.code === invite.code) ? [...current, invite] : current));
    });
    const offDelete = gateway.on("INVITE_DELETE", deleted => {
      if (relevant(deleted)) setInvites(current => current?.filter(i => i.code !== deleted.code) ?? current);
    });
    return () => {
      offCreate();
      offDelete();
    };
  }, [load, guildId, channelId]);

  const revoke = async (code: string) => {
    setRevoking(code);
    setError(null);
    try {
      await revokeInvite(code);
      setInvites(current => current?.filter(i => i.code !== code) ?? current);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRevoking(null);
    }
  };

  if (!canManage) return <p className="settings-todo">You need the {channelId ? "Manage Channel" : "Manage Server"} permission to see invite links.</p>;
  const live = (invites ?? []).filter(i => !i.expires_at || Date.parse(i.expires_at) > Date.now());

  return (
    <>
      {error && <p className="field-error">{error}</p>}
      {invites === null ? (
        <p className="settings-todo">Loading…</p>
      ) : live.length === 0 ? (
        <p className="settings-todo">No active invite links.</p>
      ) : (
        <table className="ss-table invite-table" aria-label="Active invite links">
          <thead>
            <tr>
              <th scope="col">Inviter</th>
              <th scope="col">Invite Code</th>
              {!channelId && <th scope="col">Channel</th>}
              <th scope="col">Uses</th>
              <th scope="col">Expires</th>
              <th scope="col">
                <span className="sr-only">Revoke</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {live.map(invite => (
              <tr key={invite.code} data-code={invite.code}>
                <td>
                  {invite.inviter ? (
                    <span className="ss-member-name">
                      <Avatar user={invite.inviter} size={24} />
                      <span>{displayName(invite.inviter)}</span>
                    </span>
                  ) : (
                    <span className="invite-muted">Deleted user</span>
                  )}
                </td>
                <td>
                  <code className="ss-id">{invite.code}</code>
                  {invite.temporary && <span className="invite-tag">Temporary</span>}
                </td>
                {!channelId && <td>#{channels[invite.channel.id]?.name ?? invite.channel.name}</td>}
                <td>{invite.max_uses > 0 ? `${invite.uses}/${invite.max_uses}` : invite.uses}</td>
                <td>{timeLeft(invite.expires_at)}</td>
                <td className="invite-revoke-cell">
                  <button type="button" className="invite-revoke" aria-label={`Revoke invite ${invite.code}`} title="Revoke invite" disabled={revoking === invite.code} onClick={() => void revoke(invite.code)}>
                    <X size={16} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
