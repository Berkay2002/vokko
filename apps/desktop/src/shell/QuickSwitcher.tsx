import { useEffect, useId, useMemo, useState } from "react";
import { Hash, Volume2 } from "lucide-react";
import { appStore, channelMentionCount, dmName, guildUnread, isChannelUnread, useStore } from "../api/store";
import { ChannelType, type Snowflake } from "../api/types";
import { parseQuery, rank, type Rankable } from "../keyboard/switcher";
import { Modal } from "../ui";
import { Avatar, GuildIcon } from "./Avatar";
import { openDirectMessage } from "./actions";
import { closeModal, useModals } from "./modalStore";
import { blockedByUnsaved } from "./settings/unsaved";
import { dmPath, go, guildPath } from "./nav";

const RECENT_KEY = "vokko.recentChannels";
const RECENT_MAX = 8;

function loadRecent(): Snowflake[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

// Visited channels and DMs, newest first. Recorded at module load so it also covers visits made before the switcher opens.
let recent = loadRecent();
appStore.subscribe((state, prev) => {
  const id = state.route.channelId;
  if (!id || id === prev.route.channelId) return;
  recent = [id, ...recent.filter(r => r !== id)].slice(0, RECENT_MAX + 1);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    /* storage unavailable: recents last for this session */
  }
});

const KIND_TAG: Partial<Record<Result["kind"], string>> = { text: "Text channels", voice: "Voice channels" };

interface Result extends Rankable {
  key: string;
  kind: "dm" | "user" | "text" | "voice" | "server";
  icon: React.ReactNode;
  run(): void;
}

