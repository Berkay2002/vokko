import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { ArrowDownUp, ChevronLeft, ChevronRight, Filter, Link2, MoreVertical, Search, UserCog, Users, X } from "lucide-react";
import { appStore, displayName, roleColor, sortRoles, useStore } from "../api/store";
import { request } from "../api/rest";
import { snowflakeToTimestamp } from "../api/snowflake";
import type { Guild, GuildMember, MemberSearchResponse, MemberSearchSort, Snowflake, SupplementalGuildMember } from "../api/types";
import { Dropdown, Tooltip, useContextMenu } from "../ui";
import { Avatar } from "../shell/Avatar";
import { NavToggle } from "../shell/NavToggle";
import { UNAVAILABLE } from "../shell/menus";
import { TagChip } from "../perks/TagChip";
import { FilterPopout, InviteFilterMenu, RadioRow, RoleFilterMenu, SignalFilterMenu, TimeFilterMenu, roleHex } from "./Filters";
import { memberRowItems } from "./menu";
import {
  ALL_TIME,
  NEW_ACCOUNT_MS,
  NO_FILTERS,
  PAGE_SIZES,
  SORT_OPTIONS,
  buildSearchRequest,
  isActive,
  pageCount,
  pageItems,
  readUrlState,
  relativeTime,
  writeUrlState,
  type MemberFilters,
} from "./query";

const PAGE_SIZE_KEY = "vokko.membersPageSize";
const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE_OPTIONS = PAGE_SIZES.map(size => ({ value: String(size), label: String(size) }));

function storedPageSize(): number {
  const value = Number(localStorage.getItem(PAGE_SIZE_KEY));
  return (PAGE_SIZES as readonly number[]).includes(value) ? value : PAGE_SIZES[0];
}

/** Search results also go into the store, so the shared member menu (roles, nickname) and live updates see them. */
function rememberMembers(guildId: Snowflake, members: GuildMember[]) {
  const state = appStore.getState();
  const known = state.members[guildId] ?? {};
  const next = { ...known };
  for (const member of members) next[member.user.id] = { ...known[member.user.id], ...member };
  appStore.setState({ members: { ...state.members, [guildId]: next } });
  state.cacheUsers(members.map(m => m.user));
}

type Popover = "sort" | "memberSince" | "joinedVokko" | "joinMethod" | "roles" | "signals" | null;

