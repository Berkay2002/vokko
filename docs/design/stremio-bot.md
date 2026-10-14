# Stremio bot in voice calls (design)

Status: proposal, October 2026. Nothing here is built. It sits next to Watch Together (`crates/server/src/voice/watch.rs`,
`apps/desktop/src/watch/`) and copies its shape: one in-memory session per voice channel or DM call, `PUT|PATCH|DELETE` on
the channel, one gateway event, a big tile in the call grid.

Goal: someone in a call opens a Stremio panel, picks a movie or episode and a stream, and a participant named **Stremio**
joins the LiveKit room and publishes video and audio. Everyone watches its tile. Anyone in the call can pause, resume,
seek and stop, and there is a small Up next queue. Each user links their own Stremio account once. Playback uses the
invoking user's installed addons (TorBox debrid), so every stream is a direct HTTPS file. No torrent client runs on the home server.

Sources are cited inline. **[verified]** means checked against source or a live request. **[unverified]** means inferred,
to be confirmed in Phase 0.

## 1. Findings

### 1.1 Stremio account API

- Base URL `https://api.strem.io` (`API_URL` in stremio-core
  [constants.rs](https://github.com/Stremio/stremio-core/blob/development/src/constants.rs)). Every call is `POST /api/<method>`
  with a JSON body tagged by `type` ([request.rs](https://github.com/Stremio/stremio-core/blob/development/src/types/api/request.rs)).
  Replies are `{result: T}` or `{error: {code, message}}` ([response.rs](https://github.com/Stremio/stremio-core/blob/development/src/types/api/response.rs)). **[verified]**
- `login {type:"Login", email, password, facebook:false}` returns `result.authKey` plus `user`. **[verified live by the coordinator with a test account]**
- `addonCollectionGet {type:"AddonCollectionGet", authKey, update:true}` returns `result.addons[]` of
  `{transportUrl, manifest, flags}` and `lastModified`. **[verified live]** A bad key returns `{"error":{"code":1,"message":"Session does not exist"}}`. **[verified live]**
- `getUser {authKey}` validates a key, and `logout {authKey}` ends that session (paths from request.rs). **[verified in source]**
- **Linking without a password:** `GET https://link.stremio.com/api/v2/create?type=Create` returns
  `{result:{code, link:"https://link.stremio.com/<code>", qrcode}}`. **[verified live]**
  `GET .../api/v2/read?type=Read&code=<code>` returns `{error:{code:101,"Invalid or expired token"}}` until it is approved.
  After approval it returns `{result:{authKey}}` (`LinkAuthKey`, response.rs). The response shapes are verified. **[unverified]**: that
  opening the link in a browser that is logged in to Stremio approves it, and how long a code lives.
- Logging in with only an authKey works, because every call after login takes just `authKey`. We store the authKey and never
  the password. How long an authKey lives is **[unverified]**: treat error code 1 as "link again".
- What the test account has installed: Cinemeta, YouTube, OpenSubtitles v3, Anime Kitsu, TorBox (`stremio.torbox.app`),
  "Torrentio TB" (`torrentio.strem.fun/<torbox config>/…`), AutoStream, ThePirateBay+, and **Local Files at
  `http://127.0.0.1:11470`**, which must be ignored. The TorBox config sits in the transport URL path, so **a transport URL is a secret**. **[verified live]**

### 1.2 Addon protocol and Cinemeta

- Manifest at `<base>/manifest.json`. Resources are fetched at `/{resource}/{type}/{id}.json` or
  `/{resource}/{type}/{id}/{extra}.json`, where `extra` is a query string such as `search=…&skip=100`
  ([protocol.md](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md)). **[verified]**
- The manifest lists `resources`, `types`, `idPrefixes` and `catalogs`. Cinemeta is `https://v3-cinemeta.strem.io/manifest.json`
  (`CINEMETA_URL`, constants.rs), with resources catalog and meta, types movie and series, and idPrefixes `tt`. **[verified live]**
- Search: `/catalog/{movie|series}/top/search=<q>.json` returns `metas[] {id, type, name, poster, releaseInfo}`. **[verified live]**
- Meta: `/meta/series/tt0903747.json` returns `meta.videos[] {id:"tt0903747:1:2", season, episode, name, thumbnail, released}`. So an
  episode's stream id is `tt<imdb>:<season>:<episode>`, and a movie's is the bare `tt` id. **[verified live]**
- Stream object ([stream.md](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md)) **[verified]**:
  exactly one source among `url`, `ytId`, `infoHash` (+`fileIdx`, `sources`), `nzbUrl`, archive URLs, or `externalUrl`. Plus `name`
  (usually the quality), `title` (deprecated in favour of `description`), `subtitles`, and `behaviorHints {notWebReady, bingeGroup,
  proxyHeaders {request, response} (only with url + notWebReady), filename, videoSize, videoHash, countryWhitelist}`.
- Live from Torrentio TB: `/stream/movie/tt0111161.json` returned 211 streams in about 1.2 s. **All of them had `url`.** Names look like
  `[TB+] Torrentio 1080p`, titles are release names with size lines, and `notWebReady:false`. The `url` is
  `torrentio.strem.fun/resolve/torbox/…`, which redirects (about 2 s) to a TorBox CDN host (`*.tb-cdn.st`). That host serves
  `application/octet-stream` with **HTTP 206 range** support. Files can be very large (one REMUX was 22 GB). The TorBox
  addon's own `/stream` errored for `movie/tt0111161`, so its id handling is still unknown. **[verified live by the coordinator]**

### 1.3 Getting media into the LiveKit room

| Option | Simplicity | Mac CPU | Pause / seek | Cost on LiveKit Cloud | Verdict |
|---|---|---|---|---|---|
| (a) Ingress `URL_INPUT` (Cloud pulls the file) | Highest: one Twirp call | ~0 | No offset or seek field in `CreateIngressRequest`; it ends when the media is consumed ([livekit_ingress.proto](https://github.com/livekit/protocol/blob/main/protobufs/livekit_ingress.proto), [ingress overview](https://docs.livekit.io/home/ingress/overview/)) | Always transcoded: **$0.02/min**. Build plan: **60 transcode min/month, hard cap, 2 concurrent** ([pricing](https://livekit.com/pricing), [quotas](https://docs.livekit.io/deploy/admin/quotas-and-limits/)) | **Rejected.** One movie uses up the free month, there is no seek, and the TorBox URL goes to a third party |
| (b) ffmpeg 8 `-f whip` → WHIP ingress with `enable_transcoding=false` | High: ffmpeg only, no SDK | Encode in ffmpeg (VideoToolbox if ffmpeg runs on the host) | Each pause or seek is a new WHIP session, so the participant leaves and rejoins | Transcode-less import is **free** (pricing page) | **Fallback.** The FFmpeg WHIP muxer is marked experimental (8.0+, needs a DTLS backend, Opus timestamp FIXME, [whip.c](https://ffmpeg.org/doxygen/8.0/whip_8c_source.html)). Nobody has shown it working against LiveKit's bypass path **[unverified]** |
| (c) Rust bot with the `livekit` crate: ffmpeg decodes to raw frames, the SDK encodes and publishes | Medium: about 800 lines in a new crate | Decode + libwebrtc software encode in docker | Room and tracks stay up: pause stops feeding frames, seek restarts ffmpeg | WebRTC minutes + downstream data only | **Chosen** |
| (d) Node bot with `@livekit/rtc-node` | Same model as (c) | Same | Same | Same | No gain, and it adds a second runtime to deploy |

The `livekit` crate (0.9.5) exposes `NativeVideoSource::new(resolution, is_screencast)` and
`capture_frame(&VideoFrame)` ([docs.rs](https://docs.rs/livekit/latest/livekit/webrtc/video_source/native/struct.NativeVideoSource.html)) **[verified]**,
plus `NativeAudioSource` (the `play_from_disk` example publishes a WAV, [rust-sdks](https://github.com/livekit/rust-sdks)). The SDK
lists VideoToolbox hardware encoding on macOS, and NVIDIA/AMD/Jetson on Linux. **In an OrbStack Linux container there is no
hardware encoder**, so encoding is software (VP8/H.264 in libwebrtc). Linux arm64 prebuilt libwebrtc availability (webrtc-sys
needs clang 21+) is **[unverified]**: Phase 0 builds it in the arm64 image first.

Why (c): it is the only option where pause and seek leave the tile connected, it costs nothing beyond normal WebRTC usage,
and every API it relies on is documented. (a) fails on cost and on seek. (b) is cheaper on CPU, but it depends on an
experimental muxer and an unproven bypass path, and it reconnects on every pause. Phase 0 spends half a day trying (b); if
it works cleanly, it stays the documented "host mode" upgrade.

### 1.4 CPU, bandwidth and money (estimates, measure in Phase 0)

- **CPU (M4, 4P+6E, software, estimates [unverified]):** decoding 1080p H.264/HEVC 8-bit takes about 0.3–0.6 core. libwebrtc VP8 encode
  at 1080p30 and about 3 Mbit/s takes about 1–2 P-cores, and simulcast lower layers add about 25%. A 4K HEVC 10-bit source plus scaling to 1080p adds about 2–3 cores.
  HDR or Dolby Vision needs tone mapping (`zscale` + `tonemap`, ffmpeg built with zimg) or it looks washed out, and costs more.
  Hence the default ranking in §4.3: prefer 1080p, not REMUX, not HDR/DV. Cap output at 1080p30 (720p30 by default, see below).
- **Mac upload:** one published stream, 720p about 2 Mbit/s or 1080p about 3–4 Mbit/s, plus simulcast layers (about 0.5 Mbit/s).
  The download from TorBox runs at the file's bitrate (a 1080p web-dl is 5–10 Mbit/s, a REMUX 30–60 Mbit/s).
- **LiveKit Cloud Build plan (free, hard cap):** 5,000 participant-min/month and **50 GB downstream/month**. When either runs out,
  *all* voice fails until the 1st ([quotas](https://docs.livekit.io/deploy/admin/quotas-and-limits/)). A 2-hour movie with 4 viewers at
  3 Mbit/s is 4 × 2.7 GB ≈ **11 GB**, plus 120 bot participant-minutes. **That is about 4 movie nights a month before voice dies.**
  At 720p and 2 Mbit/s it is about 7 GB, so about 6 nights. On Ship ($50/mo): 250 GB, then $0.12/GB, so about $1.30 per extra 4-viewer movie.
  Recommendations: default to 720p at 2 Mbit/s, make 1080p a server setting, keep a monthly bot-bytes counter in logs, and alert at 30 GB.

## 2. Architecture

```
 desktop client                         vokko-server (docker)                     stremio-bot (docker, new)
 ───────────────                        ─────────────────────                     ─────────────────────────
 Stremio panel ──REST──▶ /users/@me/stremio/*   ──HTTPS──▶ api.strem.io, link.stremio.com
               ──REST──▶ /stremio/search|meta|streams ─▶ addon URLs (SSRF guard, timeouts)
               ──REST──▶ PUT/PATCH/DELETE /channels/{id}/stremio
                                 │  in-memory StremioSession per channel
                                 │  resolves stream url (follows redirects itself, IP checks)
                                 └──internal HTTP (bearer secret)──▶ PUT /sessions/{channel}  {livekit_url, token,
                                                                       media_url, headers, position_ms, playing}
                          ◀── POST /internal/stremio/bot {event, position_ms, duration_ms, error}
 gateway ◀── STREMIO_UPDATE {channel_id, state|null}                         ffmpeg (-ss, https only) → FIFOs
 bot tile ◀════════ LiveKit Cloud room v<channel_id> ◀══ WebRTC ════ livekit SDK: screen_share + screen_share_audio
                    identity bot:stremio:<channel_id>
```

- The **server owns all state and every secret**. The bot is stateless and holds only what it is given for one session. It has
  no database access, and it sits on its own docker network (`botnet`). The server is attached to both networks; Postgres only to the default one.
- The bot joins the **same LiveKit backend as the room** (the multi-backend failover in `voice/backends.rs`). If the room
  fails over, the server sends the bot a fresh `PUT` with the new backend's URL and token.
- The bot is not inside vokko-server. Linking libwebrtc into the server binary would put a crash-prone C++ dependency and
  2+ cores of encoding into the process that serves chat.

## 3. API

Every route requires auth. The Stremio routes return 404 10000 when `VOKKO_STREMIO=off` or no `VOKKO_SECRETS_KEY` is set.
Error codes reuse existing ones (50013 no access, 50035 validation, 40033 no session, 429 limits).

### 3.1 Account linking (per user)

| Method | Path | Body → Response |
|---|---|---|
| GET | /users/@me/stremio | → `{linked: bool, linked_at?}` |
| POST | /users/@me/stremio/link | → `{code, link, expires_at}` (server calls link `create`; the pending code is kept in memory for this user only) |
| POST | /users/@me/stremio/link/poll | → `{linked: bool}` (server calls `read`; when it gets an `authKey`, the server checks it with `getUser`, encrypts it and stores it). The client polls every 3 s for up to 5 min |
| POST | /users/@me/stremio/login | `{email, password}` → 204. Fallback. The password is used once and never stored or logged; the server stores only the returned `authKey` |
| DELETE | /users/@me/stremio | → 204: calls `logout` with the key (best effort), then deletes the row |

### 3.2 Browsing (server proxies; the client never talks to Stremio)

| Method | Path | Response |
|---|---|---|
| GET | /stremio/search?type=movie\|series&q= | `[{id, type, name, poster?, year?}]` from Cinemeta `top` search (q 1–100 chars) |
| GET | /stremio/catalog?type=&genre?=&skip? | Cinemeta `top` browse, same item shape |
| GET | /stremio/meta/{type}/{id} | `{id, type, name, poster?, background?, description?, year?, runtime?, videos:[{id, season, episode, name, released?}]}` |
| GET | /stremio/streams/{type}/{video_id} | Needs a linked account (else 403 50013). `[{sid, addon, label, details, size_bytes?, resolution?, flags:[hdr,dv,remux,…], playable, unsupported?:"torrent"\|"external"\|"youtube"}]`, ranked as in §4.3 |

`id` must match `^tt\d{1,10}$`, and a `video_id` must also match `^tt\d{1,10}(:\d{1,4}:\d{1,4})?$` (other id prefixes come later, see §9).
`sid` is 128 random bits (base64url), held in a server map `sid → {user_id, StreamCandidate}` with a 30-minute TTL.
It is **bound to the user who listed it**: a `sid` from someone else returns 400 50035.

### 3.3 Playback in a call (shaped like Watch Together)

| Method | Path | Body → Response |
|---|---|---|
| PUT | /channels/{id}/stremio | `{sid}` → `StremioState`: starts the bot or replaces the current item (keeps the queue). The caller must be connected to that voice channel or DM call right now, under the same join re-check as `watch.rs` (VIEW_CHANNEL + CONNECT, not timed out; DM recipient and not blocked; no stage channels, 400 50024) |
| PATCH | /channels/{id}/stremio | `{playing?, position_ms?, queue_add?: sid, queue_remove?: index, skip?}` → `StremioState`. `position_ms` is 0..=duration (or 0..=24h before the duration is known). Queue holds at most 10 |
| DELETE | /channels/{id}/stremio | → 204: stops for everyone (204 even when nothing is running) |

`StremioState {item: {title, subtitle?, poster?, label}, status: starting|playing|paused|buffering|error, error?, playing,
position_ms, updated_at_ms, duration_ms?, started_by, bot_identity, queue:[{title, subtitle?, poster?, label, added_by}]}`.
It has **no URLs except allow-listed poster hosts**. Expected position = `position_ms + (now - updated_at_ms)` while playing, same as Watch Together.

**Gateway:** `STREMIO_UPDATE {channel_id, state | null}` goes to everyone who can see the channel, the same audience as `WATCH_TOGETHER_UPDATE`.
The running session is sent to someone who joins the call. READY guilds, GUILD_CREATE and the `Call` object carry `stremio: [{channel_id, state}]`
for the sidebar line ("Watching *Title* on Stremio").

**Internal (server ↔ bot, never through Caddy):** the bot listens on `botnet:8720`, and both directions use
`Authorization: Bearer $VOKKO_STREMIO_BOT_SECRET` (constant-time compare).
- `PUT /sessions/{channel_id}` sets the desired state `{livekit_url, token, media_url, headers:{}, position_ms, playing, max_height, bitrate}`.
  It is idempotent and re-sent every 60 s as a **lease**. The bot drops any session not renewed for 150 s.
- `DELETE /sessions/{channel_id}`. `DELETE /sessions` drops all sessions; the server sends it at startup.
- The bot sends `POST /internal/stremio/bot` with `{channel_id, event: started|position|ended|error, position_ms, duration_ms?, message?}`
  (position every 5 s). The route lives next to `/internal/livekit/webhook` and is not exposed by the Caddyfile.

## 4. Server design

### 4.1 Data model

`crates/server/migrations/<YYYYMMDDHHMMSS>_stremio_accounts.sql` (for example `20261015120000_stremio_accounts.sql`):

```sql
CREATE TABLE stremio_accounts (
    user_id      BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    auth_key_enc BYTEA NOT NULL,          -- nonce(24) || XChaCha20-Poly1305 ciphertext, AAD = "stremio:" || user_id
    key_version  SMALLINT NOT NULL DEFAULT 1,
    linked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);
```

Only the authKey is stored. The addon list (and its secret transport URLs) is fetched with `addonCollectionGet` when needed and
cached **in memory** per user for 5 minutes. Sessions, the `sid` map and pending link codes are all in memory, like Watch Together.

### 4.2 Modules (new files, existing patterns)

- `crates/server/src/crypto.rs`: `seal(key, aad, plaintext)` and `open(...)` with `chacha20poly1305` (new dependency, justified: no AEAD exists in the tree).
  The key comes from `VOKKO_SECRETS_KEY` (32 bytes base64). `key_version` leaves room to rotate later.
- `crates/server/src/stremio/mod.rs`: router plus account routes. `client.rs`: api.strem.io and link.stremio.com calls. `addons.rs`:
  manifest, catalog, meta and stream fetches through the guarded HTTP client (§6). `rank.rs`: the pure stream parser and ranker.
- `crates/server/src/voice/stremio.rs`: `PUT|PATCH|DELETE /channels/{id}/stremio`, the session map, the bot client, and lease renewal.
  It reuses `watch.rs`'s connection re-check and `state.limiter.check_key`.
- `crates/server/src/config.rs`: `VOKKO_STREMIO` (on/off), `VOKKO_SECRETS_KEY`, `VOKKO_STREMIO_BOT_URL`, `VOKKO_STREMIO_BOT_SECRET`,
  `VOKKO_STREMIO_MAX_HEIGHT` (720), `VOKKO_STREMIO_BITRATE_KBPS` (2000), `VOKKO_STREMIO_PAUSE_TIMEOUT_MIN` (15), `VOKKO_STREMIO_FETCH_ALLOW` (CIDR list, empty).
- Bot token: `token::sign` with `grant(room, …)` for identity `bot:stremio:<channel_id>`, name `Stremio`, metadata
  `{"bot":"stremio","channel_id":"…"}`, `canPublish` limited to `screen_share` + `screen_share_audio`, `canSubscribe:false`, `canPublishData:false`.
  The existing reconciliation already skips non-numeric identities (`Participant::user_id()` returns `None`, so `state.rs`'s
  sweeps `continue`), so the bot is never kicked as a stray. Add a test that pins this.

### 4.3 Stream listing and ranking

1. Take the caller's addons. Drop any transport URL that is not `https`, or whose host resolves to a non-public IP (this drops Local Files on 127.0.0.1:11470),
   unless it is in `VOKKO_STREMIO_FETCH_ALLOW`. Keep the addons whose manifest has the `stream` resource for that type and a matching `idPrefixes` entry.
2. Fetch `/stream/{type}/{video_id}.json` from all of them in parallel: 8 s each, 2 MiB body, 300 streams per addon. A failing addon
   (like TorBox's own `/stream`) is skipped and listed as `addon_errors: [name]`.
3. Classify: `url` (https) → playable. `infoHash` only → `unsupported: torrent` (shown disabled). `ytId` → `unsupported: youtube`
   (the UI offers "Open in Watch Together", which is trivial since that feature exists). `externalUrl`/`nzbUrl`/archives → disabled.
4. Parse `name`/`description`/`title` (pure function, unit-tested on real Torrentio TB samples): resolution (2160/1080/720/480), size (`💾 22.4 GB` and
   similar), and flags `REMUX`, `HDR`, `DV`, `HEVC/x265`, `10bit`, plus `behaviorHints.videoSize` when present.
5. Rank: playable first. Then the resolution closest to `max_height` (1080 beats 2160 when the cap is 720/1080). Non-HDR and non-DV beat HDR/DV,
   non-REMUX beats REMUX, and a size between 1 and 15 GB for a movie (0.3–4 GB per episode) beats outliers. Ties go to addon order.
   The UI marks HDR/DV/REMUX/4K as "heavy". Labels and details are cut to 120/300 characters with control and bidi characters removed (same rule as Watch Together titles).

### 4.4 Play

On `PUT`/`skip`: look up the `sid` (bound to the caller) and take the stored `StreamCandidate.url`. The server **resolves redirects
itself**: `GET` with `Range: bytes=0-0`, at most 5 hops, the guard (§6) applied on every hop, 10 s in total. That gives the final CDN URL
and checks for a `206`/`200` with a video-ish or octet-stream type. It then sends the bot the final URL plus only allow-listed `proxyHeaders.request`
(`User-Agent`, `Referer`). The resolver URL (it carries the TorBox config) stays on the server. When the bot reports an `error`
with HTTP 403/410 (likely an expired CDN link, **[unverified]** TorBox TTL), the server re-resolves once from the stored resolver URL and re-sends `PUT`.

## 5. Bot process (`tools/stremio-bot`, a new binary crate)

It goes under `tools/*` because that is a workspace member but **not** a default member, so `cargo test` for the server never builds libwebrtc.
New files: `deploy/stremio-bot.Dockerfile` (bookworm + ffmpeg from Debian, 5.1 is enough because ffmpeg only decodes here, built with zimg)
and a `stremio-bot` service in `deploy/docker-compose.yml` under `profiles: ["stremio"]`, on `botnet`, with no published ports.

- **Per session:** connect with the given token, then publish a `NativeVideoSource` (screencast flag, `max_height`, VP8, simulcast on,
  `max_bitrate`) as `SCREEN_SHARE` and a `NativeAudioSource` (48 kHz stereo, echo cancellation, noise suppression and AGC off) as `SCREEN_SHARE_AUDIO`.
- **ffmpeg (one process, so audio and video share one clock):**
  `ffmpeg -nostdin -loglevel error -protocol_whitelist https,tls,tcp -reconnect 1 -reconnect_on_network_error 1 -rw_timeout 15000000
  -headers <allowed> -re -ss <pos> -i <url> -map 0:v:0 -vf "scale=-2:'min(<max_height>,ih)',fps=30,format=yuv420p" -f rawvideo <fifo-v>
  -map 0:a:0? -ac 2 -ar 48000 -f s16le <fifo-a>`. Two reader threads drain the FIFOs (one frame = w·h·1.5 bytes; audio in 10 ms chunks)
  into `capture_frame`. `-re` paces the output. Video timestamps come from the frame count and audio is pushed as it arrives. Phase 0 checks
  sync with a clap-test clip; the target is under 80 ms skew. With an HDR source (ffprobe `color_transfer=smpte2084|arib-std-b67`), add a
  `zscale/tonemap` chain and report status `heavy`.
- **Pause:** kill ffmpeg and stop feeding frames. The tracks stay published, viewers see the last frame, and the server state shows the Paused overlay.
  **Resume or seek:** restart ffmpeg with `-ss <pos>`. Input seeking over HTTP range is fast, about 1–3 s to the first frame (estimate).
  **Stop:** unpublish, disconnect, delete the FIFOs.
- **Position:** the last audio PTS (or video when there is no audio) plus the seek offset, reported every 5 s. EOF is `ended`. A non-zero exit is
  retried once from the last position, then reported as `error`.
- **Limits:** at most `VOKKO_STREMIO_MAX_SESSIONS` (2) concurrent sessions. Past that, the bot returns 503 and the server returns 400 "the bot is busy".

## 6. Security rules

1. **Secrets at rest:** the authKey is sealed with XChaCha20-Poly1305 under `VOKKO_SECRETS_KEY`, with the user id as AAD so a row cannot be swapped
   between users. Without the key, the feature is off.
2. **Never to clients:** authKeys, transport URLs, stream `url`s (resolver or CDN) and `proxyHeaders`. Clients see only titles, posters, labels, details,
   size and the opaque `sid`. The protocol types in `crates/protocol` have no URL field for streams. A test serializes every response and event and checks for `http`/`authKey`.
3. **Never in logs:** wrap the authKey and URLs in a `Secret` newtype whose `Debug` prints `<redacted>` (stremio-core does the same).
   The log line shows the addon name and host only. Never log the request body of `/login`.
4. **Only your own account resolves:** a `sid` is bound to its lister. A queued item records `added_by` and was resolved from that user's account.
   Others can control playback but cannot list or resolve with someone else's addons.
5. **Who controls:** anyone connected to the call, re-checked on every request (the `watch.rs` rule). Stage channels are refused.
6. **Rate limits** (`limiter.check_key`): link and login 5 per hour per user; search, catalog and meta 10 then 2/s; streams 5 then 1 per 3 s;
   PUT `/stremio` 3 per minute per user; PATCH controls the same as Watch Together (10 then 2/s).
7. **SSRF guard** for every outbound fetch (addon base URLs, resolver URLs, every redirect hop): only `https`, port 443 (or allow-listed),
   DNS resolved by us with **every** address checked by `unfurl::is_public_ip` and the connection pinned to the checked address (reqwest `resolve`)
   to stop DNS rebinding. `VOKKO_STREMIO_FETCH_ALLOW` opens CIDRs for a self-hosted addon. Timeouts: 5 s connect, 8 s total (10 s resolve).
   Body limit 2 MiB for JSON, URLs at most 4 KB, at most 5 redirects, and no cookies. Reuse or extract unfurl's limits code rather than writing a second copy.
8. **ffmpeg's own fetching** (residual risk): ffmpeg follows redirects itself, and a CDN host could in principle redirect elsewhere. Mitigations:
   the server hands over the already-resolved final URL, `-protocol_whitelist https,tls,tcp` blocks `file:`, `concat:`, `http:` and HLS tricks,
   and the bot container is on `botnet`, with no route to Postgres or the server's data and no secrets beyond the per-session token.
   It can still reach the host LAN. Accepted for a self-hosted, invite-only server, and listed in §9.
9. **Bot channel:** the bearer secret is separate from the LiveKit secret, the port is unpublished, and the lease means a stolen
   session dies within 150 s once the server stops renewing it.

## 7. UI flow (desktop)

- The call bar gets an **Activities** button next to Watch Together. Its menu has *Watch Together (YouTube)* and *Stremio*, and opens the **Stremio panel**
  (a side sheet, `apps/desktop/src/stremio/`).
- **Not linked:** a "Link your Stremio account" card with **Open Stremio link** (opens `link` in the browser and shows the 4-character code and the QR)
  while the client polls. Underneath, "Sign in with email instead" (the password fallback). After success: "Linked. Your installed addons are used."
- **Search and browse:** a search field with Cinemeta "Popular movies / series" rows. The poster grid uses `<img loading=lazy>`, with CSP `img-src`
  for `images.metahub.space`, `episodes.metahub.space` and `m.media-amazon.com`.
- **Title page:** backdrop, year, runtime, description. Series get a season picker and an episode list with thumbnails.
- **Stream list:** grouped by addon, showing a quality chip (1080p/4K), size, and HDR/DV/REMUX "heavy" chips. The best match is pre-selected. Disabled rows
  ("Torrent: not supported", "YouTube: open in Watch Together"). **Play in call** (or **Add to Up next** when something is playing).
- **Bot tile** (`StremioTile`, big tile like `WatchTile`): attaches the LiveKit screen-share track of `bot_identity` and **auto-subscribes**
  (the client's screen-share subscription is opt-in through `watching` in `livekitVideo.ts`, so the bot must be added to it). It shows the
  poster and status while there is no track ("Starting…", "Paused", "Buffering", errors), a seek bar driven by the server state, play/pause, ±10 s,
  stop, local volume (`volumeOf(identity)` already exists), and Up next.
- The participant list shows it as **Stremio** with a BOT badge and no profile. Any identity starting `bot:` is skipped wherever the client
  maps an identity to a user (speaking indicators, `dataset.userId`, volume menus).

## 8. Lifecycle

| Trigger | Result |
|---|---|
| Last human leaves the call (the hook where Watch Together ends in `voice/state.rs`) | Server `DELETE`s the bot session, STREMIO_UPDATE null |
| Paused longer than `VOKKO_STREMIO_PAUSE_TIMEOUT_MIN` (15) | Stop |
| `ended` | Next queue item (resolved as in §4.4), else stop |
| `error` | One re-resolve and retry, then `status:error` on the tile for 30 s, then stop |
| Invoker leaves, others stay | Keeps playing (the URL is already resolved) |
| Invoker unlinks | The current item continues; their queued items are dropped |
| Server restart | Sessions are lost (in memory, like Watch Together). At startup the server sends `DELETE /sessions`; the lease covers a missed call |
| Bot restart | The server sees `PUT` fail or a missing lease and re-sends `PUT` at the last position (once), else stop |
| Room moved to another LiveKit backend | New token and URL in `PUT`; the bot reconnects |

## 9. Test plan (no real Stremio, TorBox or LiveKit needed)

- **Unit (server):** `rank.rs` on recorded Torrentio TB stream JSON (anonymised: URLs replaced). Id validation. Seal/open round-trip and wrong-AAD failure.
  The SSRF guard on 127.0.0.1, 10/8, ::ffff:127.0.0.1, rebinding (DNS returns public then private), redirect to private, oversize body, and a slow-loris timeout.
- **Integration (`crates/server/tests/stremio.rs`):** a **mock Stremio + addon server** (axum on a random port, allowed through `VOKKO_STREMIO_FETCH_ALLOW=127.0.0.1/32`)
  that implements `/api/login`, `/api/addonCollectionGet`, link `create/read`, a manifest, `/catalog`, `/meta` and `/stream` with url, infoHash, ytId and a 302 → 206 file.
  A **fake bot** (axum) records `PUT`/`DELETE` calls and posts events. The fake LiveKit `RoomService` already exists in `voice/livekit.rs` tests.
  Cases: link then list then play then pause/seek/stop from another member; a foreign `sid` gets 400; a non-member gets 403; the call empties so the bot is deleted;
  the pause timeout (configurable to 1 s); `ended` with a queue; no secret in any response or event (string scan); the rate limits.
- **Bot:** `cargo test -p stremio-bot` covers the pure parts: building the ffmpeg command line, the lease expiry and the position math. A manual smoke test
  (`docs/design` checklist) against a local `livekit-server --dev` and a test MP4 served over HTTPS, with a clap clip for A/V sync, and CPU measured with `top` at 720p and 1080p.
- **Desktop:** vitest for the panel reducer and the tile (mock backend, same routes and event as Watch Together's mock), plus one mock e2e: link, search, play, pause from a second user.
- **Live (manual, opt-in):** an integration test gated on `~/.vokko/stremio-test.authkey` (exists on the PC) that lists real addons and a stream list for
  `movie/tt0111161`. Never run in CI, and never print the key or URLs.

## 10. Build plan (worker briefs)

**Phase 0, spike (half a day, one worker, before the rest):** build `tools/stremio-bot` skeleton in the arm64 docker image (proves libwebrtc prebuilt),
publish a test MP4 to `livekit-server --dev`, measure CPU at 720p and 1080p, and check A/V sync. Spend 1 hour on option (b) (`ffmpeg 8 -f whip` → WHIP ingress, bypass).
Report numbers, then lock the choice.

1. **Server: accounts, browsing and the session API** (`crates/server/src/crypto.rs`, `stremio/{mod,client,addons,rank}.rs`,
   `voice/stremio.rs`, `config.rs`, `routes/mod.rs`, `events.rs`, `voice/state.rs` (end hook), `voice/calls.rs`, migration,
   `crates/protocol/src/api.rs`, `docs/api.md`, `crates/server/tests/stremio.rs` with the mock addon server and fake bot).
   Depends on nothing; it talks to the bot only through the documented internal API.
2. **Bot** (`tools/stremio-bot/**`, `deploy/stremio-bot.Dockerfile`, `deploy/docker-compose.yml` profile, `deploy/.env.example`, `docs/self-hosting.md` section).
   Builds against the internal API in §3.3 and tests against a stub server.
3. **Desktop** (`apps/desktop/src/stremio/**`, the call bar Activities menu in `voice/VoiceChannelPage.tsx`, `voice/reducer.ts` for STREMIO_UPDATE, `voice/livekitVideo.ts`
   and `livekitTransport.ts` for `bot:` identities and auto-subscribe, CSP in `src-tauri/tauri.conf.json`, mock backend routes, vitest, one mock e2e).
   Starts after Watch Together merges (same files), builds against the mock, and needs only §3 frozen.

## 11. Open questions and risks

| # | Question / risk | Recommendation |
|---|---|---|
| 1 | Which LiveKit Cloud plan is the project on? On Build, about 4 movie nights use up the 50 GB and stop **all** voice until the 1st | Default 720p at 2 Mbit/s, log bot bytes, alert at 30 GB. Move to Ship ($50) if it gets used weekly |
| 2 | libwebrtc on Linux arm64 in docker (prebuilt or not, clang 21) | Phase 0 first. If it fails, use option (b) or run the bot natively on the macOS host (VideoToolbox, lower CPU) |
| 3 | CPU with 4K/HDR sources | The ranker avoids them; flag them "heavy"; tone-map only when chosen |
| 4 | Link-code approval semantics and the authKey lifetime [unverified] | Ship link and password both. On error code 1, mark the account unlinked and prompt to relink |
| 5 | TorBox CDN link expiry during a long pause [unverified] | Re-resolve on 403/410 (§4.4) |
| 6 | TorBox's own addon `/stream` errors for `tt` ids | Skip the failing addon. Torrentio TB covers it. Revisit the id handling later |
| 7 | Subtitles (OpenSubtitles addon) and audio-language choice | Not in v1. Later: an audio-track picker (ffprobe) and burned-in subtitles (costs CPU) |
| 8 | Watch Together and Stremio at once in one call | Allow both (separate tiles). Revisit if confusing |
| 9 | ffmpeg can reach the host LAN through a redirect | Accepted residual (§6.8). Tighten with an egress-only network if the server ever hosts strangers |
| 10 | Catalogs from user addons (Kitsu, TorBox catalogs) and non-`tt` ids | v1 is Cinemeta only. Widen id validation per addon `idPrefixes` later |
| 11 | Two concurrent sessions max (CPU, Build plan) | `VOKKO_STREMIO_MAX_SESSIONS=2`, 400 "the bot is busy" past that |

**Legal and operational note.** The bot does not download or seed torrents. It only reads files over HTTPS from the user's own debrid account
(TorBox), which the user pays for and configured in their own Stremio. Whether the content may be watched is the linking user's
responsibility under their TorBox terms and local law. Vokko stores no media: it re-encodes in memory for the people in a private call and
keeps nothing on disk. Operators of public servers should leave `VOKKO_STREMIO=off`. The feature is meant for small invite-only servers like this one.

## 12. Decision (2026-10-14): movie video on a self-hosted LiveKit on the home server, voice stays on LiveKit Cloud

The owner chose a split, which replaces the Cloud-only parts above (§2 bot joins "the same LiveKit backend as the room", §11 #1 and #2):

- **Media LiveKit:** `livekit-server` runs **natively on the home server host** (Homebrew `livekit`, a launchd agent, config in
  `deploy/media-livekit.yaml`), separate from the Cloud project. Signalling goes through `wss://live.vokko.example.com` (a DNS-only record to the home
  IP, Caddy or livekit's own TLS; decided in the bot phase), and media through router port forwards on the the home router (one UDP port with
  `rtc.udp_port` mux, plus TCP 7881 as fallback). The home line is ~850 Mbit/s up, so bandwidth is not a concern. Router and DNS changes are made last,
  with the owner's go-ahead.
- **Bot:** also **native on the macOS host** (launchd), not docker: no libwebrtc-in-docker risk, and libwebrtc can use VideoToolbox on macOS.
  The server (docker) reaches it at `http://host.internal:<port>` (OrbStack) with the bearer secret; the bot reaches the server at `http://127.0.0.1:8710`.
- **Server config:** `VOKKO_MEDIA_LIVEKIT_URL`, `VOKKO_MEDIA_LIVEKIT_API_KEY`, `VOKKO_MEDIA_LIVEKIT_API_SECRET`. The bot's room on the media server is
  `stremio-<channel_id>`. Without these the feature is off.
- **Viewers:** the call itself stays on Cloud. To watch, the client opens a **second, subscribe-only LiveKit `Room`** to the media server using a viewer token
  from `POST /channels/{id}/stremio/viewer-token` (same in-voice access check as the controls, `canPublish: false`, `canPublishData: false`, TTL 6 h).
  The StremioTile owns that second Room: it connects when a session exists and the user is in the call, and disconnects when the session ends or they leave.
  Movie audio comes from that Room (local volume applies); voice keeps coming from the Cloud room.
- Quality default becomes **1080p at up to 6 Mbit/s** (no data cap now); 720p stays as a per-session option.
- Data usage alerts (§11 #1) are dropped.
