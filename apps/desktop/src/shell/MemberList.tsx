import { useMemo } from "react";
import { compareIds } from "../api/snowflake";
import { displayName, roleColor, useStore } from "../api/store";
import { appStore } from "../api/store";
import type { GuildMember, Role, Snowflake } from "../api/types";
import { useContextMenu } from "../ui";
import { useCustomColor } from "../ui/useCustomColor";
import { ActivityLine, usePlaying } from "./ActivityLine";
import { Avatar } from "./Avatar";
import { userContextItems } from "./menus";
import { openProfile, TimeoutBadge } from "./ProfileCard";
import { TagChip } from "../perks/TagChip";

interface Section {
  key: string;
  title: string;
  members: GuildMember[];
}

function MemberRow({ member, guildId, offline }: { member: GuildMember; guildId: Snowflake; offline: boolean }) {
  const menu = useContextMenu();
  const color = useCustomColor(useStore(() => roleColor(guildId, member)));
  const custom = useStore(s => s.presences[member.user.id]?.custom_status);
  const playing = usePlaying(member.user.id);
  return (
    <li>
      <button
        type="button"
        className={`member-row${offline ? " offline" : ""}`}
        onClick={e => openProfile(e.currentTarget, member.user.id, guildId)}
        onContextMenu={e => menu.open(e, userContextItems(member.user, { guildId, anchor: e.currentTarget }))}
      >
        <Avatar user={member.user} member={member} size={32} status dim={offline} />
        <span className="member-text">
          <span className="member-name" style={color ? { color } : undefined}>
            {displayName(member.user, member)}
            <TagChip tag={member.user.primary_guild} />
            <TimeoutBadge until={member.communication_disabled_until} />
          </span>
          {playing ? <ActivityLine activity={playing} className="member-status" /> : custom && <span className="member-status">{custom}</span>}
        </span>
      </button>
    </li>
  );
}

/** Right-hand member list: hoisted roles by position, then Online / Offline. */
export function MemberList({ guildId }: { guildId: Snowflake }) {
  const members = useStore(s => s.members[guildId]);
  const roles = useStore(s => s.guilds[guildId]?.roles);
  const presences = useStore(s => s.presences);

  const sections = useMemo<Section[]>(() => {
    const all = Object.values(members ?? {});
    const isOnline = (m: GuildMember) => {
      const status = presences[m.user.id]?.status ?? "offline";
      return status !== "offline";
    };
    const byName = (a: GuildMember, b: GuildMember) => displayName(a.user, a).localeCompare(displayName(b.user, b), undefined, { sensitivity: "base" }) || compareIds(a.user.id, b.user.id);
    const hoisted: Role[] = (roles ?? []).filter(r => r.hoist && r.id !== guildId).sort((a, b) => b.position - a.position);
    const placed = new Set<Snowflake>();
    const out: Section[] = [];
    for (const role of hoisted) {
      const list = all.filter(m => !placed.has(m.user.id) && isOnline(m) && m.roles.includes(role.id)).sort(byName);
      list.forEach(m => placed.add(m.user.id));
      if (list.length > 0) out.push({ key: role.id, title: role.name, members: list });
    }
    const online = all.filter(m => !placed.has(m.user.id) && isOnline(m)).sort(byName);
    if (online.length > 0) out.push({ key: "online", title: "Online", members: online });
    const offline = all.filter(m => !isOnline(m)).sort(byName);
    if (offline.length > 0) out.push({ key: "offline", title: "Offline", members: offline });
    return out;
  }, [members, roles, presences, guildId]);

  void appStore;
  return (
    <aside className="member-list" aria-label="Members">
      <div className="member-list-scroller">
        {sections.map(section => (
          <section key={section.key} className="member-section">
            <h2 className="member-section-title">
              {section.title} — {section.members.length}
            </h2>
            <ul>
              {section.members.map(m => (
                <MemberRow key={m.user.id} member={m} guildId={guildId} offline={section.key === "offline"} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
