import { useEffect, useRef, useState } from "react";
import { MessageCircle, MoreHorizontal, UserCheck, UserPlus } from "lucide-react";
import { formatPlaytime, listeningActivity, playingActivity } from "../activity/format";
import { getMutualFriends, request } from "../api/rest";
import { snowflakeToTimestamp } from "../api/snowflake";
import { displayName, useStore } from "../api/store";
import { RelationshipType, type Snowflake, type User, type UserProfile } from "../api/types";
import { ProfileBanner } from "../perks/ProfileBanner";
import { ProfileCardLayers } from "../perks/ProfileEffect";
import { resolveProfile, themeVars } from "../perks/profile";
import { TagChip } from "../perks/TagChip";
import { StyledName } from "../perks/NameStyles";
import { ProfileBio } from "../perks/ProfileBio";
import { Modal, useContextMenu, type MenuItem } from "../ui";
import { Avatar, GuildIcon } from "./Avatar";
import { openDirectMessage } from "./actions";
import { userContextItems } from "./menus";
import { closeModal, openModal } from "./modalStore";
import { go, guildPath } from "./nav";
import { ActivityIcon } from "./ActivityIcon";
import { SpotifyCard } from "./SpotifyCard";

const dateText = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** Profile data for a user: the server's UserProfile when available, otherwise derived from guilds we both belong to. */
export function useProfileData(userId: Snowflake, guildId?: Snowflake | null) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  useEffect(() => {
    let live = true;
    setProfile(null);
    request<UserProfile>("GET", `/users/${userId}/profile${guildId ? `?guild_id=${guildId}` : ""}`)
      .then(p => live && setProfile(p))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [userId, guildId]);
  const localMutual = useStore(s => s.guildOrder.filter(id => !!s.members[id]?.[userId]));
  const guilds = useStore(s => s.guilds);
  const mutual = (profile?.mutual_guilds.map(g => g.id) ?? localMutual).map(id => guilds[id]).filter(g => !!g);
  return { profile, mutual, memberSince: dateText(snowflakeToTimestamp(userId)) };
}

/** Right-hand profile panel of a 1:1 DM (toggle in the channel header). */
export function DmProfilePanel({ user }: { user: User }) {
  const { mutual, memberSince } = useProfileData(user.id);
  const count = mutual.length;
  const look = resolveProfile(user);
  const tagGuildName = useStore(s => (user.primary_guild ? s.guilds[user.primary_guild.guild_id]?.name : undefined));
  const listening = useStore(s => listeningActivity(s.presences[user.id]));
  return (
    <aside className="dm-profile" aria-label="User Profile">
      <div className={`dm-profile-card${look.themeColors ? " pv-themed" : ""}`} style={themeVars(look.themeColors)}>
        <ProfileBanner look={look} className="dm-profile-banner" />
        <ProfileCardLayers look={look} />
        <div className="dm-profile-avatar">
          <Avatar user={user} size={80} status />
        </div>
        <div className="dm-profile-body">
          <div className="dm-profile-name"><StyledName styles={user.display_name_styles}>{displayName(user)}</StyledName></div>
          <div className="pv-name-row">
            <span className="dm-profile-username">{user.username}</span>
            <TagChip tag={user.primary_guild} guildName={tagGuildName} />
          </div>
          {look.pronouns && <div className="pv-pronouns">{look.pronouns}</div>}
          {look.bio && <ProfileBio text={look.bio} className="dm-profile-bio" />}
          {listening && <SpotifyCard activity={listening} />}
          <div className="dm-profile-mutual">
            {count} Mutual Server{count === 1 ? "" : "s"}
          </div>
          <div className="dm-profile-divider" />
          <div className="dm-profile-label">Member Since</div>
          <div className="dm-profile-value">{memberSince}</div>
        </div>
        <div className="dm-profile-footer">
          <button type="button" className="btn btn-secondary btn-wide" onClick={() => openModal({ type: "profile", userId: user.id })}>
            View Full Profile
          </button>
        </div>
      </div>
    </aside>
  );
}

/** The user menu without its profile-popout, mention and message rows (the modal is the profile; Message is its own button). */
function profileMenuItems(items: MenuItem[]): MenuItem[] {
  const drop = new Set(["profile", "mention", "message", "call"]);
  const kept = items.filter(i => "type" in i || !drop.has(i.id));
  return kept.filter((item, n) => !("type" in item && (n === 0 || "type" in (kept[n - 1] ?? {}))));
}

