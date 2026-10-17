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
  why it keeps a local history. The fork has no event-service (`gabo`) or play-reporting code and no private-session switch; the
  audit is in §9.7. **[verified in source; live: the bot's plays were not in Recently played on the owner's phone or desktop app the
  same day; Wrapped, recommendations and friend activity could not be checked]**
- **Username in logs.** librespot logs `Authenticated as '<username>'` at info (`core/src/session.rs:246`). **[verified]**
- **Kick when the account plays elsewhere: there is none.** Without Spirc the bot is not a Connect device. Phase 0 (2026-10-17):
  the bot streamed for 40 s, 300 s and 300 s while the owner played in Spotifast (same account, other machine) and skipped tracks
  there. Neither side stopped, paused or showed an error, and the bot saw no player event, no `SessionDisconnected` and
  `Session::is_invalid()` stayed false. Two librespot sessions on the account also coexist (a second one connected, read metadata
  and left while the bot played, without a glitch). So `error kicked` (§8) cannot be produced by an external play and is **removed
  from the design**; it stays only as the mapping for "session ended while wanted" (`is_invalid()`, a socket error).
  **[verified live; short-term. Spotify may enforce one stream per account on a longer timescale or for non-Spirc clients later.]**
- **First-track latency.** `player.load` to the first sample took 1.2 s, 1.2 s and 6.8 s in three runs (the slow one with Spotifast
  playing at the same time). The panel should show "loading" for up to ~8 s; the server must not time a `PUT` out below 15 s.

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
  user-made public playlists remain. **Phase 0 result (2026-10-17, new "Vokko catalog" app, client-credentials token, market SE):**

  | Call | Result |
  |---|---|
  | `GET /search?type=track,album,artist,playlist` | 200. `limit` above 10 is 400 "Invalid limit" (10 is the maximum), `offset` works. Playlist results contain `null` entries (4 of 10 for "daft punk") and carry `items.total` as the track count. Track objects have no `popularity`; artist objects have no `popularity`, `followers` or `genres` |
  | `GET /albums/{id}` | 200 with `tracks.items` (14 of 14); `GET /albums/{id}/tracks?limit=50` also 200 |
  | `GET /artists/{id}` | 200 but only `name`, `images`, uris |
  | `GET /artists/{id}/albums` | 200 (`include_groups` works) |
  | `GET /artists/{id}/top-tracks` | **403 Forbidden** |
  | `GET /tracks/{id}` | 200, `is_playable` present |
  | `GET /tracks?ids=a,b` (batch) | **403** |
  | `GET /playlists/{id}` (user playlist) | 200 **but without any tracks**: header only (`name`, `owner`, `images`, `description`, no `tracks`/`items`) |
  | `GET /playlists/{id}/tracks` | **403**; `/playlists/{id}/items` is 401 "Valid user authentication required" |
  | `GET /playlists/{id}` (Spotify-owned) | 404, as predicted |

  So the browse design loses **playlist tracks** and **artist top tracks** on the Web API. Both are readable through librespot on the
  house session (below, §2.4), so the bot serves exactly those two reads.
