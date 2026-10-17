# Spotify bot in voice calls (design)

Status: proposal, October 2026. Nothing here is built. It copies the Stremio bot as built (docs/design/stremio-bot.md, where
section 12 overrides the earlier sections): one in-memory session per voice channel or DM call, `PUT|PATCH|DELETE` on the
channel, one gateway event, a native bot on the home server that publishes into the self-hosted media LiveKit, and listeners on a
second, subscribe-only `Room`.

Goal: someone in a call opens a Spotify side panel (search, results, album, playlist and artist pages, the queue), picks a track,
and a participant named **Spotify** plays it into the call. Everyone in the call can control it: play now, add to queue, play
next, remove, reorder, clear, skip, previous, pause and resume, seek, shuffle the queue, and loop off, track or queue. That is the
whole scope. Playback runs on one server-wide "house" Spotify Premium account owned by the server owner, through librespot.
The owner has accepted the account risk (librespot is not an official client). Per-user Spotify accounts are not needed; they
are a possible later extension (§12).

**[verified]** means checked against source, the fork at its pinned rev, or a live request. **[unverified]** goes to Phase 0.

## 1. Findings

### 1.1 Spotifast and the librespot fork

- Spotifast pins every librespot crate to `github.com/Berkay2002/librespot` rev `44c8444b6b6a39b8d2f1367be0aaeb7913f00c24`
  (Spotifast `Cargo.toml` around line 350; the fork's parent is `crmne/librespot`, the commit is "Merge crmne/librespot ef27e12",
  dated 2026-10-17). The fork's `rust-version` is 1.85, edition 2024, below Vokko's 1.95. **[verified]**
- **Playback login.** Spotifast does not log in to librespot with a developer app. It uses Spotify's own desktop client id
  `65b708073fc0480ea92a077233ca87bd` with scope `streaming` and the redirect `http://127.0.0.1:8898/login` (PKCE, `src/auth.rs`).
  librespot's access-point login only accepts tokens from that kind of client. The fork's `librespot-oauth` has the same
  browser flow plus a device-code flow (`DeviceAuthClient`, "only for some client IDs"). **[verified]**
- **Credentials reuse.** `Session::connect(credentials, store_credentials: true)` turns the one-time token into reusable
  credentials (`AUTHENTICATION_STORED_SPOTIFY_CREDENTIALS`). librespot's `Cache::save_credentials` writes `credentials.json`
  with mode `0o600`. Spotifast moves them into the OS keychain (`keyring_core`); the bot uses the plain file instead (§2.4). **[verified]**
- **Web API tokens.** Spotifast has a second grant for the Web API (a shared public client id, or a personal app) and also uses
  `session.login5().auth_token()` for a few private endpoints. The bot needs neither (§2.4). **[verified]**
- **Playback.** Spotifast builds `Player::new(PlayerConfig { bitrate, gapless, normalisation, normalisation_type: Auto,
  position_update_interval: 1 s, .. })` with a soft-volume mixer and its own `Sink` (`src/sink.rs`, rodio), drives it through
  `Spirc` (Spotify Connect), and runs a prefetcher on `TimeToPreloadNextTrack`. The fork's `examples/play.rs` shows that a bare
  `Session` + `Player` + `player.load(uri, true, 0)` plays without Spirc. **[verified]**
- **Format.** librespot decodes to stereo 44.1 kHz (`SAMPLE_RATE`, `NUM_CHANNELS` in playback); `Bitrate` is 96, 160
  (default) or 320. A custom `Sink` gets `write(AudioPacket, &mut Converter)`. Spotifast has its own stateful polyphase
  resampler (`src/resample.rs`, 242 lines) for 48 kHz outputs. **[verified]**
- **Plays are not recorded.** Spotifast's `src/history.rs`: "Spotify does not record playback from librespot clients", which is
  why it keeps a local history. The fork has no event-service (`gabo`) or play-reporting code and no private-session switch.
  **[verified in source; the absence of recently played, friend activity and taste-profile effects is unverified live]**
- **Username in logs.** librespot logs `Authenticated as '<username>'` at info (`core/src/session.rs:246`). **[verified]**
- **Kick when the account plays elsewhere.** Without Spirc the bot is not a Connect device. The fork's dispatcher returns an
  error for unknown access-point packets, which ends the session, but which signal (if any) arrives when the owner presses
  play on his phone is **[unverified]**.

