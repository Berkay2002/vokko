import { useCallback, useEffect, useState } from "react";
import { UserPlus, X } from "lucide-react";
import { RelationshipType, type FriendSuggestion, type FriendSuggestionsResponse, type FriendSuggestionSettings } from "../api/types";
import { errorText } from "./errors";
import { commonText } from "./suggestionText";
import { Avatar, SwitchRow, Tooltip, displayName, request, useStore } from "./shell";

function Row({ suggestion, onAdd, onIgnore, sent, busy }: { suggestion: FriendSuggestion; onAdd(): void; onIgnore(): void; sent: boolean; busy: boolean }) {
  const guildNames = useStore(s => suggestion.mutual_guilds.map(g => s.guilds[g.id]?.name).filter((name): name is string => !!name));
  const user = suggestion.user;
  return (
    <li className="people-row cm-suggestion">
      <Avatar user={user} size={32} />
      <div className="people-text">
        <div className="people-name">
          {displayName(user)}
          <span className="people-handle">{user.username}</span>
        </div>
        <div className="people-sub">{commonText(suggestion.mutual_friends_count, guildNames)}</div>
      </div>
      <div className="cm-suggestion-actions">
        <button type="button" className="btn btn-sm" disabled={sent || busy} onClick={onAdd}>
          <UserPlus size={16} aria-hidden="true" />
          {sent ? "Request Sent" : "Add Friend"}
        </button>
        <Tooltip content="Ignore" side="top">
          <button type="button" className="people-action danger" aria-label={`Ignore ${displayName(user)}`} disabled={busy} onClick={onIgnore}>
            <X size={18} />
          </button>
        </Tooltip>
      </div>
    </li>
  );
}

/**
 * The Friends page "Suggestions" tab: people you may know, plus the switch that opts you out of the feature.
 * `embedded` (under Add Friend) shows just the list, and nothing at all while there is nothing to suggest.
 */
export function FriendSuggestionsTab({ embedded = false }: { embedded?: boolean }) {
  const [data, setData] = useState<FriendSuggestionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const relationships = useStore(s => s.relationships);

  const load = useCallback(() => {
    request<FriendSuggestionsResponse>("GET", "/users/@me/friend-suggestions?limit=50")
      .then(response => {
        setData(response);
        setError(null);
      })
      .catch(e => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  const act = async (id: string, action: () => Promise<unknown>, after?: () => void) => {
    setBusy(id);
    try {
      await action();
      after?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const setEnabled = (enabled: boolean) =>
    void act("settings", () => request<FriendSuggestionSettings>("PATCH", "/users/@me/friend-suggestion-settings", { enabled }), load);

  // Anyone who became a friend or got a request in the meantime is no longer a suggestion.
  const visible = (data?.suggestions ?? []).filter(s => {
    const type = relationships[s.user.id]?.type;
    return type === undefined || (type === RelationshipType.OutgoingRequest && sent.has(s.user.id));
  });

  if (embedded && (!data?.enabled || visible.length === 0)) return null;
  return (
    <div className={`cm-suggestions${embedded ? " embedded" : ""}`}>
      {!embedded && (
        <SwitchRow
          label="Show me in friend suggestions"
          note="When this is on, people who share a small server or friends with you can be suggested to each other. Turn it off to stop seeing suggestions and to stop appearing in other people's."
          checked={data?.enabled ?? true}
          disabled={data === null || busy === "settings"}
          onChange={setEnabled}
        />
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {data === null && !error && <div className="people-empty">Looking for people you may know…</div>}
      {data && !data.enabled && <div className="people-empty">Friend suggestions are off. Turn them on to see people you may know.</div>}
      {data?.enabled && visible.length === 0 && <div className="people-empty">No suggestions right now. Join a server or add a few friends and check back.</div>}
      {data?.enabled && visible.length > 0 && (
        <section>
          <h2 className="people-title">{embedded ? "People you may know" : "Suggested for you"} — {visible.length}</h2>
          <ul className="people-list">
            {visible.map(suggestion => (
              <Row
                key={suggestion.user.id}
                suggestion={suggestion}
                sent={sent.has(suggestion.user.id)}
                busy={busy === suggestion.user.id}
                onAdd={() => void act(suggestion.user.id, () => request<void>("PUT", `/users/@me/relationships/${suggestion.user.id}`, {}), () => setSent(prev => new Set(prev).add(suggestion.user.id)))}
                onIgnore={() =>
                  void act(suggestion.user.id, () => request<void>("DELETE", `/users/@me/friend-suggestions/${suggestion.user.id}`), () =>
                    setData(current => (current ? { ...current, suggestions: current.suggestions.filter(s => s.user.id !== suggestion.user.id) } : current)),
                  )
                }
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
