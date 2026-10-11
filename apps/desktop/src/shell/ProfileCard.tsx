import { create } from "zustand";
import { Clock, MessageCircle, UserCheck, UserPlus } from "lucide-react";
import { appStore, displayName, roleColor, useStore } from "../api/store";
import { request } from "../api/rest";
import { RelationshipType, type Snowflake } from "../api/types";
import { ProfileBanner } from "../perks/ProfileBanner";
import { resolveProfile, themeVars } from "../perks/profile";
import { TagChip } from "../perks/TagChip";
import { useCustomColor } from "../ui/useCustomColor";
import { Popout } from "../ui";
import { InVoiceCard } from "../voice";
import { ActivityCard, usePlaying } from "./ActivityLine";
import { Avatar } from "./Avatar";
import { openDirectMessage } from "./actions";
import { openModal } from "./modalStore";

interface ProfileState {
  anchor: HTMLElement | null;
  userId: Snowflake | null;
  guildId: Snowflake | null;
  open(anchor: HTMLElement, userId: Snowflake, guildId: Snowflake | null): void;
  close(): void;
}

const useProfile = create<ProfileState>()(set => ({
  anchor: null,
  userId: null,
  guildId: null,
  open: (anchor, userId, guildId) => set({ anchor, userId, guildId }),
  close: () => set({ anchor: null, userId: null, guildId: null }),
}));

export const openProfile = (anchor: HTMLElement, userId: Snowflake, guildId: Snowflake | null) => useProfile.getState().open(anchor, userId, guildId);

/** Small clock next to a name while the member is timed out. */
export function TimeoutBadge({ until }: { until: string | null | undefined }) {
  const time = until ? Date.parse(until) : 0;
  if (!(time > Date.now())) return null;
  const label = `Timed out until ${new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
  return (
    <span className="timeout-icon" title={label} aria-label={label} role="img">
      <Clock size={14} />
    </span>
  );
}

/** User profile card popout (member list, message authors, DM rows). Mounted once in the shell. */
export function ProfileCardHost() {
  const { anchor, userId, guildId, close } = useProfile();
  const user = useStore(s => (userId ? s.users[userId] : undefined));
  const member = useStore(s => (userId && guildId ? s.members[guildId]?.[userId] : undefined));
  const guild = useStore(s => (guildId ? s.guilds[guildId] : undefined));
  const presence = useStore(s => (userId ? s.presences[userId] : undefined));
  const playing = usePlaying(userId);
  const isMe = useStore(s => s.me?.id === userId);
  const relationship = useStore(s => (userId ? s.relationships[userId] : undefined));
  const open = !!anchor && !!user;
  const roles = member && guild ? guild.roles.filter(r => member.roles.includes(r.id) && r.id !== guild.id).sort((a, b) => b.position - a.position) : [];
  const color = useCustomColor(guildId ? roleColor(guildId, member) : null);
  const look = user ? resolveProfile(user, member) : null;
  const tagGuildName = useStore(s => (user?.primary_guild ? s.guilds[user.primary_guild.guild_id]?.name : undefined));

  return (
    <Popout anchor={anchor} open={open} onClose={close} side="right" align="start" gap={8} className={`profile-card${look?.themeColors ? " pv-themed" : ""}`} style={themeVars(look?.themeColors)}>
      {user && look && (
        <>
          <ProfileBanner look={look} className="profile-banner" />
          <div className="profile-avatar">
            <Avatar user={user} member={member} size={80} status />
          </div>
          <div className="profile-body">
            <div className="profile-names">
              <div className="profile-name" style={color ? { color } : undefined}>
                {displayName(user, member)}
                <TimeoutBadge until={member?.communication_disabled_until} />
              </div>
              <div className="pv-name-row">
                <span className="profile-username">{user.username}</span>
                <TagChip tag={user.primary_guild} guildName={tagGuildName} />
              </div>
              {look.pronouns && <div className="pv-pronouns">{look.pronouns}</div>}
            </div>
            {presence?.custom_status && <div className="profile-status">{presence.custom_status}</div>}
            {playing && <ActivityCard activity={playing} />}
            <InVoiceCard userId={user.id} onOpen={close} />
            <div className="profile-actions">
              {isMe ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    close();
                    openModal({ type: "userSettings", section: "profiles" });
                  }}
                >
                  Edit Profile
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      close();
                      void openDirectMessage(user.id);
                    }}
                  >
                    <MessageCircle size={16} /> Message
                  </button>
                  {relationship?.type === RelationshipType.Friend ? (
                    <span className="profile-friend">
                      <UserCheck size={16} /> Friends
                    </span>
                  ) : relationship?.type === RelationshipType.OutgoingRequest ? (
                    <span className="profile-friend">Request sent</span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void request("PUT", `/users/@me/relationships/${user.id}`, {}).then(() => appStore.getState().cacheUsers([user])).catch(() => undefined)}
                    >
                      <UserPlus size={16} /> Add Friend
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="profile-divider" />
            {look.bio && (
              <section className="profile-section">
                <h3>About Me</h3>
                <p>{look.bio}</p>
              </section>
            )}
            {roles.length > 0 && (
              <section className="profile-section">
                <h3>Roles</h3>
                <ul className="profile-roles">
                  {roles.map(r => (
                    <li key={r.id} className="profile-role">
                      <span className="profile-role-dot" style={{ background: r.color ? `#${r.color.toString(16).padStart(6, "0")}` : "var(--text-muted)" }} />
                      {r.name}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {member && (
              <section className="profile-section">
                <h3>Member Since</h3>
                <p>{new Date(member.joined_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</p>
              </section>
            )}
          </div>
        </>
      )}
    </Popout>
  );
}