### 1.2 Vokko's existing Spotify integration (two premises in the brief were wrong)

- **There is no Spotify OAuth or Web API app in Vokko.** The "Listening to Spotify" presence is read locally by the desktop app
  from the Spotify app on the same computer: AppleScript on macOS, the system media session on Windows
  (`apps/desktop/src-tauri/src/spotify.rs`, `src/desktop/spotify.ts`, mapped by `src/activity/spotify.ts`, sent on op 3). The
  Connected Apps row is a switch, not a link. docs/parity.md says this was on purpose (development-mode apps allow 5 users). The
  server only validates the activity (`crates/protocol/src/api.rs`, `Activity`). Nothing in `crates/server` calls Spotify. **[verified]**
- So the presence fix (§9.6) lives in the desktop app, not in a server "currently playing" call, and client credentials need a
  new developer app that the owner registers (§2.4).
- Reusable pieces: `ui/BrandIcon` with the Spotify simple-icon (used by `shell/SpotifyCard.tsx`), album art as a 40-hex image id
  shown from `https://i.scdn.co/image/<id>`, already in the desktop CSP `img-src`, and the id rules (`^[A-Za-z0-9]{22}$`, `^[0-9a-f]{40}$`).

### 1.3 Web API and art

- Apps created since November 2024 cannot read Spotify-owned (editorial and algorithmic) playlists, related artists,
  recommendations or audio features (Spotifast `docs/_reference/what-spotify-allows.md`). Search, albums, artists, tracks and
  user-made public playlists remain. Whether a new development-mode app gets all of these with a client-credentials token is **[unverified]**.
- Art hosts seen live through oEmbed: `i.scdn.co`, `image-cdn-ak.spotifycdn.com`, `image-cdn-fa.spotifycdn.com` (playlist mosaics use
  `mosaic.scdn.co`). Every `image-cdn-*` id tried also loads from `https://i.scdn.co/image/<id>` (200, image/jpeg). **[verified live]**

### 1.4 Stremio work in flight

Two workers are changing Stremio now, and this design builds on their result rather than beside it:
- `vokko-stremio-smooth` moves the viewer `Room` out of `StremioTile` into a call-level owner (`stremio/ViewerHost.tsx`,
  `viewerStore.ts` with `syncViewer({channelId, bot})`, `viewerConnection.ts`) and paces media.
- `vokko-stremio-tracks` adds the audio-language choice and per-viewer client-rendered subtitles over LiveKit data topics.

Spotify reuses the call-level media Room owner; it does not add a third `Room` (§2.2). The desktop worker starts after
`vokko-stremio-smooth` merges.

## 2. Decisions

### 2.1 Process layout: a new crate `tools/spotify-bot`

A separate binary, native on the home server under launchd (`org.vokko.spotify-bot`, `127.0.0.1:8721`, log
`~/Library/Logs/vokko-spotify-bot.log`), like the Stremio bot. Reasons: stremio-bot is being edited by two workers, so a mode
inside it would collide; librespot brings a large dependency tree that the Stremio bot should not carry; and a crash in one bot
does not take the other down. It copies about 150 lines from stremio-bot (`api.rs` bearer auth and `secrets_match`,
`report.rs`, the lease) instead of extracting a shared crate. `shortcut: duplicated bot plumbing, extract a media-bot crate when a third bot appears.`
`tools/*` is a workspace member but not a default member, so `cargo test` for the server never builds libwebrtc or librespot.
librespot is used with `rustls-tls-webpki-roots` to match the workspace's rustls. If its pinned dependencies cannot share
Vokko's `Cargo.lock`, the crate is excluded from the workspace (`exclude = ["tools/spotify-bot"]`) with its own lock file.

### 2.2 Rooms: one media activity per channel, one Room per client

- The bot publishes into the media LiveKit in a fresh room per session, `spotify-<channel_id>-<random hex>`, named only in the
  tokens, exactly like Stremio's §12 rule. Identity `bot:spotify:<channel_id>`, name `Spotify`.
- **One media activity per channel.** `PUT /channels/{id}/spotify` while a Stremio session runs there returns 409 (a new error code the server worker adds to docs/api.md)
  "Stop the movie first", and Stremio's `PUT` gets the mirror check. Watch Together (YouTube, client-side) stays allowed next to either.
  So a call never has two media rooms, and each client keeps exactly one media `Room`.
