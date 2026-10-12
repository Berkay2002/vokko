import { useState } from "react";
import { Gamepad2, ImagePlus, Plus, X } from "lucide-react";
import { useStore } from "../api/store";
import type { User } from "../api/types";
import { useContextMenu } from "../ui";
import { InVoiceCard, useVoice } from "../voice";
import type { ProfileDraft, Scope } from "./draft";
import { useImageUpload } from "./upload";
import { GAMES_MAX, GAME_NAME_MAX, REASON_MAX, TAGS_MAX, TAG_MAX, clip, normaliseTags, validateWidgets, type FavoriteDraft, type GameDraft, type WidgetImage, type WidgetsDraft } from "./widgets";

type Tab = "board" | "activity";

function GameThumb({ game, size = 64 }: { game: GameDraft; size?: number }) {
  return game.image ? (
    <img className="pe-game-img" src={game.image.url} alt="" width={size} height={size} draggable={false} />
  ) : (
    <span className="pe-game-img pe-game-fallback" style={{ width: size, height: size }} aria-hidden="true">
      <Gamepad2 size={size / 2} />
    </span>
  );
}

/** Image picker button of one widget entry. */
function ImageButton({ channel, label, image, onChange }: { channel: string | null; label: string; image: WidgetImage | null; onChange(next: WidgetImage | null): void }) {
  const upload = useImageUpload(channel);
  return (
    <div className="pe-inline">
      <button type="button" className="btn btn-secondary btn-sm" disabled={upload.busy || !channel} onClick={upload.choose}>
        <ImagePlus size={14} /> {upload.busy ? "Uploading…" : image ? `Change ${label}` : `Add ${label}`}
      </button>
      {image && (
        <button type="button" className="btn btn-link btn-sm" onClick={() => onChange(null)}>
          Remove
        </button>
      )}
      <input ref={upload.inputRef} type="file" accept="image/*" hidden onChange={e => void upload.pick(e.target.files?.[0]).then(file => file && onChange(file))} />
      {upload.error && <p className="pe-field-error">{upload.error}</p>}
    </div>
  );
}

function FavoriteGame({ value, onChange, onRemove, channel }: { value: FavoriteDraft; onChange(next: FavoriteDraft): void; onRemove(): void; channel: string | null }) {
  const [tagText, setTagText] = useState("");
  const addTag = () => {
    const next = normaliseTags([...value.tags, ...tagText.split(",")]).slice(0, TAGS_MAX);
    onChange({ ...value, tags: next });
    setTagText("");
  };
  return (
    <section className="pe-widget" aria-label="Favourite game">
      <header className="pe-widget-head">
        <div>
          <h3>Favourite game</h3>
          <p>{value.name.trim() ? "Tell people why you love it" : "Pick a game"}</p>
        </div>
        <button type="button" className="pe-icon-btn" aria-label="Remove favourite game widget" onClick={onRemove}>
          <X size={16} />
        </button>
      </header>
      <div className="pe-widget-body">
        <GameThumb game={value} size={96} />
        <div className="pe-widget-fields">
          <input className="input" aria-label="Favourite game name" placeholder="Game name" value={value.name} onChange={e => onChange({ ...value, name: clip(e.target.value, GAME_NAME_MAX) })} />
          <input className="input" aria-label="Why it's your favourite" placeholder="Tell everyone why this is your favourite" value={value.reason} onChange={e => onChange({ ...value, reason: clip(e.target.value, REASON_MAX) })} />
          <div className="pe-tags">
            {value.tags.map(tag => (
              <span key={tag} className="pe-tag">
                {tag}
                <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange({ ...value, tags: value.tags.filter(t => t !== tag) })}>
                  <X size={12} />
                </button>
              </span>
            ))}
            {value.tags.length < TAGS_MAX && (
              <input
                className="pe-tag-input"
                aria-label="Add a tag"
                placeholder="+ tags"
                value={tagText}
                onChange={e => setTagText(clip(e.target.value, TAG_MAX))}
                onKeyDown={e => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                onBlur={() => tagText.trim() && addTag()}
              />
            )}
          </div>
          <ImageButton channel={channel} label="image" image={value.image} onChange={image => onChange({ ...value, image })} />
        </div>
      </div>
    </section>
  );
}