/** Ctrl+K: jump to a DM, channel, server or friend by name. */
export function QuickSwitcher() {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const channels = useStore(s => s.channels);
  const guilds = useStore(s => s.guilds);
  const privateChannels = useStore(s => s.privateChannels);
  const relationships = useStore(s => s.relationships);
  const readStates = useStore(s => s.readStates);
  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;

  const all = useMemo<Result[]>(() => {
    const state = appStore.getState();
    // Unread state and mention badges per row; `recent` is the position in the visited list (newest first).
    const marks = (id: Snowflake) => ({ unread: isChannelUnread(state, id), mentions: channelMentionCount(state, id), ...(recent.includes(id) ? { recent: recent.indexOf(id) } : {}) });
    const out: Result[] = [];
    const dmUsers = new Set<Snowflake>();
    for (const id of privateChannels) {
      const c = channels[id];
      if (!c) continue;
      const first = c.recipients?.[0];
      if (c.type === ChannelType.DM && first) dmUsers.add(first.id);
      out.push({
        key: `dm-${id}`,
        kind: "dm",
        ...marks(id),
        label: dmName(c),
        sub: c.type === ChannelType.GroupDM ? "Group DM" : first?.username,
        icon: first ? <Avatar user={first} size={20} /> : null,
        run: () => go(dmPath(id)),
      });
    }
    for (const r of Object.values(relationships)) {
      if (r.type !== 1 || dmUsers.has(r.id)) continue;
      out.push({ key: `user-${r.id}`, kind: "user", label: r.user.global_name ?? r.user.username, sub: r.user.username, icon: <Avatar user={r.user} size={20} />, run: () => void openDirectMessage(r.id) });
    }
    for (const c of Object.values(channels)) {
      if (!c.guild_id || (c.type !== ChannelType.GuildText && c.type !== ChannelType.GuildVoice)) continue;
      const guild = guilds[c.guild_id];
      if (!guild) continue;
      out.push({
        key: `ch-${c.id}`,
        kind: c.type === ChannelType.GuildVoice ? "voice" : "text",
        ...marks(c.id),
        label: c.name ?? "",
        sub: guild.name,
        icon: c.type === ChannelType.GuildVoice ? <Volume2 size={20} /> : <Hash size={20} />,
        run: () => go(guildPath(guild.id, c.id)),
      });
    }
    for (const g of Object.values(guilds)) {
      const { unread, mentions } = guildUnread(state, g.id);
      out.push({ key: `g-${g.id}`, kind: "server", label: g.name, sub: "Server", unread, mentions, icon: <GuildIcon guild={g} size={20} />, run: () => go(guildPath(g.id)) });
    }
    return out;
    // readStates is a dependency so the unread and mention marks follow acks while the switcher is open.
  }, [channels, guilds, privateChannels, relationships, readStates]);

  const { scope, text } = parseQuery(query);
  const results = useMemo(() => {
    if (scope === "unavailable") return [];
    const pool = all.filter(r => {
      if (scope === "all") return true;
      if (scope === "users") return r.kind === "dm" || r.kind === "user";
      return r.kind === scope.replace("servers", "server");
    });
    return rank(pool, text);
  }, [all, text, scope]);

  // Empty query: previously visited channels (not the one you are in), like the reference's "Previous channels" list.
  const current = useStore(s => s.route.channelId);
  const previous = useMemo(() => {
    if (scope !== "all" || query.trim()) return [];
    const byKey = new Map(all.map(r => [r.key, r]));
    return recent
      .filter(id => id !== current)
      .map(id => byKey.get(`ch-${id}`) ?? byKey.get(`dm-${id}`))
      .filter((r): r is Result => !!r)
      .slice(0, RECENT_MAX);
  }, [all, current, query, scope]);
  const shown = previous.length > 0 ? previous : results;

  const active = shown[index] ? optionId(index) : undefined;
  useEffect(() => {
    if (active) document.getElementById(active)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const move = (by: number) => setIndex(i => (shown.length ? (i + by + shown.length) % shown.length : 0));

  const choose = (r: Result | undefined) => {
    if (!r) return;
    // A parked settings frame with unsaved changes refuses the jump: back to the frame, which shakes, draft intact.
    if (useModals.getState().base && blockedByUnsaved()) return closeModal();
    // Leave parked settings behind too: the result navigates away from them.
    useModals.setState({ modal: null, base: null });
    r.run();
  };

  return (
    <Modal open onClose={closeModal} hideClose labelledBy="quick-switcher-title" className="quick-switcher">
      <span id="quick-switcher-title" className="sr-only">Quick switcher</span>
      <div className="quick-title" aria-hidden="true">Search for servers, channels or DMs</div>
      <input
        className="quick-input"
        autoFocus
        role="combobox"
        aria-label="Search channels, people and servers"
        aria-expanded={shown.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active}
        autoComplete="off"
        value={query}
        placeholder="Where would you like to go?"
        onChange={e => (setQuery(e.target.value), setIndex(0))}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          // Tab walks the results like the arrows (Discord); stopPropagation keeps the dialog's focus trap out of it.
          if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) (e.preventDefault(), e.stopPropagation(), move(1));
          else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) (e.preventDefault(), e.stopPropagation(), move(-1));
          else if (e.key === "Enter") (e.preventDefault(), choose(shown[index]));
        }}
      />
      <div className="quick-scroller">
      {previous.length > 0 && <div className="quick-heading">Previous channels</div>}
      <ul className="quick-results" role="listbox" id={listId} aria-label="Results">
        {shown.map((r, i) => (
          <li key={r.key} role="presentation">
            <button
              type="button"
              role="option"
              id={optionId(i)}
              aria-selected={i === index}
              className={`quick-row${i === index ? " selected" : ""}${r.unread ? " unread" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(r)}
            >
              <span className="quick-icon">{r.icon}</span>
              <span className="quick-label">{r.label}</span>
              {KIND_TAG[r.kind] && <span className="quick-tag">{KIND_TAG[r.kind]}</span>}
              {r.sub && <span className="quick-sub">{r.sub}</span>}
              {!!r.mentions && (
                <span className="count-badge quick-badge" aria-label={`${r.mentions} mentions`}>
                  {r.mentions > 99 ? "99+" : r.mentions}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
      {/* Always mounted: a live region announces text set after it exists, not text it is born with. */}
      <div className={shown.length === 0 ? "quick-empty" : undefined} role="status">
        {shown.length === 0 && (scope === "unavailable" ? "Not available yet." : "No results found. Nobody here but us chickens.")}
      </div>
      </div>
      <div className="quick-tip">
        <span className="quick-tip-label">PROTIP:</span> Start searches with <kbd>@</kbd> <kbd>#</kbd> <kbd>!</kbd> <kbd>*</kbd> <kbd>$</kbd> to narrow results.
      </div>
    </Modal>
  );
}