- **Listener token:** `POST /channels/{id}/spotify/listener-token`, the same check, claims and 6 h TTL as Stremio's viewer token
  (`viewer:<user_id>:<hex>`, subscribe only). Both routes call one shared signer that moves from `voice/stremio.rs` into
  `voice/media.rs` (`fn media_viewer_token(cfg, room, user_id)`). The desktop's `syncViewer` target gains `kind: "stremio" | "spotify"`,
  which picks the token route; the Room code itself does not change.

### 2.3 One account, one stream

Spotify plays one stream per account, so the server holds **at most one Spotify session server-wide** (`Option<(channel_id, Session)>`).
A `PUT` from another channel returns 409 (another new code) with a message that names where it is playing *only if the caller can see that
channel*: "Spotify is already playing in #lounge on Friends (started by Alex)". Otherwise: "Spotify is already playing in another
call." The bot also refuses a second session (503 "busy") as a backstop.

### 2.4 Auth and secrets

- **Playback credentials** reach the home server once: the owner runs `spotify-bot login` on the home server. It uses `librespot-oauth`
  with Spotify's desktop client id, scope `streaming` and `http://127.0.0.1:8898/login` (over SSH: `ssh -L 8898:127.0.0.1:8898 buildhost`
  and open the printed URL on the PC). It connects once with `store_credentials: true`, which writes librespot's
  `credentials.json` (mode 600) to `~/.config/vokko/spotify-bot/`, outside external-disk because launchd agents cannot read external-disk (TCC),
  the same reason the media LiveKit config lives in `~/.config/vokko/`. The bot refuses to start if the file is group- or
  world-readable. If Spotify rejects the stored credentials, the bot reports `auth` and the owner runs `login` again.
- **Search and metadata use client credentials** from a new developer app the owner registers ("Vokko catalog"), held by the
  server as `VOKKO_SPOTIFY_CLIENT_ID` / `VOKKO_SPOTIFY_CLIENT_SECRET` in `deploy/.env`. Reason: a client-credentials token has no
  user, so no endpoint can return anything of the house account, by construction. The house account's own token never leaves the
  bot, and the bot never calls the Web API. Fallback, only if Phase 0 shows client credentials blocked: the bot serves a fixed list
  of catalog lookups through its login5 token, never `/me`.
- Nothing new in the server DB. Secrets are wrapped in the existing `Secret` newtype; the bot sets `librespot=warn` in its log
  filter so the username line never reaches the log.

## 3. Architecture

```
 desktop                    vokko-server (docker)                       spotify-bot (native, launchd, 127.0.0.1:8721)
 ───────                    ─────────────────────                       ───────────────────────────────────────────
 Spotify panel ─REST─▶ /spotify/search|albums|playlists|artists ─HTTPS─▶ api.spotify.com (client credentials only)
               ─REST─▶ PUT/PATCH/DELETE /channels/{id}/spotify
                              │ one SpotifySession server-wide: queue, history, loop, who added what
                              └─ internal HTTP, bearer ─▶ PUT /session {livekit_url, token, track, next, position_ms, playing, seq}
                         ◀── POST /internal/spotify/bot {event, track, position_ms, seq, reason?}
 gateway ◀── SPOTIFY_UPDATE {channel_id, state|null}                   librespot Session + Player (house account, 320 kbps)
 call-level media Room ◀══ media LiveKit room spotify-<ch>-<hex> ◀════  custom Sink → NativeAudioSource (Opus stereo)
```

The server owns all state; the bot knows only the current and next track URI.

## 4. API contract (frozen before work starts)

Every route needs auth and returns 404 10000 unless `VOKKO_SPOTIFY_CLIENT_ID`, `_CLIENT_SECRET`, `VOKKO_SPOTIFY_BOT_URL`,
`VOKKO_SPOTIFY_BOT_SECRET` and the media LiveKit settings are all set. Errors reuse 50013, 50035, 40033 and 429.

### 4.1 Browse (server proxies, public catalog only)

