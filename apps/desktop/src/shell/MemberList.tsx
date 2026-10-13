import { forwardRef, memo, useMemo } from "react";
import { Virtuoso, type ItemProps, type ListProps } from "react-virtuoso";
import { compareIds } from "../api/snowflake";
import { displayName, roleColor, useStore } from "../api/store";
import type { GuildMember, Role, Snowflake } from "../api/types";
import { useContextMenu } from "../ui";
import { useCustomColor } from "../ui/useCustomColor";
import { ActivityLine, useShownActivity } from "./ActivityLine";
import { Avatar } from "./Avatar";
import { userContextItems } from "./menus";
import { openProfile, TimeoutBadge } from "./ProfileCard";
import { TagChip } from "../perks/TagChip";
import { Nameplate, StyledName, nameplateRowClass } from "../perks/NameStyles";

/** A section title ("Admin — 3") or a member; the list is one flat windowed column. */
type Row = { kind: "title"; key: string; text: string; first: boolean } | { kind: "member"; key: string; member: GuildMember; offline: boolean };

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

const MemberRow = memo(function MemberRow({ member, guildId, offline }: { member: GuildMember; guildId: Snowflake; offline: boolean }) {
  const menu = useContextMenu();
  const color = useCustomColor(useStore(() => roleColor(guildId, member)));
  const custom = useStore(s => s.presences[member.user.id]?.custom_status);
  const playing = useShownActivity(member.user.id);
  return (
    <button
      type="button"
      className={`member-row${offline ? " offline" : ""}${nameplateRowClass(member.user.nameplate)}`}
      onClick={e => openProfile(e.currentTarget, member.user.id, guildId)}
      onContextMenu={e => menu.open(e, userContextItems(member.user, { guildId, anchor: e.currentTarget }))}
    >
      <Nameplate id={member.user.nameplate} />
      <Avatar user={member.user} member={member} size={32} status dim={offline} />
      <span className="member-text">
        <span className="member-name" style={color ? { color } : undefined}>
          <StyledName styles={member.user.display_name_styles}>{displayName(member.user, member)}</StyledName>
          <TagChip tag={member.user.primary_guild} />
          <TimeoutBadge until={member.communication_disabled_until} />
        </span>
        {playing ? <ActivityLine activity={playing} className="member-status" /> : custom && <span className="member-status">{custom}</span>}
      </span>
    </button>
  );
});

const Top = () => <div className="member-list-pad-top" />;
const Bottom = () => <div className="member-list-pad-bottom" />;

// Virtuoso's wrappers carry the list roles (as in chat/MessageList): a screen reader hears "list, N items" and each row's position,
// which windowing would otherwise hide. A list may only hold list items, so the section titles are items too (with their heading).
type ListContext = { total: number };
const List = forwardRef<HTMLDivElement, ListProps & { context?: ListContext }>(function List({ context: _context, ...props }, ref) {
  return <div ref={ref} {...props} role="list" aria-label="Members" />;
});
function Item({ context, item: _item, ...props }: ItemProps<Row> & { context?: ListContext }) {
  return <div {...props} role="listitem" aria-setsize={context?.total} aria-posinset={props["data-index"] + 1} />;
}

/** Right-hand member list: hoisted roles by position, then Online / Offline. Windowed: only the rows on screen are mounted. */
export function MemberList({ guildId }: { guildId: Snowflake }) {
  const members = useStore(s => s.members[guildId]);
  const roles = useStore(s => s.guilds[guildId]?.roles);
  const presences = useStore(s => s.presences);

  // Sorting by name is the expensive part and only depends on the member map: presence changes re-split the sorted list in O(n).
  const sorted = useMemo(
    () =>
      Object.values(members ?? {})
        .map(m => ({ m, name: displayName(m.user, m) }))
        .sort((a, b) => collator.compare(a.name, b.name) || compareIds(a.m.user.id, b.m.user.id))
        .map(x => x.m),
    [members],
  );

  const rows = useMemo<Row[]>(() => {
    const isOnline = (m: GuildMember) => (presences[m.user.id]?.status ?? "offline") !== "offline";
    const hoisted: Role[] = (roles ?? []).filter(r => r.hoist && r.id !== guildId).sort((a, b) => b.position - a.position);
    const buckets = new Map<Snowflake, GuildMember[]>(hoisted.map(r => [r.id, []]));
    const online: GuildMember[] = [];
    const offline: GuildMember[] = [];
    for (const m of sorted) {
      if (!isOnline(m)) {
        offline.push(m);
        continue;
      }
      // The highest hoisted role the member has, else plain Online.
      const role = hoisted.find(r => m.roles.includes(r.id));
      (role ? buckets.get(role.id)! : online).push(m);
    }
    const out: Row[] = [];
    const section = (key: string, title: string, list: GuildMember[], isOffline = false) => {
      if (list.length === 0) return;
      out.push({ kind: "title", key: `title:${key}`, text: `${title} — ${list.length}`, first: out.length === 0 });
      for (const m of list) out.push({ kind: "member", key: m.user.id, member: m, offline: isOffline });
    };
    for (const role of hoisted) section(role.id, role.name, buckets.get(role.id) ?? []);
    section("online", "Online", online);
    section("offline", "Offline", offline, true);
    return out;
  }, [sorted, roles, presences, guildId]);

  return (
    <aside className="member-list" aria-label="Members">
      <Virtuoso<Row>
        className="member-list-scroller"
        data={rows}
        defaultItemHeight={43}
        increaseViewportBy={{ top: 200, bottom: 400 }}
        computeItemKey={(_, row) => row.key}
        context={{ total: rows.length }}
        tabIndex={-1} // the rows are the tab stops; the scroller's own stop showed no focus ring
        components={{ Header: Top, Footer: Bottom, List, Item }}
        itemContent={(_, row) =>
          row.kind === "title" ? (
            <h2 className={`member-section-title${row.first ? " first" : ""}`}>{row.text}</h2>
          ) : (
            <MemberRow member={row.member} guildId={guildId} offline={row.offline} />
          )
        }
      />
    </aside>
  );
}
