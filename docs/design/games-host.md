# Games host (Activities) design

Status: design, 2026-10-17. Owner request: any web game runs inside a Vokko call in a sandboxed frame, shared by the people
in the call, launched from the call bar's Activities menu next to Watch Together, Stremio and Spotify, and games can be added
without shipping a new app. One small first-party game proves the SDK. Decisions marked **(default, owner may change)** were
picked so the build could start; section 12 lists them as open questions.

## 1. Findings

- **Watch Together is the template.** `crates/server/src/voice/watch.rs:26-28` is a REST trio (`PUT|PATCH|DELETE
  /channels/{id}/watch-together`), the session lives in memory per channel (`voice/state.rs:129`, `watch_update` at :174), and
  every change is broadcast as `WATCH_TOGETHER_UPDATE` to everyone who can see the channel (`watch.rs:196-200`). It ends when the
  last person leaves voice (`voice/state.rs:659`). READY / GUILD_CREATE carry the sessions (`events.rs:17`, `watch_in`), DM calls
  through CALL_CREATE (`voice/state.rs:400`).
- **Voice gate to reuse:** `watch.rs:82-94` `require_in_voice` re-runs the voice join checks (in voice now, VIEW_CHANNEL +
  CONNECT, not timed out, DM recipient, not a stage). Control writes are limited with `state.limiter.check_key` (`watch.rs:96-100`,
  burst 10, 2/s); `ratelimit.rs:221` adds per-resource buckets shared by all callers.
- **Title hygiene:** `watch.rs:43-66` `hidden_char` rejects controls, zero-width, bidi and filler characters. Reuse it for game names.
- **Gateway fan-out costs replay space.** `hub.rs:1-5`: every dispatched event enters a bounded per-session replay buffer and a
  bounded queue; a slow reader is detached (1013) and resumes from the buffer, and a gap forces a fresh READY. A high-rate relay
  through the normal hub would evict real events. The relay therefore needs a per-channel aggregate cap (section 5).
- **Desktop embed precedent:** `apps/desktop/src/watch/embed.ts:31-50` already does the right receive checks for a frame
  (`event.source === frame`, exact `event.origin`, a `source` tag, a typed parser per message). The games host copies that shape.
- **Activities menu:** `apps/desktop/src/voice/VoiceChannelPage.tsx:279-290` (a `menu.open` list with Watch Together and Stremio).
  The empty-call "Choose Activity" button is a disabled stub (`VoiceChannelPage.tsx:355-359`, also `VoiceConnectionPanel.tsx:266`).
  Extra grid tiles are added at `VoiceChannelPage.tsx:80-81` (`WATCH_TILE_ID`, `STREMIO_TILE_ID`).
- **CSP today:** dev `apps/desktop/src-tauri/tauri.conf.json:15` has `frame-src 'self' http://127.0.0.1:8710 http://localhost:8710`;
  the packaged build `apps/desktop/release.production.json:5` has `frame-src https://vokko.example.com http://127.0.0.1:8710
  http://localhost:8710` (no `'self'`). The web build sends **no CSP at all**: `deploy/Caddyfile:38-43` serves `/srv` with no header.
- **"One media activity per channel"** (`docs/design/spotify-bot.md` section 2.2, on main): Stremio and Spotify exclude each other
  with a 409 because each client keeps exactly one media LiveKit `Room`; Watch Together (client side) is allowed next to either.
- **e2e:** `apps/desktop/playwright.config.ts` runs mock mode (in-browser backend `src/api/mock/`, one page) by default and
  `VOKKO_REAL=1` against a real server for `real*.spec.ts`. The mock has a Watch Together twin (`src/api/mock/watch.ts:56-106`).
- **No secret for app ids yet:** `crypto.rs` holds `VOKKO_SECRETS_KEY` for sealing; an HMAC key for app-scoped ids can be derived
  from it (HKDF label `vokko games app-id v1`) so no new setting is needed.

## 2. Decisions

1. **One game session per call**, server-held in memory like Watch Together, broadcast as `GAME_UPDATE`. Games are client-side
   activities, so a game may run next to Watch Together, Stremio or Spotify; it does not count as "the media activity" (it holds
   no LiveKit room). A second game replaces nothing: `PUT` while one runs returns 409 `40090` "A game is already running".
2. **Catalog = built-ins + a per-server allow-list** managed by members with MANAGE_GUILD. DM calls get built-ins only.
   No instance-wide catalog in v1 **(default, owner may change)**.
3. **Relay through the server**: REST `POST` in, gateway `GAME_MESSAGE` out, to people in that call only. Not the LiveKit data
   channel (section 5).