- **librespot metadata on the house session [verified live]:** `Playlist::get` returns all tracks of a user playlist (45) *and* of a
  Spotify-owned editorial playlist (Today's Top Hits, 50); `Track::get` for 50 tracks in parallel took 170 ms and gives name, artists,
  duration, explicit, popularity and `album.covers` (a 40-hex `FileId`, e.g. `ab67616d00001e02…`, which loads from `https://i.scdn.co/image/<id>`: 200 image/jpeg);
  `Artist::get` returns `top_tracks` per country (SE: 10 tracks) with popularity. A cold metadata-only session (connect, read, close)
  costs about 0.8 s, and it runs next to a playing session without disturbing it.
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
  bot, and the bot never calls the Web API. **Phase 0 showed client credentials are not enough** (§1.3: no playlist tracks, no
  artist top tracks), so the bot also serves two fixed read-only catalog lookups over its librespot session (access point /
  spclient metadata, not the Web API, no login5 token, never `/me`): the tracks of a playlist and the top tracks of an artist
  (§4.3). The server asks for them by id, the bot returns only public catalog fields, and nothing it can read is account data
  (the metadata calls take a playlist/artist/track URI and have no "my library" form).
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
| GET | /spotify/playlists/{id}?offset= | `{id, name, owner_name, art?, total, tracks: [Track]}`, 100 per page. Header from the Web API, `tracks` from the bot (§4.3); `total` from the bot's list length |
| GET | /spotify/artists/{id} | `{id, name, art?, top_tracks: [Track], albums: [{id, name, art?, year?}]}`. `top_tracks` from the bot (§4.3, the Web API's is 403), `albums` from `/artists/{id}/albums?include_groups=album,single` |
| GET | /spotify/tracks/{id} | `Track` |

`Track = {uri, title, artists: [string], album?, art?, duration_ms, explicit}`. `art` is a 40-hex image id; the client builds
`https://i.scdn.co/image/<id>`. Requests carry `market=$VOKKO_SPOTIFY_MARKET` (the house account's country, default `SE`) so
results are playable. Spotify-owned playlists (owner id `spotify`) are dropped from search, because new apps get 404 for them (a pasted link to one
still works, since its tracks come from the bot, §4.3; the header then uses the bot's playlist name, owner "Spotify", no art).
Public user playlists from search are allowed: they are public, and a client-credentials token cannot reach private ones.
`null` entries in the search playlist array are skipped. Search takes `limit=10` (the maximum; `offset` for more).
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

### 4.3 Bot catalog reads (new after Phase 0)

Same bearer and loopback listener as the session routes; they work with or without a playing session (§5).
- `GET /catalog/playlists/{id}?offset=&limit=100` → `{name, total, tracks: [Track]}`; `GET /catalog/artists/{id}/top-tracks?market=SE` →
  `{tracks: [Track]}`. `id` is the 22-char base62 id, validated like §9.4. 404 when Spotify has no such item, 503 `auth`/`busy`.
- `Track` is built from `Track::get` (parallel, 10 at a time, 170 ms for 50) with art reduced to the 40-hex cover id of the 300 px
  image (`ab67616d00001e02…` prefix), `artists` names, `duration_ms`, `explicit`, same 200-char text rule as §9.4. Tracks that are
  unavailable in the market are dropped from the list. The server caches both for 10 min, like the Web API responses.
- Not built, on purpose: any other metadata call, and anything that takes a username or the "own" form of a URI.

## 5. Bot (`tools/spotify-bot`)

- **Session:** on the first `PUT`, connect a librespot `Session` from the cached credentials, create a `Player` (no Spirc, no
  Connect device), join the media room with the given token and publish one audio track. On `DELETE` or lease expiry: stop,
  unpublish, disconnect, drop the librespot `Session`, so the account is not held online between sessions. No audio cache on disk.
  A catalog read (§4.3) uses the playing session when there is one, else opens a short one (about 0.8 s connect plus read) and
  closes it 30 s after the last read. A metadata session next to a playing one is harmless (tested).
- **Build:** `tools/spotify-bot` joins the workspace (§2.1 outcome in §11), needs a `build.rs` with `-ObjC` like stremio-bot (without
  it the binary aborts in a libwebrtc static initializer before `main`), installs rustls' ring provider at start, and uses
  `librespot-{core,oauth,playback,metadata}` with `default-features = false, features = ["rustls-tls-webpki-roots"]`.
- **Desired state:** load `track` at `position_ms` when the track or `seq` changes; `player.play()`/`pause()` and `seek()` otherwise.
- **Gapless and preload:** on `TimeToPreloadNextTrack` it calls `player.preload(next)`. At `EndOfTrack` it loads `next` at once
  (gapless when preloaded), then reports `ended {track}` and `started {next}`. The server advances the queue and sends a new `PUT`
  whose `track` is already playing, which the bot treats as a no-op apart from the new `next`. Loop `track` is the server sending
  `next` = the current track.
- **Errors:** `Unavailable` / `AudioKeyUnavailable` → `error unavailable` (the server skips it). The librespot session ending while
  a session is wanted (`Session::is_invalid()` polled each second, or a sink error) → `error io` (§8); an external play does not end
  the session (Phase 0). Rejected stored credentials → `error auth`. Log the player events by variant name only (never payloads).
- **Grants:** the bot token allows `screen_share_audio` only, `canSubscribe: false`, `canPublishData: false`.

## 6. Audio path

- librespot `Bitrate320`, `gapless: true`, normalisation **on** (`NormalisationType::Auto`, default pregain and limiter), because a
  queue mixes albums mastered at very different loudness. No librespot mixer volume: listeners have local volume.
- **Sink:** a custom `Sink` converts each packet to interleaved i16 and pushes 10 ms frames into a bounded channel of about 200 ms.
  The channel's blocking send paces librespot's player thread; a thread drains it into `NativeAudioSource::capture_frame`
  (`Handle::block_on`), which waits while its 100 ms queue is full, the same pacing the Stremio bot's audio loop relies on. **The
  channel must be a `std::sync::mpsc::sync_channel`**: librespot calls `Sink::write` from inside its own runtime, where tokio's
  `blocking_send` panics. Measured: 100 frames/s, 0 starvations over 300 s. Pause and seek clear the channel so the change is
  heard at once (not built in the spike).
- **44.1 to 48 kHz: resample in the bot (decided).** `NativeAudioSource` accepts 44.1 kHz and the pitch and duration are right
  either way, but libwebrtc's own conversion is worse. Measured through `livekit-server --dev` and a subscriber decoding at
  48 kHz (`tools/spotify-bot`: `tone direct|resample`, `examples/listen`), same synthetic 17 s signal (1/10/18 kHz tones at
  -6 dBFS, a 20 Hz to 20 kHz log sweep), repeated twice with identical tone numbers:

  | | direct 44.1 kHz | resampled to 48 kHz (Spotifast's `resample.rs`) |
  |---|---|---|
  | 18 kHz tone level | -6.75 dBFS (0.7 dB down) | -6.02 dBFS |
  | 18 kHz tone SNR (includes Opus noise) | 23.9 dB | 26.1 dB |
  | 10 kHz tone SNR | 35.0 dB | 37.6 dB |
  | 1 kHz tone SNR | 50.4 dB | 48.5 dB |
  | sweep, energy outside +-7% of the sweep, median | -22.8 / -26.9 dB (two runs) | -39.8 / -37.7 dB |

  The direct path adds 11 to 17 dB more off-sweep energy (imaging from the library's resampler) and rolls off the top. No clicks,
  gaps or channel differences in either (L equals R exactly, no 3 ms zero runs). A real track (a mono field recording) shows the same
  spectrum both ways, 1.4 dB less above 16 kHz direct. This is a measurement, not listening; the owner can A/B `play <id> direct|resample`.
  So: copy `resample.rs` (stateful polyphase, 64 taps, 242 lines, with its tests) and feed 480-sample frames at 48 kHz. The
  `Pipeline` in the spike (`tools/spotify-bot/src/pump.rs`, with the 10 ms chunker and its tests) is the code to keep.
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
| `error io` (the librespot session ended while wanted, a socket error) | Stop and keep the tile for 30 s with "Spotify lost its connection." One automatic retry by the server at the last position, then stop. (Phase 0: the owner playing elsewhere does **not** end the session, so the earlier "kicked / playing somewhere else" state is gone) |
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
   items, follows or recommendations. The server's Web API client is a fixed set of catalog paths (search, `albums/{id}`, `artists/{id}`,
   `artists/{id}/albums`, `tracks/{id}`, `playlists/{id}` for the header), and a test fails if any other path is built. The bot's
   catalog reads (§4.3) are the two fixed lookups, with the same kind of test. Pages only show what search or a pasted public link found.
3. **No identity.** State, events and UI name the bot "Spotify" and nothing else; a test serializes every response and event and
   scans for the configured house username (set in the test) and for `http`.
4. **Ids and URIs:** a Spotify id matches `^[A-Za-z0-9]{22}$`; a URI matches `^spotify:(track|album|playlist|artist):[A-Za-z0-9]{22}$`
   and only `track` URIs reach `PUT /session` (the catalog reads take a bare playlist or artist id). Pasted links accept only `https://open.spotify.com/(intl-xx/)?{type}/{id}`, query dropped.
   Everything else is 400 50035. Text from Spotify (titles, names) is cut to 200 characters with control and bidi characters
   removed (the Watch Together rule). The bot validates the URI again before `load`.
5. **Images:** every art URL from Spotify is reduced to its 40-hex id when its host is `i.scdn.co`, `image-cdn-ak.spotifycdn.com` or
   `image-cdn-fa.spotifycdn.com`, else dropped (mosaics show a placeholder). The client only ever loads `https://i.scdn.co/image/<id>`,
   already allowed by the CSP, so no new `img-src` host.
6. **Vokko presence.** Without Spirc the bot is not a Connect device, so the owner's own Spotify app should not show its playback
   **[unverified]**. As a guard, the desktop presence code (`activity/index.ts`) drops the local Spotify activity while any Spotify
   session the client knows of plays the same track (by `track_id` on macOS, by title and artists on Windows). This needs no
   knowledge of whose account is the house one.
7. **Outside Vokko (hard rule): bot playback must not touch the house account's history, recently played, recommendations, Wrapped
   or friend activity.** Audit of the pinned fork (rev `44c8444`, `librespot-{core,audio,metadata,playback,oauth}`, 2026-10-17):
   - Nothing in those crates reports a play. There is no event-service, `gabo`, scrobble or playback-report code. `PlayerEvent`
     (`playback/src/player.rs`) goes to a local channel only.
   - The only code that writes state to Spotify is Connect. It lives in `librespot-connect`: `Spirc` (`connect/src/spirc.rs`),
     `put_connect_state_request` / `put_connect_state_inactive` (callers `connect/src/state.rs:586,619`; definitions
     `core/src/spclient.rs:555,570`), `delete_connect_state_request` (`spirc.rs:906`, def `spclient.rs:565`), the transfer POST
     (`spclient.rs:968`) and the dealer websocket, which only Spirc starts (`spirc.rs:750`; `core/src/dealer/`). The bot does
     not depend on `librespot-connect` or `-discovery` (`cargo tree -p spotify-bot`, and `Cargo.lock` has neither crate).
   - Everything else the bot sends is a read or auth: `login5.spotify.com` login (`core/src/login5.rs:66`), `clienttoken`
     (`spclient.rs:150`), keymaster token (`core/src/token.rs:109`), extended-metadata POST (`spclient.rs:589`, a read),
     autoplay `context-resolve` (`spclient.rs:923`, a read, unused by the bot), audio key and CDN fetches, playlist and
     metadata reads. The AP login carries device info; that it does not show as a device without the connect-state PUT is expected from the code **[unverified live]**.
   - Guard: `tools/spotify-bot/tests/no_play_reports.rs` fails if `Cargo.toml` or `Cargo.lock` gains `librespot-connect` or
     `-discovery`, or if the bot's sources mention `Spirc`, `put_connect_state`, `delete_connect_state`, `dealer()` or `mercury()`.
   - Live check (2026-10-17, same day, three plays 19:18 to 19:31): the track was not in Recently played on the owner's phone or
     in the desktop app. No positive control yet (a track started from search in the official app should appear in the same view). Wrapped and recommendation effects cannot be checked this way; the audit above is what supports them.
   - Streaming still happens (key and CDN fetch), so Spotify can count a stream server-side. Nothing in librespot can suppress
     that; if it matters, only a dedicated account avoids it. Not seen in the history check.
8. **Bot channel:** separate bearer secret (16+ characters), loopback listener, `/internal/spotify/bot` off the public proxy, lease
   expiry 150 s. The credentials file is 600 and checked at start.
9. **Access:** every playback route re-checks `require_in_voice`; browse routes need auth only. Rate limits as in §4.2.

## 10. Test plan (mocks only)

- **Server unit:** id, URI and link parsing; art reduction per host; queue ops (add, next, move by `qid`, remove, clear, shuffle keeps
  the set, loop track and queue, previous with the 3 s rule, 200 cap); the Web API path allow-list.
- **Server integration (`crates/server/tests/spotify.rs`):** a mock Spotify (axum on a random port) for the token endpoint and the
  catalog paths, including a 429 with `Retry-After`; a fake bot that records `PUT`/`DELETE` and posts events. Cases: play from
  member A and control from member B; non-member 403; a second channel gets 409 naming the channel only when visible; Stremio and
  Spotify in one channel get 409 both ways; `ended` advances with gapless `next`; stale `seq` ignored; `unavailable` skips; `error io`
  retries once, then ends; playlist and artist pages come from the fake bot's catalog routes, not the mock Web API; the call empties so the bot is deleted; idle timeout (1 s); no house username or URL in any response or event.
- **Bot:** `cargo test -p spotify-bot` for the pure parts: desired-state diffing, lease expiry, the frame chunker (packet → 10 ms
  frames), the URI check, and the credentials-file mode check. A manual smoke test with `livekit-server --dev` and the house account.
- **Desktop:** vitest for the panel reducer, queue view, tile and the presence guard; one mock e2e: search, play, add an album,
  reorder, skip from a second user.

## 11. Build plan

**Phase 0, spike: done 2026-10-17** (branch `worktree-spotify-spike`, crate `tools/spotify-bot` with `login`, `tone`, `play`, `meta`
and `examples/listen`; this document carries the results in §1.1, §1.3, §2.4, §4.1, §4.3, §5, §6, §8, §9, §12). Outcomes: the
fork builds inside the workspace (no existing package changed version; 78 new lock entries; release build of the librespot
crates alone 1 min 25 s with `CARGO_BUILD_JOBS=4`, with livekit/libwebrtc about 4 min cold; the binary is 32.6 MB with libwebrtc,
7.6 MB for login alone); login works; audio is resampled to 48 kHz in the bot; the owner playing elsewhere does not kick the bot;
the Web API cannot give playlist tracks or artist top tracks, so the bot reads those over librespot (§4.3). §4 is frozen with
those changes. The bot worker removed the spike commands (`tone`, `play`, `meta`, `examples/listen`); they remain on branch `worktree-spotify-spike`.

Then three workers, by file ownership, against the frozen §4:
1. **Server:** `crates/server/src/spotify/{mod,webapi}.rs`, `voice/spotify.rs`, `voice/media.rs` (the shared signer, moved from
   `voice/stremio.rs`), the one-line activity check in `voice/stremio.rs`, `config.rs`, `routes/mod.rs`, `events.rs`, `voice/state.rs`
   and `voice/calls.rs` hooks, `crates/protocol/src/api.rs`, `docs/api.md`, `crates/server/tests/spotify.rs`. Writes the protocol
   types and `docs/api.md` first so the other two can start. Coordinate the `voice/stremio.rs` lines with the two Stremio workers.
2. **Bot:** `tools/spotify-bot/**` (start from the Phase 0 crate: `login.rs`, `pump.rs`, `resample.rs`, `build.rs`; replace the
   `tone`/`play`/`meta` spike commands with the HTTP API and §4.3), `deploy/launchd/org.vokko.spotify-bot.plist`,
   `deploy/.env.example`, a "Spotify in calls" section in `docs/self-hosting.md`. Tests against a stub server.
3. **Desktop:** `apps/desktop/src/spotify/**`, the Activities entry in `voice/VoiceChannelPage.tsx`, `voice/VoiceChannelRow.tsx`,
   `voice/reducer.ts` and the voice store for SPOTIFY_UPDATE, the `kind` in the call-level viewer owner, `activity/index.ts` (presence
   guard), `api/mock/spotify.ts` and `calls.ts`. Starts after `vokko-stremio-smooth` merges.

## 12. Open questions and risks

| # | Question / risk | Recommendation |
|---|---|---|
| 1 | House account: librespot is unofficial and Spotify can ban the account | Accepted by the owner |
| 2 | The fork's rev is from 2026-10-17 and may not share Vokko's lock file | **Resolved:** builds in the workspace, no existing package changed version (78 new lock entries), needs `-ObjC` via `build.rs` |
| 3 | The playback login depends on Spotify's desktop client id accepting `127.0.0.1:8898` | **Works** (owner logged in 2026-10-17 with `spotify-bot login`). If it breaks, Spotifast breaks too; the device-code flow is the fallback |
| 4 | Client credentials: Spotify's development-mode rules keep changing | **Verified** (§1.3): search, albums, artist albums, tracks work; artist top tracks 403, playlist tracks 403/401, batch `tracks?ids` 403. The bot reads playlist tracks and artist top tracks over librespot (§4.3). Rules may change again, so keep the Web API client to the allow-listed paths and treat a 403 as "page unavailable" |
| 5 | What happens when the owner plays elsewhere without Spirc | **Nothing** (§1.1): both streams play, neither is kicked, the bot sees no event. Spirc is not needed. Risk that Spotify enforces one stream per account later: the bot reports `error io` if the session ends |
| 6 | Bot plays in the owner's history or friend activity | **Not seen** (§9.7): not in Recently played on phone or desktop the same day; no librespot code reports plays, and a test keeps Connect out. Wrapped, recommendations and friend activity are unchecked |
| 7 | Per-user Spotify accounts | Later extension, not designed here |
