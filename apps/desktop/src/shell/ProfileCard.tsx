import { Clock, MessageCircle, UserCheck, UserPlus } from "lucide-react";
import { appStore, displayName, roleColor, useStore } from "../api/store";
import { request } from "../api/rest";
import { RelationshipType, type Snowflake } from "../api/types";
import { ProfileBanner } from "../perks/ProfileBanner";
import { ProfileCardLayers } from "../perks/ProfileEffect";
import { resolveProfile, themeVars } from "../perks/profile";
import { TagChip } from "../perks/TagChip";
import { StyledName } from "../perks/NameStyles";
import { ProfileBio } from "../perks/ProfileBio";
import { useCustomColor } from "../ui/useCustomColor";
import { Popout, Tooltip } from "../ui";
import { snowflakeToTimestamp } from "../api/snowflake";
import logo from "../../../../assets/brand/vokko-icon.svg";
import { InVoiceCard } from "../voice";
import { listeningActivity } from "../activity/format";
import { ActivityCard, usePlaying } from "./ActivityLine";
import { SpotifyCard } from "./SpotifyCard";
import { Avatar, GuildIcon } from "./Avatar";
import { openDirectMessage } from "./actions";
import { openModal } from "./modalStore";
import { useProfile } from "./profileStore";

export { openProfile } from "./profileStore";

const sinceText = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

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
  const listening = listeningActivity(presence);
  const isMe = useStore(s => s.me?.id === userId);
  const relationship = useStore(s => (userId ? s.relationships[userId] : undefined));
  const open = !!anchor && !!user;
  const roles = member && guild ? guild.roles.filter(r => member.roles.includes(r.id) && r.id !== guild.id).sort((a, b) => b.position - a.position) : [];
  const color = useCustomColor(guildId ? roleColor(guildId, member) : null);
  const look = user ? resolveProfile(user, member) : null;
  const tagGuildName = useStore(s => (user?.primary_guild ? s.guilds[user.primary_guild.guild_id]?.name : undefined));

  // Opened from a mention inside a dialog (the topic dialog): sits above the modal layer and takes the keyboard from its focus trap.
  const aboveModal = !!anchor?.closest(".modal-layer");

  return (
    <Popout anchor={anchor} open={open} onClose={close} side="right" align="start" gap={8} className={`profile-card${aboveModal ? " above-modal" : ""}${look?.themeColors ? " pv-themed" : ""}`} style={themeVars(look?.themeColors)}
      sheet="Profile" role={aboveModal ? "dialog" : undefined} label={aboveModal && user ? displayName(user, member) : undefined}>
      {user && look && (
        <>
          <ProfileBanner look={look} className="profile-banner" />
          <ProfileCardLayers look={look} />
          <div className="profile-avatar">
            <Avatar user={user} member={member} size={80} status />
          </div>
          <div className="profile-body">
            <div className="profile-names">
              <div className="profile-name" style={color ? { color } : undefined}>
                <StyledName styles={user.display_name_styles}>{displayName(user, member)}</StyledName>
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
            {listening && <SpotifyCard activity={listening} />}
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
                <ProfileBio text={look.bio} />
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
            {/* Discord: the app logo with the account's age, then the server icon with the join date; each icon names its source on hover */}
            <section className="profile-section">
              <h3>Member Since</h3>
              <p className="profile-since">
                <Tooltip content="Vokko" side="top">
                  <img className="profile-since-icon" src={logo} alt="Vokko" width={16} height={16} tabIndex={0} />
                </Tooltip>
                {sinceText(snowflakeToTimestamp(user.id))}
                {member && guild && (
                  <>
                    <span className="profile-since-dot" aria-hidden="true" />
                    <Tooltip content={guild.name} side="top">
                      <span className="profile-since-icon" role="img" aria-label={guild.name} tabIndex={0}>
                        <GuildIcon guild={guild} size={16} />
                      </span>
                    </Tooltip>
                    {sinceText(Date.parse(member.joined_at))}
                  </>
                )}
              </p>
            </section>
          </div>
        </>
      )}
    </Popout>
  );
}