| Method | Path | Response |
|---|---|---|
| GET | /spotify/search?q=&type=track,album,artist,playlist&offset= | `{tracks, albums, artists, playlists}`, 10 each. `q` 1..=100 chars. A pasted `open.spotify.com/{type}/{id}` or `spotify:{type}:{id}` becomes a direct lookup |
| GET | /spotify/albums/{id} | `{id, name, artists, art?, year?, tracks: [Track]}` |
| GET | /spotify/playlists/{id}?offset= | `{id, name, owner_name, art?, total, tracks: [Track]}`, 100 per page |
| GET | /spotify/artists/{id} | `{id, name, art?, top_tracks: [Track], albums: [{id, name, art?, year?}]}` |
| GET | /spotify/tracks/{id} | `Track` |

`Track = {uri, title, artists: [string], album?, art?, duration_ms, explicit}`. `art` is a 40-hex image id; the client builds
`https://i.scdn.co/image/<id>`. Requests carry `market=$VOKKO_SPOTIFY_MARKET` (the house account's country, default `SE`) so
results are playable. Spotify-owned playlists (owner id `spotify`) are dropped from search, because new apps get 404 for them.
Public user playlists from search are allowed: they are public, and a client-credentials token cannot reach private ones.
Responses are cached in memory (search 2 min, the rest 10 min), and a Spotify 429 sets a server-wide pause for its `Retry-After`.

### 4.2 Playback in a call

| Method | Path | Body → Response |
|---|---|---|
| PUT | /channels/{id}/spotify | `{uri}` → `SpotifyState`. Starts the bot, or replaces the current track. An album or playlist URI plays its first track now and puts the rest at the front of the queue |
| PATCH | /channels/{id}/spotify | One op per request: `{playing}`, `{position_ms}`, `{skip: true}`, `{previous: true}`, `{loop: "off"\|"track"\|"queue"}`, `{shuffle: true}`, `{queue_add: {uri, next?: bool}}`, `{queue_remove: qid}`, `{queue_move: {qid, to}}`, `{queue_clear: true}` → `SpotifyState` |
| DELETE | /channels/{id}/spotify | → 204, stops for everyone |
| GET | /channels/{id}/spotify | → `SpotifyState` with the full queue |
| POST | /channels/{id}/spotify/listener-token | → `{url, token}` (§2.2) |

Rules: the caller must be in that voice channel or DM call now, under `require_in_voice` (the `watch.rs` and Stremio check: VIEW_CHANNEL
+ CONNECT, not timed out, DM recipient and not blocked, no stage channels). The queue holds at most 200 tracks; an album or
playlist adds at most what fits, and the response says how many were left out. `qid` is a random id per queue entry, so a remove or
move never hits the wrong row after someone else's change. `previous` restarts the track past 3 s, else plays the last of up to 20
history entries. `shuffle` is a one-time reorder of the queue, not a mode. Loop `track` replays the track, loop `queue` appends each
finished track to the end. `position_ms` is 0..=duration.

`SpotifyState {status: starting|playing|paused|loading|error, error?, track: Track | null, playing, position_ms, updated_at_ms,
loop, queue: [{qid, ...Track, added_by}], queue_len, can_previous, started_by, bot_identity}`. Expected position is
`position_ms + (now - updated_at_ms)` while playing. No account name, user id or avatar of the house account, no URLs.

**Gateway:** `SPOTIFY_UPDATE {channel_id, state | null}` to everyone who can see the channel, the Stremio audience. It is sent on
changes only, never for position ticks, and carries at most the first 50 queue entries plus `queue_len`; the panel's queue view
loads the rest with `GET`. READY guilds, GUILD_CREATE and the `Call` object carry `spotify: [{channel_id, state}]` (at most one entry).

**Internal (server ↔ bot, never through Caddy).** Bearer `VOKKO_SPOTIFY_BOT_SECRET` both ways, constant-time compare.
- `PUT /session {channel_id, livekit_url, token, track: "spotify:track:<id>", next?: "spotify:track:<id>", position_ms, playing, seq}`:
  desired state, idempotent, re-sent every 60 s as a lease; dropped after 150 s without renewal. `seq` increases on every change.
- `DELETE /session`; the server sends it at startup too.
- `POST /internal/spotify/bot {channel_id, event: started|position|ended|error, track, position_ms, seq, reason?: unavailable|kicked|auth|io}`,
  position every 5 s. The server ignores events whose `seq` or `track` no longer match.
- Rate limits (`limiter.check_key`): search and browse 10 then 2/s per user; `PUT` 3 per minute; `queue_add` of an album or playlist
  5 per minute; other controls share the Watch Together bucket (10 then 2/s); listener token in that same bucket.

## 5. Bot (`tools/spotify-bot`)

- **Session:** on the first `PUT`, connect a librespot `Session` from the cached credentials, create a `Player` (no Spirc, no
  Connect device), join the media room with the given token and publish one audio track. On `DELETE` or lease expiry: stop,
  unpublish, disconnect, drop the librespot `Session`, so the account is not held online between sessions. No audio cache on disk.
- **Desired state:** load `track` at `position_ms` when the track or `seq` changes; `player.play()`/`pause()` and `seek()` otherwise.
- **Gapless and preload:** on `TimeToPreloadNextTrack` it calls `player.preload(next)`. At `EndOfTrack` it loads `next` at once
  (gapless when preloaded), then reports `ended {track}` and `started {next}`. The server advances the queue and sends a new `PUT`
  whose `track` is already playing, which the bot treats as a no-op apart from the new `next`. Loop `track` is the server sending
  `next` = the current track.
- **Errors:** `Unavailable` / `AudioKeyUnavailable` → `error unavailable` (the server skips it). The librespot session ending while
  a session is wanted → `error kicked` (§8). Rejected stored credentials → `error auth`.
- **Grants:** the bot token allows `screen_share_audio` only, `canSubscribe: false`, `canPublishData: false`.

## 6. Audio path

- librespot `Bitrate320`, `gapless: true`, normalisation **on** (`NormalisationType::Auto`, default pregain and limiter), because a
  queue mixes albums mastered at very different loudness. No librespot mixer volume: listeners have local volume.
- **Sink:** a custom `Sink` converts each packet to interleaved i16 and pushes 10 ms frames into a bounded channel of about 200 ms.
  The channel's blocking send paces librespot's player thread; an async task drains it into `NativeAudioSource::capture_frame`,
  which waits while its 100 ms queue is full, the same pacing the Stremio bot's audio loop relies on. Pause and seek clear the
  channel so the change is heard at once.
- **44.1 to 48 kHz:** first try feeding 441-sample frames at 44.1 kHz straight to `NativeAudioSource::new(.., 44_100, 2, 100)` and
  let libwebrtc resample. If Phase 0 hears artefacts or the source rejects the rate **[unverified]**, copy Spotifast's
  `resample.rs` (stateful polyphase, 64 taps) and feed 480-sample frames at 48 kHz.
- **Opus:** `AudioEncoding { max_bitrate: 160_000 }`, `dtx: false`, `red: false`, source `ScreenshareAudio`, stereo (livekit 0.9.5
  munges `stereo=1` into the SDP). The Rust SDK has no Opus application or "music mode" knob; that is accepted, and Phase 0 compares
  by ear. Echo cancellation, noise suppression and AGC off, as in the Stremio bot.

## 7. Desktop UI

- **Activities menu** (`voice/VoiceChannelPage.tsx`): a *Spotify* entry next to *Stremio*, `BrandIcon` Spotify glyph, sub-label
  "Play music for everyone in the call". It opens the **Spotify panel** (`apps/desktop/src/spotify/`), a side sheet with the Stremio
  panel's layout: a search field, result rows (tracks with art, title, artists, duration; album, artist and playlist cards), then
  album, playlist and artist pages with Play, Play next and Add to queue on every row and on the page header. A Queue tab shows
  now playing and the queue with drag to reorder, remove, clear and shuffle. Spotify green accents only on the brand mark.
- **Now Playing tile** in the call grid (`SpotifyTile`, sized like `StremioTile` but with no video): art, title and artists, a seek
  bar driven by the server state, previous, play/pause, skip, loop, shuffle, a queue button that opens the panel's Queue tab, and
  local volume (its own `localStorage` key, default 60). The participant list shows **Spotify** with a BOT badge; `bot:` identities
  are already skipped where the client maps identities to users.
- **Sidebar line** in `voice/VoiceChannelRow.tsx`: "Listening to *Track* on Spotify" with the brand icon, next to the Stremio line.
- **Audio:** the call-level media Room owner from `vokko-stremio-smooth` connects with the Spotify listener token while the call has
  a Spotify session, attaches the bot's audio, and applies local volume and self-deafen. Voice keeps coming from the voice room.
- **Late joiners** get the state from READY or `Call` and connect the media Room at once; the position comes from `updated_at_ms`.
- **Mock backend** (`apps/desktop/src/api/mock/spotify.ts`): the browse routes from fixtures, a fake session that ticks position,
  and the 409 cases. It also feeds `calls.ts` like `stremioOf`.

## 8. Lifecycle

| Trigger | Result |
|---|---|
| Last human leaves the call (the `voice/state.rs` hook Stremio uses) | `DELETE /session`, SPOTIFY_UPDATE null |
| Paused longer than `VOKKO_SPOTIFY_IDLE_MIN` (15), or the queue ran out and nothing played for 5 min | Stop |
| `ended` | Next queue entry per the loop mode, else idle |
| `error unavailable` | Skip to the next entry and show "Skipped an unavailable track" for 5 s |
| `error kicked` (the house account started playing elsewhere) | Stop and keep the tile for 30 s with "The house Spotify account is playing somewhere else." No automatic retake |
| `error auth` | Stop with "Spotify needs the server owner to sign in again" |
| Bot crash | launchd restarts it; the next lease `PUT` (within 60 s) or a failed `PUT` makes the server re-send at the last position once, else stop |
| Server restart | Sessions are lost (in memory); `DELETE /session` at startup |
| Starter leaves, others stay | Keeps playing; `added_by` entries stay |

## 9. Privacy and security rules

1. **What crosses each boundary.** Client → server: search text, Spotify URIs and ids, queue ops. Server → client: public catalog
   fields, 40-hex art ids, `qid`s, Vokko user ids in `started_by` / `added_by`. Server → Spotify: catalog requests with the app token.
   Server → bot: room token, track URIs, position. Bot → server: URIs, positions, a reason code. The house account's credentials,
   token, username, country and Connect state stay in the bot.
2. **No account data, ever.** No `/me` endpoint anywhere: no library, saved tracks, the account's playlists, recently played, top
   items, follows or recommendations. The server's Web API client is a fixed set of five catalog paths, and a test fails if any
   other path is built. Pages only show what search or a pasted public link found.
3. **No identity.** State, events and UI name the bot "Spotify" and nothing else; a test serializes every response and event and
   scans for the configured house username (set in the test) and for `http`.
4. **Ids and URIs:** a Spotify id matches `^[A-Za-z0-9]{22}$`; a URI matches `^spotify:(track|album|playlist|artist):[A-Za-z0-9]{22}$`
   and only `track` URIs reach the bot. Pasted links accept only `https://open.spotify.com/(intl-xx/)?{type}/{id}`, query dropped.
   Everything else is 400 50035. Text from Spotify (titles, names) is cut to 200 characters with control and bidi characters
   removed (the Watch Together rule). The bot validates the URI again before `load`.
5. **Images:** every art URL from Spotify is reduced to its 40-hex id when its host is `i.scdn.co`, `image-cdn-ak.spotifycdn.com` or
   `image-cdn-fa.spotifycdn.com`, else dropped (mosaics show a placeholder). The client only ever loads `https://i.scdn.co/image/<id>`,
   already allowed by the CSP, so no new `img-src` host.
6. **Vokko presence.** Without Spirc the bot is not a Connect device, so the owner's own Spotify app should not show its playback
   **[unverified]**. As a guard, the desktop presence code (`activity/index.ts`) drops the local Spotify activity while any Spotify
   session the client knows of plays the same track (by `track_id` on macOS, by title and artists on Windows). This needs no
   knowledge of whose account is the house one.
7. **Outside Vokko.** Per Spotifast and the fork's source, librespot sends no play events, so the bot's plays should not reach
   recently played, friend activity or the taste profile; there is no private-session mode to turn on, and none is needed if that
   holds. Phase 0 checks it on the house account. If plays do show up, nothing in librespot can suppress them; that becomes a
   documented limitation.
8. **Bot channel:** separate bearer secret (16+ characters), loopback listener, `/internal/spotify/bot` off the public proxy, lease
   expiry 150 s. The credentials file is 600 and checked at start.
9. **Access:** every playback route re-checks `require_in_voice`; browse routes need auth only. Rate limits as in §4.2.

## 10. Test plan (mocks only)

- **Server unit:** id, URI and link parsing; art reduction per host; queue ops (add, next, move by `qid`, remove, clear, shuffle keeps
  the set, loop track and queue, previous with the 3 s rule, 200 cap); the Web API path allow-list.
- **Server integration (`crates/server/tests/spotify.rs`):** a mock Spotify (axum on a random port) for the token endpoint and the
  catalog paths, including a 429 with `Retry-After`; a fake bot that records `PUT`/`DELETE` and posts events. Cases: play from
  member A and control from member B; non-member 403; a second channel gets 409 naming the channel only when visible; Stremio and
  Spotify in one channel get 409 both ways; `ended` advances with gapless `next`; stale `seq` ignored; `unavailable` skips; `kicked`
  ends; the call empties so the bot is deleted; idle timeout (1 s); no house username or URL in any response or event.
- **Bot:** `cargo test -p spotify-bot` for the pure parts: desired-state diffing, lease expiry, the frame chunker (packet → 10 ms
  frames), the URI check, and the credentials-file mode check. A manual smoke test with `livekit-server --dev` and the house account.
- **Desktop:** vitest for the panel reducer, queue view, tile and the presence guard; one mock e2e: search, play, add an album,
  reorder, skip from a second user.

## 11. Build plan

**Phase 0, spike (half a day, one worker):** build the fork at the pinned rev on macOS inside the workspace (or excluded, §2.1);
`spotify-bot login`; play a track into `livekit-server --dev` and listen at 44.1 kHz direct versus resampled; press play on the
owner's phone and record what the bot sees; check recently played and friend activity afterwards; check a new development-mode
app's client-credentials token on search, albums, artists (top tracks), tracks and a user playlist. Report, then freeze §4.

Then three workers, by file ownership, against the frozen §4:
1. **Server:** `crates/server/src/spotify/{mod,webapi}.rs`, `voice/spotify.rs`, `voice/media.rs` (the shared signer, moved from
   `voice/stremio.rs`), the one-line activity check in `voice/stremio.rs`, `config.rs`, `routes/mod.rs`, `events.rs`, `voice/state.rs`
   and `voice/calls.rs` hooks, `crates/protocol/src/api.rs`, `docs/api.md`, `crates/server/tests/spotify.rs`. Writes the protocol
   types and `docs/api.md` first so the other two can start. Coordinate the `voice/stremio.rs` lines with the two Stremio workers.
2. **Bot:** `tools/spotify-bot/**`, `deploy/launchd/org.vokko.spotify-bot.plist`, `deploy/.env.example`, a "Spotify in calls"
   section in `docs/self-hosting.md`. Tests against a stub server.
3. **Desktop:** `apps/desktop/src/spotify/**`, the Activities entry in `voice/VoiceChannelPage.tsx`, `voice/VoiceChannelRow.tsx`,
   `voice/reducer.ts` and the voice store for SPOTIFY_UPDATE, the `kind` in the call-level viewer owner, `activity/index.ts` (presence
   guard), `api/mock/spotify.ts` and `calls.ts`. Starts after `vokko-stremio-smooth` merges.

## 12. Open questions and risks

| # | Question / risk | Recommendation |
|---|---|---|
| 1 | House account: librespot is unofficial and Spotify can ban the account | Accepted by the owner |
| 2 | The fork's rev is from 2026-10-17, untested on this Mac (no checkout in the cargo cache), and may not share Vokko's lock file | Phase 0 builds it first; exclude the crate from the workspace if needed |
| 3 | The playback login depends on Spotify's desktop client id accepting `127.0.0.1:8898` | Same as Spotifast today; if it breaks, both break, and the device-code flow is the fallback |
| 4 | Client credentials need a new developer app; Spotify's development-mode rules keep changing | Owner confirmed 2026-10-17: a new "Vokko catalog" app, separate from Spotifast's. Phase 0 checks the five catalog calls; the bot-side catalog fallback (§2.4) is the backup |
| 5 | What happens when the owner plays elsewhere without Spirc (kicked, silent, or both playing) | Owner confirmed 2026-10-17: stop the session, no automatic retake (§8). Phase 0 finds out what the bot sees. If nothing signals it, add Spirc only for its active-device signal |
| 6 | Bot plays in the owner's history or friend activity | Expected not to happen; if it does, a documented limitation |
| 7 | Per-user Spotify accounts | Later extension, not designed here |
