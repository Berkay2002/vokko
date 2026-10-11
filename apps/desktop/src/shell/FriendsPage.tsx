import { useMemo, useState } from "react";
import { NavToggle } from "./NavToggle";
import { Check, MessageCircle, MoreVertical, Search, Users, X } from "lucide-react";
import { ApiRequestError } from "../api/errors";
import { request } from "../api/rest";
import { displayName, useStore } from "../api/store";
import { RelationshipType, type Relationship } from "../api/types";
import { Tooltip, useContextMenu } from "../ui";
import { FriendSuggestionsTab } from "../community";
import { Avatar } from "./Avatar";
import { copyText, openDirectMessage } from "./actions";
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
          ...(mode === "friend" ? [{ id: "remove", label: "Remove Friend", danger: true, onSelect: () => openModal({ type: "removeFriend", userId: user.id }) }] : []),
          { id: "copy", label: "Copy User ID", onSelect: () => copyText(user.id) },
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
  const active = useStore(s => Object.values(s.relationships).filter(r => r.type === RelationshipType.Friend && s.presences[r.id]?.custom_status));
  return (
    <aside className="active-now" aria-label="Active Now">
      <h2>Active Now</h2>
      {active.length === 0 ? (
        <div className="active-now-empty">
          <div className="active-now-empty-title">It&apos;s quiet for now...</div>
          <div className="active-now-empty-text">When a friend starts an activity, like playing a game or hanging out on voice, we&apos;ll show it here!</div>
        </div>
      ) : (
        active.map(r => <ActiveCard key={r.id} relationship={r} />)
      )}
    </aside>
  );
}

function ActiveCard({ relationship }: { relationship: Relationship }) {
  const custom = useStore(s => s.presences[relationship.id]?.custom_status);
  return (
    <button type="button" className="active-card" onClick={() => void openDirectMessage(relationship.id)}>
      <Avatar user={relationship.user} size={32} status />
      <span className="active-card-text">
        <span className="active-card-name">{displayName(relationship.user)}</span>
        <span className="active-card-sub">{custom}</span>
      </span>
    </button>
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