/** Full profile modal: the profile card on the left; Activity, Mutual Friends and Mutual Servers on the right. */
export function FullProfileModal({ userId, guildId }: { userId: Snowflake; guildId?: Snowflake | null }) {
  const user = useStore(s => s.users[userId]);
  const member = useStore(s => (guildId ? s.members[guildId]?.[userId] : undefined));
  const isMe = useStore(s => s.me?.id === userId);
  const relation = useStore(s => s.relationships[userId]?.type);
  const presence = useStore(s => s.presences[userId]);
  const [tab, setTab] = useState<"activity" | "friends" | "servers">("activity");
  const { profile, mutual, memberSince } = useProfileData(userId, guildId);
  const [friends, setFriends] = useState<User[] | null>(null);
  const [friendsError, setFriendsError] = useState(false);
  const menu = useContextMenu();
  const moreButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (tab !== "friends" || friends) return;
    let live = true;
    setFriendsError(false);
    getMutualFriends(userId)
      .then(list => live && setFriends(list))
      .catch(() => live && setFriendsError(true));
    return () => {
      live = false;
    };
  }, [tab, userId, friends]);
  const tagGuildName = useStore(s => (user?.primary_guild ? s.guilds[user.primary_guild.guild_id]?.name : undefined));
  if (!user) return null;
  const look = resolveProfile(user, member);
  const name = displayName(user, member);
  const activity = playingActivity(presence);
  const listening = listeningActivity(presence);
  const friendCount = friends?.length ?? profile?.mutual_friends_count ?? 0;
  const tabs = [
    { id: "activity" as const, label: "Activity" },
    { id: "friends" as const, label: `${friendCount} Mutual Friend${friendCount === 1 ? "" : "s"}` },
    { id: "servers" as const, label: `${mutual.length} Mutual Server${mutual.length === 1 ? "" : "s"}` },
  ];

  const friendAction = (() => {
    if (relation === RelationshipType.Friend) return { label: "Remove Friend", Icon: UserCheck, run: () => openModal({ type: "removeFriend", userId }) };
    if (relation === RelationshipType.OutgoingRequest) return { label: "Friend Request Sent", Icon: UserCheck, run: undefined };
    if (relation === RelationshipType.Blocked) return null;
    const label = relation === RelationshipType.IncomingRequest ? "Accept Friend Request" : "Add Friend";
    return { label, Icon: UserPlus, run: () => void request("PUT", `/users/@me/relationships/${userId}`, {}) };
  })();

  const openMore = () => {
    const rect = moreButton.current?.getBoundingClientRect();
    if (rect) menu.open({ clientX: rect.left, clientY: rect.bottom + 4 }, profileMenuItems(userContextItems(user, { guildId })));
  };

  return (
    <Modal open onClose={closeModal} title={name} className="modal-profile">
      <div className="full-profile">
        <div className={`full-profile-card${look.themeColors ? " pv-themed" : ""}`} style={themeVars(look.themeColors)}>
          <ProfileBanner look={look} className="full-profile-banner" />
          <ProfileCardLayers look={look} />
          <div className="full-profile-avatar">
            <Avatar user={user} member={member} size={120} status />
          </div>
          <div className="full-profile-body">
            <div className="full-profile-name"><StyledName styles={user.display_name_styles}>{name}</StyledName></div>
            <div className="pv-name-row">
              <span className="dm-profile-username">{user.username}</span>
              <TagChip tag={user.primary_guild} guildName={tagGuildName} />
            </div>
            {look.pronouns && <div className="pv-pronouns">{look.pronouns}</div>}
            <div className="full-profile-actions">
              {!isMe && (
                <button type="button" className="btn btn-primary full-profile-message" onClick={() => { closeModal(); void openDirectMessage(userId); }}>
                  <MessageCircle size={16} /> Message
                </button>
              )}
              {!isMe && friendAction && (
                <button type="button" className="btn btn-secondary full-profile-icon" aria-label={friendAction.label} title={friendAction.label} disabled={!friendAction.run} onClick={friendAction.run}>
                  <friendAction.Icon size={16} />
                </button>
              )}
              <button ref={moreButton} type="button" className="btn btn-secondary full-profile-icon" aria-label="More" aria-haspopup="menu" onClick={openMore}>
                <MoreHorizontal size={16} />
              </button>
            </div>
            {look.bio && (
              <section className="full-profile-section">
                <h3>About Me</h3>
                <ProfileBio text={look.bio} className="dm-profile-bio" />
              </section>
            )}
            <section className="full-profile-section">
              <h3>Member Since</h3>
              <p>{memberSince}</p>
            </section>
            {member && (
              <section className="full-profile-section">
                <h3>Joined this server</h3>
                <p>{dateText(Date.parse(member.joined_at))}</p>
              </section>
            )}
          </div>
        </div>
        <div className="full-profile-main">
          <div className="full-profile-tabs" role="tablist">
            {tabs.map(t => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`full-profile-tab${tab === t.id ? " selected" : ""}`} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <ul className="full-profile-list">
            {tab === "activity" && !activity && !listening && <li className="settings-todo">No activity to show.</li>}
            {tab === "activity" && activity && (
              <li className="full-profile-row">
                <span className="full-profile-tile"><ActivityIcon activity={activity} size={28} fill /></span>
                <span className="full-profile-row-text">
                  <span className="full-profile-row-title">{activity.name}</span>
                  <span className="full-profile-row-sub">Playing{activity.timestamps?.start ? ` · ${formatPlaytime(activity.timestamps.start, Date.now())}` : ""}</span>
                </span>
              </li>
            )}
            {tab === "activity" && listening && (
              <li>
                <SpotifyCard activity={listening} />
              </li>
            )}
            {tab === "servers" && mutual.length === 0 && <li className="settings-todo">No mutual servers.</li>}
            {tab === "servers" &&
              mutual.map(g => (
                <li key={g.id}>
                  <button type="button" className="full-profile-row" onClick={() => { closeModal(); go(guildPath(g.id)); }}>
                    <GuildIcon guild={g} size={48} />
                    <span className="full-profile-row-title">{g.name}</span>
                  </button>
                </li>
              ))}
            {tab === "friends" && friendsError && <li className="settings-todo">Could not load mutual friends.</li>}
            {tab === "friends" && !friendsError && !friends && <li className="settings-todo">Loading…</li>}
            {tab === "friends" && friends?.length === 0 && <li className="settings-todo">No mutual friends.</li>}
            {tab === "friends" &&
              friends?.map(f => (
                <li key={f.id} className="full-profile-row">
                  <Avatar user={f} size={48} />
                  <span className="full-profile-row-text">
                    <span className="full-profile-row-title">{displayName(f)}</span>
                    <span className="full-profile-row-sub">{f.username}</span>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      </div>
    </Modal>
  );
}
