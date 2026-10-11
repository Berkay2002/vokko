import { useMemo, useState } from "react";
import { Hash, Volume2 } from "lucide-react";
import { appStore, dmName, useStore } from "../api/store";
import { ChannelType, type Snowflake } from "../api/types";
import { Modal } from "../ui";
import { Avatar, GuildIcon } from "./Avatar";
import { openDirectMessage } from "./actions";
import { closeModal, useModals } from "./modalStore";
import { dmPath, go, guildPath } from "./nav";

type Scope = "all" | "users" | "text" | "voice" | "servers" | "unavailable";

const PREFIXES: Record<string, Scope> = { "@": "users", "#": "text", "!": "voice", "*": "servers", $: "unavailable" };

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

interface Result {
  key: string;
  kind: "dm" | "user" | "text" | "voice" | "server";
  label: string;
  sub?: string;
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

  const all = useMemo<Result[]>(() => {
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
        label: dmName(c),
        sub: c.type === ChannelType.GroupDM ? "Group DM" : first?.username,
        icon: first ? <Avatar user={first} size={24} /> : null,
        run: () => go(dmPath(id)),
      });
    }
    for (const r of Object.values(relationships)) {
      if (r.type !== 1 || dmUsers.has(r.id)) continue;
      out.push({ key: `user-${r.id}`, kind: "user", label: r.user.global_name ?? r.user.username, sub: r.user.username, icon: <Avatar user={r.user} size={24} />, run: () => void openDirectMessage(r.id) });
    }
    for (const c of Object.values(channels)) {
      if (!c.guild_id || (c.type !== ChannelType.GuildText && c.type !== ChannelType.GuildVoice)) continue;
      const guild = guilds[c.guild_id];
      if (!guild) continue;
      out.push({
        key: `ch-${c.id}`,
        kind: c.type === ChannelType.GuildVoice ? "voice" : "text",
        label: c.name ?? "",
        sub: guild.name,
        icon: c.type === ChannelType.GuildVoice ? <Volume2 size={20} /> : <Hash size={20} />,
        run: () => go(guildPath(guild.id, c.id)),
      });
    }
    for (const g of Object.values(guilds)) out.push({ key: `g-${g.id}`, kind: "server", label: g.name, sub: "Server", icon: <GuildIcon guild={g} size={24} />, run: () => go(guildPath(g.id)) });
    return out;
  }, [channels, guilds, privateChannels, relationships]);

  const scope: Scope = PREFIXES[query.trim().charAt(0)] ?? "all";
  const results = useMemo(() => {
    if (scope === "unavailable") return [];
    const q = (scope === "all" ? query : query.trim().slice(1)).trim().toLowerCase();
    const pool = all.filter(r => {
      if (scope === "all") return true;
      if (scope === "users") return r.kind === "dm" || r.kind === "user";
      return r.kind === scope.replace("servers", "server");
    });
    if (!q) return pool.slice(0, 12);
    return pool
      .filter(r => r.label.toLowerCase().includes(q) || r.sub?.toLowerCase().includes(q))
      .sort((a, b) => Number(b.label.toLowerCase().startsWith(q)) - Number(a.label.toLowerCase().startsWith(q)))
      .slice(0, 12);
  }, [all, query, scope]);

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

  const choose = (r: Result | undefined) => {
    if (!r) return;
    // Leave parked settings behind too: the result navigates away from them.
    useModals.setState({ modal: null, base: null });
    r.run();
  };

  return (
    <Modal open onClose={closeModal} hideClose className="quick-switcher">
      <input
        className="quick-input"
        autoFocus
        value={query}
        placeholder="Where would you like to go?"
        onChange={e => (setQuery(e.target.value), setIndex(0))}
        onKeyDown={e => {
          if (e.key === "ArrowDown") (e.preventDefault(), setIndex(i => Math.min(i + 1, shown.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setIndex(i => Math.max(i - 1, 0)));
          else if (e.key === "Enter") (e.preventDefault(), choose(shown[index]));
        }}
      />
      {previous.length > 0 && <div className="quick-heading">Previous channels</div>}
      <ul className="quick-results" role="listbox">
        {shown.map((r, i) => (
          <li key={r.key}>
            <button type="button" role="option" aria-selected={i === index} className={`quick-row${i === index ? " selected" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => choose(r)}>
              <span className="quick-icon">{r.icon}</span>
              <span className="quick-label">{r.label}</span>
              {KIND_TAG[r.kind] && <span className="quick-tag">{KIND_TAG[r.kind]}</span>}
              {r.sub && <span className="quick-sub">{r.sub}</span>}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="quick-empty">{scope === "unavailable" ? "Not available yet." : "No results found. Nobody here but us chickens."}</li>}
      </ul>
      <div className="quick-tip">
        <span className="quick-tip-label">PROTIP:</span> Start searches with <kbd>@</kbd> <kbd>#</kbd> <kbd>!</kbd> <kbd>*</kbd> <kbd>$</kbd> to narrow results to users, text channels, voice channels, servers and more.
      </div>
    </Modal>
  );
}
