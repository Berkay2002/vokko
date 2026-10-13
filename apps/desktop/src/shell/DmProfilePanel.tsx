import { useEffect, useState } from "react";
import { getMutualFriends, request } from "../api/rest";
import { snowflakeToTimestamp } from "../api/snowflake";
import { displayName, useStore } from "../api/store";
import type { Snowflake, User, UserProfile } from "../api/types";
import { ProfileBanner } from "../perks/ProfileBanner";
import { resolveProfile, themeVars } from "../perks/profile";
import { TagChip } from "../perks/TagChip";
import { StyledName } from "../perks/NameStyles";
import { ProfileBio } from "../perks/ProfileBio";
import { Modal } from "../ui";
import { Avatar, GuildIcon } from "./Avatar";
import { closeModal, openModal } from "./modalStore";

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
  return (
    <aside className="dm-profile" aria-label="User Profile">
      <div className={`dm-profile-card${look.themeColors ? " pv-themed" : ""}`} style={themeVars(look.themeColors)}>
        <ProfileBanner look={look} className="dm-profile-banner" />
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

/** Full profile modal: About, Mutual Servers, Mutual Friends. */
export function FullProfileModal({ userId, guildId }: { userId: Snowflake; guildId?: Snowflake | null }) {
  const user = useStore(s => s.users[userId]);
  const member = useStore(s => (guildId ? s.members[guildId]?.[userId] : undefined));
  const [tab, setTab] = useState<"about" | "servers" | "friends">("about");
  const { profile, mutual, memberSince } = useProfileData(userId, guildId);
  const [friends, setFriends] = useState<User[] | null>(null);
  const [friendsError, setFriendsError] = useState(false);
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
  const tabs = [
    { id: "about" as const, label: "About" },
    { id: "servers" as const, label: `Mutual Servers — ${mutual.length}` },
    { id: "friends" as const, label: `Mutual Friends — ${profile?.mutual_friends_count ?? 0}` },
  ];
  return (
    <Modal open onClose={closeModal} title={displayName(user, member)} className="modal-medium">
      <div className={`full-profile${look.themeColors ? " pv-themed" : ""}`} style={themeVars(look.themeColors)}>
        <ProfileBanner look={look} className="dm-profile-banner" />
        <div className="full-profile-head">
          <Avatar user={user} member={member} size={80} status />
          <div>
            <div className="dm-profile-name"><StyledName styles={user.display_name_styles}>{displayName(user, member)}</StyledName></div>
            <div className="pv-name-row">
              <span className="dm-profile-username">{user.username}</span>
              <TagChip tag={user.primary_guild} guildName={tagGuildName} />
            </div>
            {look.pronouns && <div className="pv-pronouns">{look.pronouns}</div>}
          </div>
        </div>
        <div className="full-profile-tabs" role="tablist">
          {tabs.map(t => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`full-profile-tab${tab === t.id ? " selected" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        {tab === "about" && (
          <div className="full-profile-body">
            {look.bio && (
              <section>
                <div className="dm-profile-label">About Me</div>
                <ProfileBio text={look.bio} className="dm-profile-bio" />
              </section>
            )}
            <section>
              <div className="dm-profile-label">Member Since</div>
              <div className="dm-profile-value">{memberSince}</div>
            </section>
            {member && (
              <section>
                <div className="dm-profile-label">Joined this server</div>
                <div className="dm-profile-value">{dateText(Date.parse(member.joined_at))}</div>
              </section>
            )}
          </div>
        )}
        {tab === "servers" && (
          <ul className="full-profile-list">
            {mutual.length === 0 && <li className="settings-todo">No mutual servers.</li>}
            {mutual.map(g => (
              <li key={g.id} className="full-profile-row">
                <GuildIcon guild={g} size={32} />
                <span>{g.name}</span>
              </li>
            ))}
          </ul>
        )}
        {tab === "friends" && (
          <ul className="full-profile-list">
            {friendsError && <li className="settings-todo">Could not load mutual friends.</li>}
            {!friendsError && !friends && <li className="settings-todo">Loading…</li>}
            {friends?.length === 0 && <li className="settings-todo">No mutual friends.</li>}
            {friends?.map(f => (
              <li key={f.id} className="full-profile-row">
                <Avatar user={f} size={32} />
                <span>{displayName(f)}</span>
                <span className="dm-profile-username">{f.username}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