4. **Frame isolation by origin.** Third-party games load from their own https origin with `allow-scripts allow-same-origin`.
   First-party games ship inside the app under `/games/<id>/` and load with `allow-scripts` only, so their origin is opaque
   (`"null"`), never the app's. A separate `games.` host for first-party games is not needed in v1 **(default, owner may change)**.
5. **The game talks over a `MessagePort`**, handed over once after an origin-checked hello. Nothing reaches the game except what
   section 4 lists: no tokens, cookies, Vokko user ids, channel ids or API access.
6. **Control (until bot-control lands):** anyone in the call can start a game; the starter, or in a guild a member with
   MANAGE_CHANNELS on that channel, can stop it; it also ends when the last person leaves voice. In a DM call anyone in the call can
   stop it. The routes call one `can_stop(state, user, channel, session)` helper so `vokko-design-botcontrol` can replace the rule.
7. **First-party game: Sketch** (draw and guess): the leader picks a word, draws, others guess in a side list. It exercises the
   relay at real rates (batched strokes) and needs no server state. Trivia is skipped (needs a question bank).
8. **Icons are an emoji or nothing** in v1 (admins type one emoji; fallback is the first letter on a tinted tile). Remote icon URLs
   would need `img-src` for arbitrary hosts **(default, owner may change)**.

## 3. Architecture

```
 call bar Activities ──► GamePicker (built-ins + GET /guilds/{g}/games)
                                │ PUT /channels/{c}/game {game_id}
 server voice/games.rs ── GAME_UPDATE {channel_id, state} ──► every client that sees the channel
                                │
 client GameTile (grid tile) ─ <iframe sandbox src=manifest.url> ─ MessagePort ─ game (vokko-games.js)
        │ game "send"  → POST /channels/{c}/game/messages {data, to?}
        └ GAME_MESSAGE {channel_id, session_id, from, data} ◄── server fans out to users in that call
```

- Server: `crates/server/src/voice/games.rs` (session, routes, relay, app ids), `crates/server/src/games.rs` (guild catalog CRUD),
  one migration `guild_games`. Protocol types in `crates/protocol/src/api.rs`.
- Desktop: `apps/desktop/src/games/` (catalog api, `GamePicker`, `GameTile`, `frameHost.ts` protocol host, `GamesSettings` for the
  server settings), `apps/desktop/public/games/vokko-games.js` (the SDK, plain ES module, `// @ts-check`),
  `public/games/sketch/` (first-party), `public/games/mock/` (e2e only, excluded from release by being a built-in only in MOCK).
- A participant who is in the call sees the game tile; opening (focusing) it loads the frame. Leaving the tile unloads the frame
  (`close` first). Viewers who are not in the call see "Game: Sketch" in the channel row, nothing more.

## 4. Manifests and catalog

Game manifest (server-validated; the same shape for built-ins, which are constants in `voice/games.rs` and `src/games/builtin.ts`):

```json
{ "id": "1234567890", "name": "Codenames Online", "url": "https://play.example.com/vokko/",
  "icon": "🕵️", "min_players": 2, "max_players": 8, "aspect": "16:9" }
```

- `id`: snowflake for guild games, `builtin:sketch` for built-ins. `name`: 1-32 chars, trimmed, no `hidden_char`.
- `url`: absolute, `https:` only (plus `http://127.0.0.1|localhost:*` when the server runs with `VOKKO_DEV=1`), no userinfo, no
  fragment, at most 512 bytes. Its origin must differ from the server's public origin and the web app origin (config
  `public_url`); rejected with `url` "Must not be this server's own address".
- `icon`: optional, one emoji grapheme (max 16 bytes, no `hidden_char`). `min_players` 1-16, `max_players` min-16. `aspect`:
  `"16:9" | "4:3" | "1:1" | "fill"`, default `"16:9"`.
- At most 25 games per guild. Routes (MANAGE_GUILD to write, any member to read):
  `GET /guilds/{id}/games` → `[GameManifest]`, `POST /guilds/{id}/games` → 201 manifest, `PATCH /guilds/{id}/games/{game_id}`,
  `DELETE /guilds/{id}/games/{game_id}` → 204 (ends running sessions of that game in the guild). Audit-log entries
  `GAME_ADD|UPDATE|REMOVE` (`audit.rs`), `GUILD_GAMES_UPDATE {guild_id}` to members so pickers refetch.
- UI: Server Settings > **Activities** page (`GamesSettings`): list with icon, name, origin, players; Add / Edit dialog
  (`FormDialog`) with the fields above and a warning line "This game runs code from <origin> in your members' calls."

## 5. Session and relay API

Protocol types (`api.rs`):

