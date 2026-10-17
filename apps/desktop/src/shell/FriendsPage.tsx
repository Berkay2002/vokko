import { useMemo, useState } from "react";
import { NavToggle } from "./NavToggle";
import { siSpotify } from "simple-icons";
import { BrandIcon } from "../ui/BrandIcon";
import { Check, Gamepad2, MessageCircle, MoreVertical, Search, Users, Volume2, X } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { request } from "../api/rest";
import { displayName, useStore } from "../api/store";
import { RelationshipType, type Activity, type Channel, type Guild, type Relationship, type User } from "../api/types";
import { joinVoiceChannel } from "../voice";
import { useChannelVoiceStates, useVoice } from "../voice/store";
import { ActivityLine, useNow } from "./ActivityLine";
import { SpotifyArt } from "./SpotifyCard";
import { formatClock } from "../activity/format";
import { activeFriends, type ActiveEntry } from "./activeNow";
import { Tooltip, useContextMenu } from "../ui";
import { getPrefs } from "../ui/prefs";
import { FriendSuggestionsTab } from "../community";
import { Avatar, GuildIcon } from "./Avatar";
import { copyText, openDirectMessage } from "./actions";
import { openProfile } from "./profileStore";
import { go, guildPath } from "./nav";
import { UNAVAILABLE } from "./menus";
import { openModal } from "./modalStore";

type Tab = "online" | "all" | "pending" | "suggestions" | "blocked" | "add";

const TABS: { id: Tab; label: string }[] = [
  { id: "online", label: "Online" },
  { id: "all", label: "All" },
  { id: "pending", label: "Pending" },
  { id: "suggestions", label: "Suggestions" },
  { id: "blocked", label: "Blocked" },
];

const act = (method: "PUT" | "DELETE", userId: string) => request<void>(method, `/users/@me/relationships/${userId}`, method === "PUT" ? {} : undefined).catch(() => undefined);

function PersonRow({ relationship, mode }: { relationship: Relationship; mode: "friend" | "incoming" | "outgoing" | "blocked" }) {
  const presence = useStore(s => s.presences[relationship.id]);
  const menu = useContextMenu();
  const user = relationship.user;
  const status = presence?.status ?? "offline";
  const sub =
    mode === "incoming" ? "Incoming Friend Request" : mode === "outgoing" ? "Outgoing Friend Request" : mode === "blocked" ? "Blocked" : (presence?.custom_status ?? (status === "offline" ? "Offline" : status === "dnd" ? "Do Not Disturb" : status === "idle" ? "Idle" : "Online"));
  const circle = (label: string, icon: React.ReactNode, onClick: (event: React.MouseEvent<HTMLButtonElement>) => void, danger?: boolean) => (
    <Tooltip content={label} side="top">
      <button
        type="button"
        className={`people-action${danger ? " danger" : ""}`}
        aria-label={`${label}`}
        onClick={e => {
          e.stopPropagation();
          onClick(e);
        }}
      >
        {icon}
      </button>
    </Tooltip>
  );
  return (
    <li
      className="people-row"
      onClick={() => mode === "friend" && void openDirectMessage(user.id)}
      onContextMenu={e =>
        menu.open(e, [
          { id: "message", label: "Message", onSelect: () => void openDirectMessage(user.id) },
          { type: "separator" },
          ...(mode === "friend"
            ? [
                { id: "remove", label: "Remove Friend", danger: true, onSelect: () => openModal({ type: "removeFriend", userId: user.id }) },
                { id: "block", label: "Block", danger: true, onSelect: () => openModal({ type: "blockUser", userId: user.id }) },
              ]
            : []),
          ...(getPrefs().developerMode ? [{ id: "copy", label: "Copy User ID", onSelect: () => copyText(user.id) }] : []),
        ])
      }
    >
      <Avatar user={user} size={32} status />
      <div className="people-text">
        <div className="people-name">
          {displayName(user)}
          <span className="people-handle">{user.username}</span>
        </div>
        <div className="people-sub">{sub}</div>
      </div>
      <div className="people-actions">
        {mode === "friend" && (
          <>
            {circle("Message", <MessageCircle size={18} />, () => void openDirectMessage(user.id))}
            {circle(
              "More",
              <MoreVertical size={18} />,
              event => {
                const rect = event.currentTarget.getBoundingClientRect();
                menu.open({ clientX: rect.left, clientY: rect.bottom + 4 }, [
                  { id: "video-call", label: "Start Video Call", disabled: true, tooltip: UNAVAILABLE },
                  { id: "voice-call", label: "Start Voice Call", disabled: true, tooltip: UNAVAILABLE },
                  { id: "remove", label: "Remove Friend", danger: true, onSelect: () => openModal({ type: "removeFriend", userId: user.id }) },
                ]);
              },
            )}
          </>
        )}
        {mode === "incoming" && (
          <>
            {circle("Accept", <Check size={18} />, () => void act("PUT", user.id))}
            {circle("Ignore", <X size={18} />, () => void act("DELETE", user.id), true)}
          </>
        )}
        {mode === "outgoing" && circle("Cancel", <X size={18} />, () => void act("DELETE", user.id), true)}
        {mode === "blocked" && circle("Unblock", <X size={18} />, () => void act("DELETE", user.id), true)}
      </div>
    </li>
  );
}