export function MembersPage({ guild }: { guild: Guild }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { page, sort } = readUrlState(location.search);
  const [pageSize, setPageSize] = useState(storedPageSize);
  const [searchText, setSearchText] = useState("");
  const [filters, setFilters] = useState<MemberFilters>(NO_FILTERS);
  const [result, setResult] = useState<MemberSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [popover, setPopover] = useState<Popover>(null);
  const [knownCodes, setKnownCodes] = useState<string[]>([]);
  const anchors = useRef<Partial<Record<Exclude<Popover, null>, HTMLButtonElement | null>>>({});
  const storeMembers = useStore(s => s.members[guild.id]);
  const roles = useMemo(() => sortRoles(guild.roles).filter(r => r.id !== guild.id), [guild.roles, guild.id]);

  const setUrl = (nextPage: number, nextSort: MemberSearchSort) => void navigate({ search: writeUrlState(nextPage, nextSort) }, { replace: true });
  const setPage = (next: number) => setUrl(next, sort);
  const updateFilters = (patch: Partial<MemberFilters>) => {
    setFilters(f => ({ ...f, ...patch }));
    if (page !== 1) setPage(1);
  };

  // Debounced search: the typed text becomes a filter after a pause.
  useEffect(() => {
    if (searchText === filters.search) return;
    const timer = window.setTimeout(() => updateFilters({ search: searchText }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    request<MemberSearchResponse>("POST", `/guilds/${guild.id}/members-search`, buildSearchRequest(filters, sort, page, pageSize))
      .then(response => {
        if (!live) return;
        rememberMembers(guild.id, response.members.map(m => m.member));
        setResult(response);
        setError(null);
        const codes = response.members.flatMap(m => (m.source_invite_code ? [m.source_invite_code] : []));
        setKnownCodes(prev => (codes.every(c => prev.includes(c)) ? prev : [...new Set([...prev, ...codes])]));
        // Past the last page (members left, filters changed): go to the last one that exists.
        const last = pageCount(response.total_result_count, pageSize);
        if (page > last) setPage(last);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : "Could not load members.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id, filters, sort, page, pageSize]);

  const searching = filters.search.trim() !== "";
  // The one signal Vokko has: accounts under 7 days old, which is the "Last 7 days" window of Joined Vokko.
  const newAccountsOnly = filters.joinedVokko.kind === "preset" && filters.joinedVokko.preset === "7d";
  const total = result?.total_result_count ?? 0;
  const pages = pageCount(total, pageSize);
  const close = () => setPopover(null);
  const anchorRef = (key: Exclude<Popover, null>) => (el: HTMLButtonElement | null) => {
    anchors.current[key] = el;
  };
  const filterButton = (key: Exclude<Popover, null>, label: string, active: boolean) => (
    <button
      type="button"
      ref={anchorRef(key)}
      className={`mp-filter-btn${active ? " active" : ""}`}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={popover === key}
      onClick={() => setPopover(p => (p === key ? null : key))}
    >
      <Filter size={14} aria-hidden="true" />
    </button>
  );

  return (
    <div className="mp-page">
      <section className="channel-header mp-header" aria-label="Members">
        <div className="channel-header-title">
          <NavToggle />
          <Users size={24} className="channel-header-icon" aria-hidden="true" />
          <h1 className="channel-header-name">Members</h1>
        </div>
      </section>
      <div className="mp-scroller">
        <div className="mp-card">
          <div className="mp-card-header">
            <h2 className="mp-title">{searching ? "Search Results" : "Recent Members"}</h2>
            <div className="mp-tools">
              <div className="mp-search">
                <Search size={16} className="mp-search-icon" aria-hidden="true" />
                <input
                  className="mp-search-input"
                  type="search"
                  placeholder="Search by username or ID"
                  aria-label="Search by username or ID"
                  value={searchText}
                  maxLength={100}
                  onChange={e => setSearchText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") updateFilters({ search: searchText });
                  }}
                />
                {searchText && (
                  <button
                    type="button"
                    className="mp-search-clear"
                    aria-label="Clear search"
                    onClick={() => {
                      setSearchText("");
                      updateFilters({ search: "" });
                    }}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              <button type="button" ref={anchorRef("sort")} className="mp-sort-btn" aria-haspopup="dialog" aria-expanded={popover === "sort"} onClick={() => setPopover(p => (p === "sort" ? null : "sort"))}>
                <ArrowDownUp size={16} aria-hidden="true" />
                Sort
              </button>
            </div>
          </div>

          <div className="mp-table-wrap">
            <table className="mp-table" aria-label="Server members" aria-busy={loading}>
              <thead>
                <tr>
                  <th scope="col" className="mp-col-name">
                    Name
                  </th>
                  <th scope="col">
                    <span className="mp-th">Member since{filterButton("memberSince", "Filter by member since", isActive(filters.memberSince))}</span>
                  </th>
                  <th scope="col">
                    <span className="mp-th">Joined Vokko{filterButton("joinedVokko", "Filter by joined Vokko", isActive(filters.joinedVokko))}</span>
                  </th>
                  <th scope="col">
                    <span className="mp-th">Join method{filterButton("joinMethod", "Filter by join method", filters.inviteCodes.length > 0)}</span>
                  </th>
                  <th scope="col">
                    <span className="mp-th">Roles{filterButton("roles", "Filter by roles", filters.roleIds.length > 0)}</span>
                  </th>
                  <th scope="col">
                    <span className="mp-th">Signals{filterButton("signals", "Filter by signals", newAccountsOnly)}</span>
                  </th>
                  <th scope="col" className="mp-col-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {result?.members.map(row => (
                  <MemberRow key={row.member.user.id} guild={guild} row={row} live={storeMembers?.[row.member.user.id]} />
                ))}
              </tbody>
            </table>
            {result && result.members.length === 0 && !loading && <div className="mp-empty">No members match these filters.</div>}
            {error && (
              <div className="mp-empty" role="alert">
                {error}
              </div>
            )}
          </div>

          <div className="mp-footer">
            <div className="mp-showing">
              {searching ? (
                <span>
                  Showing {total} {total === 1 ? "member" : "members"}
                </span>
              ) : (
                <>
                  <span>Showing</span>
                  <Dropdown
                    className="mp-size"
                    label="Members per page"
                    value={String(pageSize)}
                    options={PAGE_SIZE_OPTIONS}
                    onChange={value => {
                      const next = Number(value);
                      localStorage.setItem(PAGE_SIZE_KEY, String(next));
                      setPageSize(next);
                      setPage(1);
                    }}
                  />
                  <span>members of {total}</span>
                </>
              )}
            </div>
            <nav className="mp-pager" aria-label="Pagination">
              <button type="button" className="mp-page-step" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                <ChevronLeft size={16} aria-hidden="true" />
                Previous
              </button>
              {pageItems(Math.min(page, pages), pages).map((item, index) =>
                item === "…" ? (
                  <span key={`gap-${index}`} className="mp-page-gap" aria-hidden="true">
                    …
                  </span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    className={`mp-page-num${item === page ? " current" : ""}`}
                    aria-label={`Page ${item}`}
                    aria-current={item === page ? "page" : undefined}
                    onClick={() => setPage(item)}
                  >
                    {item}
                  </button>
                ),
              )}
              <button type="button" className="mp-page-step" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </nav>
          </div>
        </div>
      </div>

      <FilterPopout anchor={anchors.current.sort ?? null} open={popover === "sort"} onClose={close} label="Sort members">
        <div role="radiogroup" aria-label="Sort members">
          {SORT_OPTIONS.map(option => (
            <RadioRow
              key={option.value}
              label={option.label}
              checked={sort === option.value}
              onSelect={() => {
                setUrl(1, option.value);
                close();
              }}
            />
          ))}
        </div>
      </FilterPopout>
      <FilterPopout anchor={anchors.current.memberSince ?? null} open={popover === "memberSince"} onClose={close} label="Filter by member since">
        <TimeFilterMenu
          label="Member since"
          value={filters.memberSince}
          onChange={memberSince => {
            updateFilters({ memberSince });
            close();
          }}
        />
      </FilterPopout>
      <FilterPopout anchor={anchors.current.joinedVokko ?? null} open={popover === "joinedVokko"} onClose={close} label="Filter by joined Vokko">
        <TimeFilterMenu
          label="Joined Vokko"
          value={filters.joinedVokko}
          onChange={joinedVokko => {
            updateFilters({ joinedVokko });
            close();
          }}
        />
      </FilterPopout>
      <FilterPopout anchor={anchors.current.joinMethod ?? null} open={popover === "joinMethod"} onClose={close} label="Filter by join method">
        <InviteFilterMenu known={knownCodes} value={filters.inviteCodes} onChange={inviteCodes => updateFilters({ inviteCodes })} />
      </FilterPopout>
      <FilterPopout anchor={anchors.current.roles ?? null} open={popover === "roles"} onClose={close} label="Filter by roles">
        <RoleFilterMenu roles={roles} value={filters.roleIds} onChange={roleIds => updateFilters({ roleIds })} />
      </FilterPopout>
      <FilterPopout anchor={anchors.current.signals ?? null} open={popover === "signals"} onClose={close} label="Filter by signals">
        <SignalFilterMenu checked={newAccountsOnly} onToggle={() => updateFilters({ joinedVokko: newAccountsOnly ? ALL_TIME : { kind: "preset", preset: "7d" } })} />
      </FilterPopout>
    </div>
  );
}

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={`mp-chip ${className ?? ""}`}>{children}</span>;
}

function MemberRow({ guild, row, live }: { guild: Guild; row: SupplementalGuildMember; live: GuildMember | undefined }) {
  const member = live ?? row.member;
  const { user } = member;
  const menu = useContextMenu();
  const moreRef = useRef<HTMLButtonElement>(null);
  const color = roleColor(guild.id, member);
  const memberRoles = sortRoles(guild.roles.filter(r => r.id !== guild.id && member.roles.includes(r.id)));
  const [first, ...rest] = memberRoles;
  const createdMs = snowflakeToTimestamp(user.id);
  const joinedMs = Date.parse(member.joined_at);
  const newAccount = Date.now() - createdMs < NEW_ACCOUNT_MS;
  const name = displayName(user, member);
  const openMenu = () => {
    const rect = moreRef.current?.getBoundingClientRect();
    if (!rect) return;
    menu.open({ clientX: rect.left, clientY: rect.bottom + 4 }, memberRowItems(user, guild.id, moreRef.current));
  };
  return (
    <tr className="mp-row" onContextMenu={e => menu.open(e, memberRowItems(user, guild.id, e.currentTarget as HTMLElement))}>
      <td className="mp-col-name">
        <div className="mp-name-cell">
          <Avatar user={user} member={member} size={32} />
          <div className="mp-names">
            <span className="mp-display-row">
              <span className="mp-display" style={color ? { color } : undefined}>
                {name}
              </span>
              <TagChip tag={user.primary_guild} />
            </span>
            <span className="mp-username">{user.username}</span>
          </div>
        </div>
      </td>
      <td>
        <time dateTime={member.joined_at} title={new Date(joinedMs).toLocaleString()}>
          {relativeTime(joinedMs)}
        </time>
      </td>
      <td>
        <time dateTime={new Date(createdMs).toISOString()} title={new Date(createdMs).toLocaleString()}>
          {relativeTime(createdMs)}
        </time>
      </td>
      <td>
        {row.source_invite_code ? (
          <Chip>
            <Link2 size={14} aria-hidden="true" />
            {row.source_invite_code}
          </Chip>
        ) : (
          <span className="mp-muted">Unknown</span>
        )}
      </td>
      <td>
        <span className="mp-roles">
          {first && (
            <Chip>
              <span className="mp-role-dot" style={{ background: roleHex(first.color) }} aria-hidden="true" />
              <span className="mp-chip-text">{first.name}</span>
            </Chip>
          )}
          {rest.length > 0 && (
            <Tooltip content={rest.map(r => r.name).join(", ")}>
              <span className="mp-chip mp-more" role="img" tabIndex={0} aria-label={`${rest.length} more roles: ${rest.map(r => r.name).join(", ")}`}>
                +{rest.length}
              </span>
            </Tooltip>
          )}
        </span>
      </td>
      <td>{newAccount && <Chip className="mp-signal">New account</Chip>}</td>
      <td className="mp-col-actions">
        <span className="mp-actions">
          <Tooltip content={UNAVAILABLE}>
            <button type="button" className="mp-icon-btn" aria-label={`Open ${name} in Mod View`} aria-disabled="true">
              <UserCog size={18} aria-hidden="true" />
            </button>
          </Tooltip>
          <button type="button" ref={moreRef} className="mp-icon-btn" aria-label={`More actions for ${name}`} aria-haspopup="menu" onClick={openMenu}>
            <MoreVertical size={18} aria-hidden="true" />
          </button>
        </span>
      </td>
    </tr>
  );
}