```rust
pub struct GameSession { pub session_id: String /* 16 hex */, pub game: GameManifest, pub started_by: Snowflake, pub started_at_ms: i64 }
pub struct GameUpdate { pub channel_id: Snowflake, pub state: Option<GameSession> }          // GAME_UPDATE, READY/GUILD_CREATE `games`, CALL_CREATE `game`
pub struct GameStartRequest { pub game_id: String }
pub struct GamePlayer { pub user_id: Snowflake, pub app_id: String }                         // app_id: 22-char base64url
pub struct GameRelayRequest { pub data: serde_json::Value, pub to: Option<String> /* app_id */ }
pub struct GameMessage { pub channel_id: Snowflake, pub session_id: String, pub from: String /* app_id */, pub data: serde_json::Value } // GAME_MESSAGE
pub const GAME_RELAY_MAX_BYTES: usize = 4096;
```

Routes (`voice/games.rs`), all behind `require_in_voice`:

| Route | Does | Errors |
|---|---|---|
| `PUT /channels/{id}/game` `{game_id}` | starts; 200 `GameSession`; `GAME_UPDATE` | 404 `10090` unknown game (not built-in, not in this guild's list, or a guild game in a DM); 409 `40090` a game is running |
| `GET /channels/{id}/game/players` | `[GamePlayer]` for everyone in this call now | 404 `10091` no game |
| `POST /channels/{id}/game/messages` `GameRelayRequest` | 204; `GAME_MESSAGE` to the call (sender excluded) or to one player | 404 `10091`; 400 `data` too large (> 4096 bytes serialized) / `to` unknown; 429 |
| `DELETE /channels/{id}/game` | 204 if `can_stop`; `GAME_UPDATE state:null` | 403 not the starter or an admin |

- **App id** = `base64url(HMAC-SHA256(k, game.id || ":" || origin || ":" || user_id))[..22]`, `k` derived from
  `VOKKO_SECRETS_KEY`, `origin` the manifest URL's origin ("builtin" for built-ins). Stable per game, origin and user, different
  across games and after a game's URL moves to another origin (editing a game's `url` ends its running sessions), so two games
  cannot join their data, and it never reveals the Vokko user id.
- **Recipients** = users with a voice state in that channel now (`voice/state.rs:233`), not every channel viewer.
- **Limits:** per user `check_key("game-relay")` burst 40, 20/s; per channel `check_resource(channel, "game-relay")` burst 60,
  30/s; start/stop share `check_key("game-control")` burst 5, 1/s. The per-channel cap bounds what a call adds to each member's
  replay buffer (`hub.rs` capacity) **(the numbers are default, owner may change)**. `shortcut: relay frames use the replayed
  hub path; add a volatile (unreplayed) send when relay traffic shows up in resume gaps.`
- **Why not the LiveKit data channel:** the voice backend can be LiveKit Cloud or the self-hosted media server (`voice/backends.rs`),
  the server could not cap size or rate, mute a spammer or check membership, and every client would need the data channel wired
  into the voice Room. The gateway path is about 40 lines of server code and works the same on every backend. Latency is one HTTP
  request plus a gateway push, fine for turn-based games and Sketch's 10 Hz stroke batches.
- Server-authoritative game state is out of scope for third-party games. First-party games may later get a server module.

## 6. SDK contract (`public/games/vokko-games.js`)

Handshake (window messages, the only ones on `window`):

1. Game → parent: `{ vokko: "hello", v: 1 }` with targetOrigin `"*"` (carries nothing).
2. Host accepts it only if `event.source === iframe.contentWindow` and `event.origin` equals the expected origin (manifest origin,
   or `"null"` for a built-in). It creates a `MessageChannel` and replies `{ vokko: "init", v: 1 }` to that origin (`"*"` for a
   built-in, which is the only possible target for an opaque origin) transferring `port2`. One port per frame load; a second hello
   is ignored until the frame reloads.

Then everything flows on the port. Host → game:

```ts
{ type: "init", game_id: string, me: Player, players: Player[], leader: string /* app_id */ }
{ type: "players", players: Player[], leader: string }        // on every join/leave
{ type: "message", from: string, data: Json }                 // relayed from another player
{ type: "error", code: "rate_limited" | "too_large" | "invalid" | "not_running" }
{ type: "close" }                                             // the frame is about to unload; game should stop sounds
type Player = { app_id: string; name: string /* display name, max 32 */; avatar: Blob | null /* 128 px PNG */ }
```

Game → host:

```ts
{ type: "ready" }                          // host swaps the loading cover for the frame
{ type: "send", data: Json, to?: string }  // relay; host validates size before POSTing
{ type: "close" }                          // close the tile for this user (does not end the session)
```