function AddFriend() {
  const [username, setUsername] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const name = username.trim().toLowerCase();
    if (!name) return;
    setBusy(true);
    try {
      await request<void>("POST", "/users/@me/relationships", { username: name });
      setResult({ ok: true, text: `Success! Your friend request to ${name} was sent.` });
      setUsername("");
    } catch (error) {
      const message = error instanceof ApiRequestError && error.status === 404 ? "Hm, didn't work. Double check that the username is correct." : error instanceof ApiRequestError ? error.message : "Something went wrong. Try again.";
      setResult({ ok: false, text: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="add-friend">
      <h2>Add Friend</h2>
      <p>You can add friends with their Vokko username.</p>
      <form
        className={`add-friend-input${result ? (result.ok ? " success" : " error") : ""}`}
        onSubmit={e => {
          e.preventDefault();
          void submit();
        }}
      >
        <input value={username} onChange={e => (setUsername(e.target.value), setResult(null))} placeholder="You can add friends with their Vokko username." aria-label="Username" autoFocus />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!username.trim() || busy}>
          Send Friend Request
        </button>
      </form>
      {result && <p className={`add-friend-result ${result.ok ? "success" : "error"}`}>{result.text}</p>}
      <FriendSuggestionsTab embedded />
    </div>
  );
}

function ActiveNow() {
  const relationships = useStore(s => s.relationships);
  const presences = useStore(s => s.presences);
  const channels = useStore(s => s.channels);
  const guilds = useStore(s => s.guilds);
  const voice = useVoice(s => s.states);
  const active = useMemo(() => activeFriends(relationships, presences, voice, channels, guilds), [relationships, presences, voice, channels, guilds]);
  return (
    <aside className="active-now" aria-label="Active Now">
      <h2>Active Now</h2>
      {active.length === 0 ? (
        <div className="active-now-empty">
          <div className="active-now-empty-title">Nothing going on yet</div>
          <div className="active-now-empty-text">Friends who jump into a voice channel or start a game will appear in this column.</div>
        </div>
      ) : (
        active.map(e => <ActiveCard key={e.relationship.id} entry={e} />)
      )}
    </aside>
  );
}

function ActiveCard({ entry }: { entry: ActiveEntry }) {
  const { relationship } = entry;
  return (
    <div className="active-card">
      <button type="button" className="active-card-main" onClick={() => void openDirectMessage(relationship.id)}>
        <Avatar user={relationship.user} size={32} status />
        <span className="active-card-text">
          <span className="active-card-name">{displayName(relationship.user)}</span>
          {!entry.activity && <span className="active-card-sub">{entry.text}</span>}
          {entry.activity && <ActivityLine activity={entry.activity} className="active-card-sub" />}
        </span>
        {(entry.voice || entry.activity) && (
          <span className={`active-card-icon ${entry.voice ? "active-card-voice" : "active-card-game"}`} aria-hidden="true">
            {entry.voice ? <Volume2 size={16} /> : entry.activity?.type === 2 ? <BrandIcon icon={siSpotify} size={16} /> : <Gamepad2 size={16} />}
          </span>
        )}
      </button>
      {entry.channel && entry.guild && <VoiceRow channel={entry.channel} guild={entry.guild} />}
      {entry.activity && <ActiveBody activity={entry.activity} user={relationship.user} />}
      {entry.channel && !entry.guild && <VoiceDetails channel={entry.channel} />}
    </div>
  );
}

/** The game under the header, a button that opens the friend's profile card: placeholder art (no asset source), its name and a live elapsed clock. */
function ActiveBody({ activity, user }: { activity: Activity; user: User }) {
  const now = useNow(1000);
  const start = activity.timestamps?.start;
  const spotify = activity.type === 2;
  return (
    <button type="button" className="active-card-body" aria-label={`${activity.name}, ${displayName(user)}'s profile`} onClick={e => openProfile(e.currentTarget, user.id, null)}>
      {spotify ? (
        <SpotifyArt activity={activity} className="active-card-art" />
      ) : (
        <span className="active-card-art" aria-hidden="true">
          <Gamepad2 size={20} />
        </span>
      )}
      <span className="active-card-body-text">
        <span className="active-card-title">{spotify ? (activity.details ?? "Spotify") : activity.name}</span>
        {spotify ? (
          activity.state && <span className="active-card-body-sub">by {activity.state}</span>
        ) : start ? (
          <span className="active-card-body-sub">{formatClock(start, now)} elapsed</span>
        ) : null}
      </span>
    </button>
  );
}

const MAX_FACES = 6;
const ROW_FACES = 3;

/** The voice channel of a server we share, always visible under the header: server icon with a speaker badge, the channel, the
 *  server and who is in it. Clicking it joins, as Join Voice in the unfolding details does. */
function VoiceRow({ channel, guild }: { channel: Channel; guild: Guild }) {
  const states = useChannelVoiceStates(channel.id);
  const users = useStore(s => s.users);
  const inside = useVoice(s => s.channelId === channel.id);
  const guildId = guild.id;
  const people = states.map(state => users[state.user_id]).filter(user => user !== undefined);
  return (
    <button
      type="button"
      className="active-card-voice-row"
      aria-label={`${inside ? "Open" : "Join"} ${channel.name ?? "voice"} · ${guild.name}, ${states.length} in voice`}
      onClick={() => {
        if (!inside) joinVoiceChannel(channel);
        go(guildPath(guildId, channel.id));
      }}
    >
      <span className="active-card-voice-guild">
        <GuildIcon guild={guild} size={32} />
        <span className="active-card-voice-badge" aria-hidden="true">
          <Volume2 size={10} />
        </span>
      </span>
      <span className="active-card-body-text">
        <span className="active-card-title">{channel.name ?? "Voice"}</span>
        <span className="active-card-body-sub">{guild.name}</span>
      </span>
      <span className="active-card-faces active-card-voice-faces" aria-hidden="true">
        {people.slice(0, ROW_FACES).map(user => (
          <span key={user.id} className="active-card-face">
            <Avatar user={user} size={24} />
          </span>
        ))}
        {states.length > ROW_FACES && <span className="active-card-face-more">+{states.length - ROW_FACES}</span>}
      </span>
    </button>
  );
}

/** Voice card extras, unfolding on hover or keyboard focus (as on Discord): a button with the channel, server and who is in it that
 *  opens the channel without joining, next to Join. DM calls have no server to open: plain faces, and no Join (answering one goes
 *  through the call UI of the DM). */
function VoiceDetails({ channel }: { channel: Channel }) {
  const states = useChannelVoiceStates(channel.id);
  const users = useStore(s => s.users);
  const guild = useStore(s => (channel.guild_id ? s.guilds[channel.guild_id] : undefined));
  const inside = useVoice(s => s.channelId === channel.id);
  const people = states.map(state => users[state.user_id]).filter(user => user !== undefined);
  const guildId = channel.guild_id;
  const join = () => {
    if (inside || !guildId) return;
    joinVoiceChannel(channel);
    go(guildPath(guildId, channel.id));
  };
  const faces = (
    <span className="active-card-faces">
      {people.slice(0, MAX_FACES).map(user => (
        <Tooltip key={user.id} content={displayName(user)}>
          <span className="active-card-face" aria-hidden="true">
            <Avatar user={user} size={24} />
          </span>
        </Tooltip>
      ))}
      {states.length > MAX_FACES && <span className="active-card-face-more">+{states.length - MAX_FACES} more</span>}
    </span>
  );
  return (
    <div className="active-card-more">
      <div className="active-card-more-inner">
        <div className="active-card-more-row">
          {guildId ? (
            <button type="button" className="active-card-channel" onClick={() => go(guildPath(guildId, channel.id))}>
              {/* the place is in the name only: the header line above already shows it, so it is not repeated on screen */}
              <span className="sr-only">{`Open ${channel.name ?? "voice"}${guild ? ` · ${guild.name}` : ""}, ${states.length} in voice`}</span>
              {faces}
            </button>
          ) : (
            <div className="active-card-channel" role="group" aria-label={`${states.length} in voice`}>
              {faces}
            </div>
          )}
          {guildId && (
            // aria-disabled, not disabled: a focused button that becomes disabled drops focus and folds the card
            <button type="button" className="btn btn-sm active-card-join" aria-disabled={inside} onClick={join}>
              {inside ? "Joined" : "Join Voice"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function FriendsPage() {
  const [tab, setTab] = useState<Tab>("online");
  const [query, setQuery] = useState("");
  const relationships = useStore(s => Object.values(s.relationships));
  const presences = useStore(s => s.presences);
  const pendingCount = relationships.filter(r => r.type === RelationshipType.IncomingRequest).length;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (r: Relationship) => !q || displayName(r.user).toLowerCase().includes(q) || r.user.username.includes(q);
    const byName = (a: Relationship, b: Relationship) => displayName(a.user).localeCompare(displayName(b.user), undefined, { sensitivity: "base" });
    const friends = relationships.filter(r => r.type === RelationshipType.Friend && match(r)).sort(byName);
    const online = friends.filter(r => (presences[r.id]?.status ?? "offline") !== "offline");
    const incoming = relationships.filter(r => r.type === RelationshipType.IncomingRequest && match(r)).sort(byName);
    const outgoing = relationships.filter(r => r.type === RelationshipType.OutgoingRequest && match(r)).sort(byName);
    const blocked = relationships.filter(r => r.type === RelationshipType.Blocked && match(r)).sort(byName);
    return { friends, online, incoming, outgoing, blocked };
  }, [relationships, presences, query]);

  const list = (title: string, items: Relationship[], mode: "friend" | "incoming" | "outgoing" | "blocked") =>
    items.length > 0 && (
      <section key={title}>
        <h2 className="people-title">
          {title} — {items.length}
        </h2>
        <ul className="people-list">
          {items.map(r => (
            <PersonRow key={r.id} relationship={r} mode={mode} />
          ))}
        </ul>
      </section>
    );

  const empty = (text: string) => (
    <div className="people-empty">
      <svg width="96" height="72" viewBox="0 0 96 72" fill="none" aria-hidden="true">
        <rect x="6" y="10" width="54" height="36" rx="12" fill="var(--background-mod-subtle)" />
        <path d="M18 46l-6 12 16-12z" fill="var(--background-mod-subtle)" />
        <rect x="36" y="26" width="54" height="36" rx="12" fill="var(--background-mod-normal)" />
        <path d="M78 62l6 8-16-8z" fill="var(--background-mod-normal)" />
        <circle cx="52" cy="44" r="3" fill="var(--interactive-icon-default)" />
        <circle cx="63" cy="44" r="3" fill="var(--interactive-icon-default)" />
        <circle cx="74" cy="44" r="3" fill="var(--interactive-icon-default)" />
      </svg>
      <span>{text}</span>
    </div>
  );

  return (
    <div className="friends-page">
      <div className="friends-main">
        <header className="friends-header">
          <NavToggle />
          <div className="friends-title">
            <Users size={20} />
            <h1>Friends</h1>
          </div>
          <span className="friends-dot" />
          <div className="friends-tabs" role="tablist">
            {TABS.map(t => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`friends-tab${tab === t.id ? " selected" : ""}`} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === "pending" && pendingCount > 0 && <span className="count-badge">{pendingCount}</span>}
              </button>
            ))}
            <button type="button" role="tab" aria-selected={tab === "add"} className={`friends-tab add-friend-tab${tab === "add" ? " selected" : ""}`} onClick={() => setTab("add")}>
              Add Friend
            </button>
          </div>
          <div className="friends-toolbar">
            <Tooltip content="New Group DM" side="bottom">
              <button type="button" className="toolbar-button" aria-label="New Group DM" onClick={() => openModal({ type: "createDM" })}>
                <MessageCircle size={20} />
              </button>
            </Tooltip>
          </div>
        </header>
        {tab === "add" ? (
          <AddFriend />
        ) : tab === "suggestions" ? (
          <div className="people-column">
            <div className="people-scroller">
              <FriendSuggestionsTab />
            </div>
          </div>
        ) : (
          <div className="people-column">
            <label className="people-search">
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search" aria-label="Search" />
              <Search size={20} />
            </label>
            <div className="people-scroller">
              {tab === "online" && (rows.online.length > 0 ? list("Online", rows.online, "friend") : empty("No one's around to hang out with right now."))}
              {tab === "all" && (rows.friends.length > 0 ? list("All friends", rows.friends, "friend") : empty("You don't have any friends yet. Use Add Friend to send a request."))}
              {tab === "pending" &&
                (rows.incoming.length + rows.outgoing.length > 0 ? (
                  <>
                    {list("Incoming", rows.incoming, "incoming")}
                    {list("Outgoing", rows.outgoing, "outgoing")}
                  </>
                ) : (
                  empty("There are no pending friend requests. Click Add Friend to send requests.")
                ))}
              {tab === "blocked" && (rows.blocked.length > 0 ? list("Blocked", rows.blocked, "blocked") : empty("You haven't blocked anyone."))}
            </div>
          </div>
        )}
      </div>
      <ActiveNow />
    </div>
  );
}