function GamesILike({ games, onChange, onRemove, channel }: { games: GameDraft[]; onChange(next: GameDraft[]): void; onRemove(): void; channel: string | null }) {
  const [adding, setAdding] = useState<GameDraft | null>(null);
  const commit = () => {
    if (adding && adding.name.trim()) onChange([...games, { ...adding, name: adding.name.trim() }]);
    setAdding(null);
  };
  return (
    <section className="pe-widget" aria-label="Games I like">
      <header className="pe-widget-head">
        <div>
          <h3>Games I like</h3>
          <p>
            {games.length} of {GAMES_MAX} games
          </p>
        </div>
        <div className="pe-inline">
          <button type="button" className="pe-icon-btn" aria-label="Add a game" disabled={games.length >= GAMES_MAX || !!adding} onClick={() => setAdding({ name: "", image: null })}>
            <Plus size={16} />
          </button>
          <button type="button" className="pe-icon-btn" aria-label="Remove games I like widget" onClick={onRemove}>
            <X size={16} />
          </button>
        </div>
      </header>
      {adding && (
        <div className="pe-add-game">
          <input
            className="input"
            aria-label="Game name"
            placeholder="Game name"
            autoFocus
            value={adding.name}
            onChange={e => setAdding({ ...adding, name: clip(e.target.value, GAME_NAME_MAX) })}
            onKeyDown={e => {
              if (e.key === "Enter") commit();
            }}
          />
          <ImageButton channel={channel} label="image" image={adding.image} onChange={image => setAdding({ ...adding, image })} />
          <div className="pe-inline">
            <button type="button" className="btn btn-primary btn-sm" disabled={!adding.name.trim()} onClick={commit}>
              Add game
            </button>
            <button type="button" className="btn btn-link btn-sm" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <ul className="pe-games">
        {games.map((game, index) => (
          <li key={`${index}:${game.name}`} className="pe-game" title={game.name}>
            <GameThumb game={game} />
            <span className="pe-game-name">{game.name}</span>
            <button type="button" className="pe-game-remove" aria-label={`Remove ${game.name}`} onClick={() => onChange(games.filter((_, i) => i !== index))}>
              <X size={12} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Board({ scope, widgets, onChange, channel }: { scope: Scope; widgets: WidgetsDraft; onChange(next: WidgetsDraft): void; channel: string | null }) {
  const menu = useContextMenu();
  // "Games I like" stays on the board while it has no game yet, once it was added from the menu.
  const [gamesAdded, setGamesAdded] = useState(false);
  const locked = scope.kind === "guild";
  const problem = validateWidgets(widgets);
  const showGames = widgets.games.length > 0 || gamesAdded;
  const empty = !widgets.favorite && !showGames;
  const addMenu = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    menu.open({ clientX: rect.right - 200, clientY: rect.bottom + 4 }, [
      { id: "widget-favourite", label: "Favourite game", disabled: !!widgets.favorite, onSelect: () => onChange({ ...widgets, favorite: { name: "", image: null, reason: "", tags: [] } }) },
      { id: "widget-games", label: "Games I like", disabled: widgets.games.length > 0 || gamesAdded, onSelect: () => setGamesAdded(true) },
    ]);
  };
  return (
    <div className="pe-board">
      <div className="pe-board-head">
        <h2>Your widgets</h2>
        <button type="button" className="btn btn-secondary btn-sm" disabled={locked} aria-haspopup="menu" onClick={addMenu}>
          <Plus size={14} /> Add widget
        </button>
      </div>
      {locked && <p className="pe-note">Widgets are part of your main profile.</p>}
      <fieldset className="pe-widgets" disabled={locked}>
        {empty && <p className="pe-empty">No widgets yet. Add a favourite game or a list of games you like.</p>}
        {widgets.favorite && <FavoriteGame value={widgets.favorite} channel={channel} onChange={favorite => onChange({ ...widgets, favorite })} onRemove={() => onChange({ ...widgets, favorite: null })} />}
        {showGames && (
          <GamesILike
            games={widgets.games}
            channel={channel}
            onChange={games => onChange({ ...widgets, games })}
            onRemove={() => {
              setGamesAdded(false);
              onChange({ ...widgets, games: [] });
            }}
          />
        )}
      </fieldset>
      {problem && <p className="pe-field-error">{problem}</p>}
    </div>
  );
}

function Activity({ user }: { user: User }) {
  const presence = useStore(s => s.presences[user.id]);
  const voice = useVoice(s => !!s.states[user.id]?.channel_id);
  const status = presence?.custom_status;
  return (
    <div className="pe-activity">
      <h2>Activity</h2>
      {status && (
        <div className="pe-activity-card">
          <span className="pe-activity-kind">Custom status</span>
          <span>{status}</span>
        </div>
      )}
      <InVoiceCard userId={user.id} />
      {!status && !voice && <p className="pe-empty">Nothing to show right now. What you are doing in Vokko appears here.</p>}
    </div>
  );
}

export interface RightColumnProps {
  user: User;
  scope: Scope;
  draft: ProfileDraft;
  setDraft(patch: Partial<ProfileDraft>): void;
  uploadChannel: string | null;
}

export function RightColumn({ user, scope, draft, setDraft, uploadChannel }: RightColumnProps) {
  const [tab, setTab] = useState<Tab>("board");
  return (
    <aside className="pe-right" aria-label="Profile board">
      <div className="pe-tabs" role="tablist" aria-label="Profile sections">
        {(["board", "activity"] as const).map(id => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`pe-tab${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
            {id === "board" ? "Board" : "Activity"}
          </button>
        ))}
      </div>
      <div className="pe-right-body" role="tabpanel">
        {tab === "board" ? (
          <Board scope={scope} widgets={draft.widgets} channel={uploadChannel} onChange={widgets => setDraft({ widgets })} />
        ) : (
          <Activity user={user} />
        )}
      </div>
    </aside>
  );
}
