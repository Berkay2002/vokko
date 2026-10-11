import { useMemo, useState } from "react";
import { Hash, Volume2 } from "lucide-react";
import { dmName, useStore } from "../api/store";
import { ChannelType, type Snowflake } from "../api/types";
import { Modal } from "../ui";
import { Avatar, GuildIcon } from "./Avatar";
import { openDirectMessage } from "./actions";
import { closeModal } from "./modalStore";
import { dmPath, go, guildPath } from "./nav";

interface Result {
  key: string;
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
        label: dmName(c),
        sub: c.type === ChannelType.GroupDM ? "Group DM" : first?.username,
        icon: first ? <Avatar user={first} size={24} /> : null,
        run: () => go(dmPath(id)),
      });
    }
    for (const r of Object.values(relationships)) {
      if (r.type !== 1 || dmUsers.has(r.id)) continue;
      out.push({ key: `user-${r.id}`, label: r.user.global_name ?? r.user.username, sub: r.user.username, icon: <Avatar user={r.user} size={24} />, run: () => void openDirectMessage(r.id) });
    }
    for (const c of Object.values(channels)) {
      if (!c.guild_id || (c.type !== ChannelType.GuildText && c.type !== ChannelType.GuildVoice)) continue;
      const guild = guilds[c.guild_id];
      if (!guild) continue;
      out.push({
        key: `ch-${c.id}`,
        label: c.name ?? "",
        sub: guild.name,
        icon: c.type === ChannelType.GuildVoice ? <Volume2 size={20} /> : <Hash size={20} />,
        run: () => go(guildPath(guild.id, c.id)),
      });
    }
    for (const g of Object.values(guilds)) out.push({ key: `g-${g.id}`, label: g.name, sub: "Server", icon: <GuildIcon guild={g} size={24} />, run: () => go(guildPath(g.id)) });
    return out;
  }, [channels, guilds, privateChannels, relationships]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^[#@*!]/, "");
    if (!q) return all.slice(0, 12);
    return all
      .filter(r => r.label.toLowerCase().includes(q) || r.sub?.toLowerCase().includes(q))
      .sort((a, b) => Number(b.label.toLowerCase().startsWith(q)) - Number(a.label.toLowerCase().startsWith(q)))
      .slice(0, 12);
  }, [all, query]);

  const choose = (r: Result | undefined) => {
    if (!r) return;
    closeModal();
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
          if (e.key === "ArrowDown") (e.preventDefault(), setIndex(i => Math.min(i + 1, results.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setIndex(i => Math.max(i - 1, 0)));
          else if (e.key === "Enter") (e.preventDefault(), choose(results[index]));
        }}
      />
      <ul className="quick-results" role="listbox">
        {results.map((r, i) => (
          <li key={r.key}>
            <button type="button" role="option" aria-selected={i === index} className={`quick-row${i === index ? " selected" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => choose(r)}>
              <span className="quick-icon">{r.icon}</span>
              <span className="quick-label">{r.label}</span>
              {r.sub && <span className="quick-sub">{r.sub}</span>}
            </button>
          </li>
        ))}
        {results.length === 0 && <li className="quick-empty">No results found. Nobody here but us chickens.</li>}
      </ul>
      <div className="quick-tip">PROTIP: Start searches with @ for users, # for channels.</div>
    </Modal>
  );
}