- The host parses every port message with a typed parser like `parseEmbedMessage` and drops anything else. Unknown types are
  ignored so the protocol can grow. `v` lets a future v2 coexist.
- `leader` = the starter's app id while they are in the call, else the smallest app id present. Games that need an authority
  (Sketch's word picker) use it; it is computed on the host from voice states, so all clients agree without server state.
- Late join: `players` is the call, not who has the frame open, so a game cannot detect a late opener. The recommended pattern
  (Sketch, `docs/games-sdk.md`): on connect the game broadcasts `sync?`; any copy that holds the public state answers with a
  chunked snapshot to the asker (first answer wins by round number); the joiner buffers live messages and replays them after
  the snapshot by sequence number. The joiner guesses in the current round and joins the drawer rotation from the next; the round's rules do not change.
- Avatars: the host fetches the avatar through its own API client and sends a `Blob` (structured clone), so no URL that embeds a
  user id reaches the game. No avatar → `null`.
- SDK surface (about 80 lines): `const vokko = await VokkoGames.connect(); vokko.me; vokko.players; vokko.leader;
  vokko.on("players"|"message"|"close", fn); vokko.send(data, to?); vokko.ready(); vokko.close();`. `connect()` rejects after 5 s
  without `init`, so the game can show "Open this inside Vokko".

## 7. Frame host

```html
<iframe src="{manifest.url}" title="{name} (game from {origin})"
  sandbox="allow-scripts allow-same-origin allow-pointer-lock"   <!-- third party; built-ins: "allow-scripts allow-pointer-lock" -->
  allow="" referrerpolicy="no-referrer" loading="lazy" credentialless></iframe>
```

- The sandbox string is a constant in `frameHost.ts`, chosen only by `isBuiltin(game)`. `allow-same-origin` is added only when the
  frame origin differs from `location.origin` and the API origin (checked again on the client; unit-tested). Never added:
  `allow-top-navigation*`, `allow-popups*`, `allow-modals`, `allow-forms` (games post over the SDK),
  `allow-downloads`, `allow-storage-access-by-user-activation`. `allow=""` delegates no camera, mic, geolocation, clipboard,
  fullscreen or autoplay.
- Below 767 px a focused game tile fills the stage and ignores `aspect`, so games must lay out for a tall frame too
  (Sketch switches to a portrait layout).
- A Vokko-drawn header strip above the frame always shows the game name, its origin (built-ins: "Vokko"), and Close / Stop.
  The frame never covers the call bar or other app chrome; it is clipped to its tile.
- **CSP:** dev and release `frame-src` gain `'self' https:` (`'self'` for built-ins, `https:` because admin-added origins are not
  known at build time; the app frames only URLs from manifests). `tauri.conf.json:15` already has `'self'`; release needs both.
  Web build: add a CSP header to `deploy/Caddyfile` matching release (with `frame-src 'self' https:` and
  `frame-ancestors 'none'`) **(default, owner may change; a deploy step)**. `[unverified]` WebView2 applies the app CSP's
  `script-src 'self'` inside the opaque built-in frame as the frame's URL origin; Phase 1 checks it in the packaged app.

## 8. Security review (threats and defenses)

| Hostile game tries | Defense |
|---|---|
| Read app state, cookies, tokens, localStorage | Third-party: different origin (same-origin policy). Built-in: opaque origin. Tokens live in the app's origin; nothing on the port carries one. |
| Call the Vokko API as the user | No credentials; server CORS allows only localhost/Tauri origins (`Caddyfile` comment, server CORS list); `credentialless` iframe. |
| Learn who people are across games / map to Vokko accounts | HMAC app ids per game; display name + avatar blob only; no user ids, usernames, channel or guild ids. |
| Phishing overlay ("session expired, log in") | Clipped to its tile, cannot draw over app chrome; header strip names the origin; only MANAGE_GUILD members can add games; warning in the add dialog. Residual: a game can still draw a fake form inside its tile. |
| Open windows, navigate the app, dialogs | No `allow-popups`, `allow-top-navigation`, `allow-modals`. Tauri main-window navigation guard stays as is. |
| Keylog the app | Frames only get key events while focused; the host never forwards input. Focus returns to the app on Escape (host listener on the tile). |
| Autoplay loud audio / camera / mic | `allow=""` (no autoplay delegation, no media devices); audio needs a click inside the frame; Close always one click away. |
| Spam the relay / flood other clients | 4 KB cap, per-user and per-channel buckets, recipients limited to the call, host-side size check, server 429s surfaced as `error`. |
| Send fake messages to the host from another frame/window | Hello accepted only from `iframe.contentWindow` with the expected origin; after that only the transferred port is trusted. |
| Navigate its frame elsewhere and keep the data feed | A new document has no port; a third-party navigation changes `event.origin`, so a new hello is refused. Residual (built-ins): a navigated opaque frame also reports `"null"`; built-ins render relay data only as text/canvas and contain no links. |
| Relay HTML/script to other players | Relay data is opaque JSON to the host; the host never renders it. Each game is responsible for its own rendering. |
| Hog CPU | Frame unloads when the tile closes; one game per call. Residual: a busy game can slow the user's webview while open. |
| Admin adds a URL on the server's own origin to get `allow-same-origin` there | Server rejects own-origin URLs; client re-checks before adding the flag. |

## 9. Fit with other activities and bot control

- Games are not media activities (no LiveKit room), so the Stremio/Spotify 409 does not apply; one game per call is its own rule.
- `can_stop` is the single hook for `vokko-design-botcontrol`: when it lands, start/stop of games uses the same "who controls
  activities" rule as the bots. Until then: section 2 item 6.

## 10. Test plan

- **Server (`cargo test -p vokko-server`, `tests/games.rs`)**: catalog CRUD + MANAGE_GUILD; URL validation table (http, own origin,
  userinfo, 513 bytes, bad emoji, name with U+202E); start needs voice; second start 409; DM rejects guild game; relay reaches only
  the call's members and not the sender; `to` delivers to one; 4097 bytes → 400; burst → 429; app id stable per game, differs across
  games and never contains the user id; stop by non-starter 403, by MANAGE_CHANNELS 204; last leave ends the session.
- **Desktop unit (vitest)**: `frameHost` parser (wrong source, wrong origin, bad shape, second hello), sandbox flag choice and the
  same-origin guard, leader computation, SDK `connect` timeout and message routing (`vokko-games.js` imported in jsdom),
  reducer for `GAME_UPDATE`, mock routes.
- **e2e mock (`e2e/games.spec.ts`)**: the mock seeds a second participant in the call and a built-in `builtin:mock` game
  (MOCK only, `public/games/mock/index.html`) that shows received messages and echoes `ping` with `pong`. The spec opens
  Activities, starts the mock game, sees the tile, sends `ping` from the game, sees the mock peer's `pong`, then posts a message
  from a second same-page iframe with a different origin and asserts the host ignored it (no relay request, counter unchanged).
  The guild Activities settings page adds and removes a game. Screenshots for the menu, the running game and the settings page.
- **e2e real (`e2e/real.games.spec.ts`, optional)**: two browser contexts in one call against a local server, relay both ways.
- Existing voice and Watch Together specs must still pass.

## 11. Build plan by file ownership

| Part | Owns | Notes |
|---|---|---|
| A. Server | `crates/protocol/src/api.rs` (game types, `GuildWithState.games`, ready/call fields), `crates/server/src/voice/games.rs`, `crates/server/src/games.rs`, migration, `routes/mod.rs`, `events.rs`, `gateway.rs` ready, `voice/state.rs` (session map + end on last leave), `audit.rs`, `docs/api.md`, `crates/server/tests/games.rs` | only part that runs cargo |
| B. Desktop host | `apps/desktop/src/games/**`, Activities entry + tile in `voice/VoiceChannelPage.tsx` (additive), `voice/reducer.ts` + `engine.ts` for GAME_UPDATE/GAME_MESSAGE, server settings nav entry, mock `src/api/mock/games.ts`, CSP in `tauri.conf.json` and `release.production.json`, `e2e/games.spec.ts` | copies the protocol types by hand into `api/types` as the repo does |
| C. SDK + games | `apps/desktop/public/games/vokko-games.js`, `public/games/sketch/**`, `public/games/mock/**`, `docs/games-sdk.md`, SDK vitest | B and C agree on section 6 only |

A and C start together; B starts with them against section 5/6 and the mock. Deploy needs: release CSP rebuild, Caddyfile CSP
header for the web build. No DNS or new hosts.

## 12. Open questions for the owner (each has a default in this doc)

1. Catalog: per-server allow-list (default) or also an instance-wide catalog that the instance owner curates?
2. First-party games in the app bundle with an opaque origin (default) or on their own host such as `games.example.com`?
3. Who can stop a game before bot-control: starter or MANAGE_CHANNELS (default), or anyone in the call?
4. Icons: emoji only (default) or uploaded images stored like app icons?
5. Relay limits: 4 KB, 20/s per user, 30/s per call (default)?
6. Add a CSP header to the web build's Caddyfile now (default yes)?
