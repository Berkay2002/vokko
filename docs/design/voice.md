# Voice, video, screenshare and stage (design)

Status: proposal (design only, no product code). Decided before this doc: media goes through a self-hosted **LiveKit** SFU,
the Rust server (`vokko-server`) stays the authority for every permission, and the target box is small (a small home server,
1-2 cores / 1-2 GB RAM budget for Vokko itself), so every default is modest and every ceiling is an instance setting.

Inputs: `docs/architecture.md`, `docs/api.md`, `apps/desktop/src/api/types.ts`, `docs/parity.md`, `docs/parity-inventory.md`
(DM-001/008, GLD-007/015, SET-004/005, DESK), the maintainers' private Discord client notes (gateway ops 4/13/18-22, Q1b.15
VOICE_STATE_UPDATE, permission bits, channel keys), the private Discord Nitro perks notes (N6, N13, N17, N24, boost table).
"Discord does X" claims below come from those files; anything else is marked **proposal** or **verify**.

## 1. Architecture

```
 React webview (Tauri / browser)                vokko-server (Rust, axum)                 LiveKit (Go SFU)
 ───────────────────────────────                ─────────────────────────                 ────────────────
 gateway ws ── op 4 VOICE_STATE_UPDATE ───────▶ permission check, voice state table
            ◀── VOICE_SERVER_UPDATE {endpoint, token}   mint JWT (grants from permissions)
 livekit-client ── wss + ICE/UDP ─────────────────────────────────────────────────────────▶ room "v<channel_id>"
                                                ◀── webhooks (participant/track events) ──
                                                ── RoomService (Twirp): update/mute/remove ▶
 gateway ws ◀── VOICE_STATE_UPDATE (fan-out to everyone who can see the channel)
```

Media never touches vokko-server or the Tauri JSON bridge (architecture.md: "media frames must not travel through this JSON
command endpoint"). vokko-server only issues tokens, keeps the voice-state table, and steers LiveKit through its server API.

### 1.1 Rooms and identities
- One LiveKit room per voice-capable channel: room name `v<channel_id>` (guild voice, stage, DM, group DM alike; channel ids
  are globally unique snowflakes, so no guild prefix is needed). Rooms are created on first join (`room.auto_create: true`) and
  closed by LiveKit after `empty_timeout`. Only vokko-server holds the API secret, so nobody can join a room it did not grant.
- Participant identity = the user id (snowflake string). LiveKit allows one participant per identity per room and kicks the
  older one (`DUPLICATE_IDENTITY`); that matches Discord's rule of one voice connection per user. A user is in at most one
  room at a time: joining another channel moves them (vokko-server removes them from the old room).
- Participant `name` = display name at join time (cosmetic; clients render names from their own member store).
- Participant `metadata` = `{"session_id": "<voice session id>"}`; participant `attributes` (server-set, read-only for the
  client): `vokko.priority = "1"` when the user has PRIORITY_SPEAKER, `vokko.vad = "0"` when USE_VAD is missing.

### 1.2 Joining (gateway op 4)
1. Client sends `op 4 VoiceStateUpdate {guild_id, channel_id, self_mute, self_deaf, self_video}` (Discord's shape, client
   facts §Q1b.1 op table). `channel_id: null` = leave.
2. Server resolves channel permissions with the existing `access.rs` algorithm and checks, in order: channel is voice-capable,
   VIEW_CHANNEL + CONNECT (DM/group DM: participant and not blocked, see §4.2), not timed out (timeouts already mask to
   `TIMEOUT_ALLOWED`, which lacks CONNECT, so this falls out), `user_limit` (bypass: MOVE_MEMBERS, as in Discord), instance and
   per-guild caps. Failure → dispatch `VOICE_CONNECT_FAILED` to that session only (new, §2.3) and nothing else.
3. On success the server writes the voice state (`connected: false`, `connected_at` = now, new `session_id`), dispatches
   `VOICE_SERVER_UPDATE {guild_id, channel_id, endpoint, token}` to the requesting gateway session only, and broadcasts
   `VOICE_STATE_UPDATE` to everyone who can see the channel (Discord shows the user in the channel immediately; so do we).
4. The client connects with `livekit-client`. LiveKit fires `participant_joined` → server marks the state `connected`.
   If no `participant_joined` arrives within `VOKKO_VOICE_CONNECT_TIMEOUT_SECS` (default **30 s**), the server drops the state and broadcasts `channel_id: null`.
5. Mute/deafen/video toggles are op 4 with the same `channel_id` (no new token unless the grant changes).

### 1.3 Token minting (grants from permissions)
HS256 JWT signed with the LiveKit API secret; `iss` = API key, `sub` = user id, `exp` = now + 10 min (LiveKit refreshes the token
for connected participants, so the TTL only bounds how long a leaked VOICE_SERVER_UPDATE is usable). `video` grant:

| Grant | Value | Source |
| --- | --- | --- |
| `room`, `roomJoin` | `v<channel_id>`, true | op 4 target |
| `canSubscribe` | `!deaf` (server deafen) | DEAFEN_MEMBERS state |
| `canPublish` | true if `canPublishSources` is non-empty | |
| `canPublishSources` | `microphone` if SPEAK and not `mute` and not `suppress`; `camera`, `screen_share`, `screen_share_audio` if STREAM (camera also needs the channel's video cap free) | channel permissions |
| `canPublishData` | false (V1-V6); effects/soundboard go through the gateway, not data channels | abuse surface |
| `canUpdateOwnMetadata` | false | server owns metadata/attributes |
| `hidden`, `recorder` | false | |

Self mute/deaf are client state only (the client stops sending / stops playing); the token does not change for them.
PRIORITY_SPEAKER and USE_VAD cannot be expressed as SFU grants; they travel as attributes and are applied by clients (Discord
also enforces both client-side). This is documented as a known trust gap, not hidden.

### 1.4 Keeping LiveKit in line with permissions
vokko-server calls LiveKit's RoomService (Twirp/HTTP on the signal port) when authority changes while someone is connected:

| Trigger | Action |
| --- | --- |
| Server mute / unmute (MUTE_MEMBERS) | `UpdateParticipant` with new `canPublishSources` (drops `microphone`), plus `MutePublishedTrack` on the mic track so it stops instantly |
| Server deafen (DEAFEN_MEMBERS) | `UpdateParticipant canSubscribe=false` and the server-mute action (Discord: deafen implies mute) |
| Move (MOVE_MEMBERS, PATCH member `channel_id`) | `RemoveParticipant` from the old room, new VOICE_SERVER_UPDATE to the moved user's session |
| Disconnect (PATCH member `channel_id: null`), kick, ban, leave guild, guild/channel delete | `RemoveParticipant` (or `DeleteRoom` for a deleted channel), state removed |
| Role / overwrite / member-role / timeout change | recompute every connected member of the affected guild or channel: lost VIEW_CHANNEL or CONNECT → remove; SPEAK/STREAM/PRIORITY_SPEAKER/USE_VAD changed → `UpdateParticipant` (permission + attributes) |
| Stage speaker promoted / demoted | `UpdateParticipant` (§4.5) |

Recompute is bounded: only voice-connected users are touched, so a role edit in a 1000-member guild costs one pass over the
handful of people in voice.

### 1.5 Webhooks back from LiveKit
`POST /internal/livekit/webhook` on vokko-server (not under `/api/v1`, not CORS-enabled; bind it to the docker network or
loopback where possible). LiveKit signs each request: `Authorization` is a JWT signed with the API secret whose `sha256` claim
is the base64 SHA-256 of the body; reject anything else with 401. Events used:

| Event | Effect |
| --- | --- |
| `participant_joined` | state `connected = true` (match identity + room + `metadata.session_id`; stale session → `RemoveParticipant`) |
| `participant_left` | if the session, the latest token and the last joined participant `sid` match the current state: remove it and broadcast `channel_id: null` |
| `track_published` / `track_unpublished` | set `self_video` (source camera) / `self_stream` (source screen_share) from truth, broadcast; screenshare above the guild's cap → `MutePublishedTrack` (§4.4) |
| `room_finished` | sweep the connected states still pointing at the room on that backend, except those that connected after the event was created (a late event about an earlier instance of the room); end the DM call if it was one (§4.2) |

Webhooks can arrive late, twice or out of order: handlers are idempotent, keyed by participant `sid`, and ignore events older
than the state's `connected_at`. A reconciliation task calls `ListParticipants` for rooms with live states every 60 s and on
server start, so a vokko-server restart rebuilds the table from LiveKit instead of disconnecting everyone.

### 1.6 Voice state lifecycle and the gateway
- Voice states are in memory (they are ephemeral in Discord too), keyed by user id, rebuilt from LiveKit on restart.
  Persisted: guild member `mute`/`deaf` (server mute survives rejoin, as in Discord), channel `bitrate`/`user_limit`/
  `video_quality_mode`, guild media settings, stage instances, soundboard sounds, call system messages.
- A voice state belongs to a gateway session. Gateway resume (op 6) keeps it. If the gateway session dies for good (resume
  buffer gone, or no reconnect within **60 s**), the server removes the participant. A new gateway session that wants to stay
  in voice re-sends op 4 for the same channel. When the state has no live owner (restored after a server restart, or its old
  gateway session is detached) the server re-binds it to the new session and keeps its voice `session_id` and token: no
  VOICE_SERVER_UPDATE, only the VOICE_STATE_UPDATE, so the client's LiveKit room stays up. A client that lost its media
  meanwhile sends op 4 again on the new session and gets a fresh token for the same voice session. An old session the
  server still sees as attached is treated like another device (new binding, new token, the client reconnects).
- Joining from a second device moves voice there (Discord behaviour): the old session sees VOICE_STATE_UPDATE with a
  different `session_id` and tears down its LiveKit room; LiveKit's duplicate-identity kick is the backstop.
- Delivery: VOICE_STATE_UPDATE goes to everyone who can see the channel (guild) or to the call's recipients (DM/group DM),
  same visibility rule as messages. When someone loses VIEW_CHANNEL they get `channel_id: null` updates for that channel's
  occupants (the client drops them; cheap and avoids stale avatars).
- READY guild entries and GUILD_CREATE carry `voice_states` (Discord sends them in GUILD_CREATE and READY_SUPPLEMENTAL; we
  put them in READY directly because there is no supplemental event). Ongoing DM calls arrive as CALL_CREATE right after READY.
- Speaking state is **not** sent through the gateway. Clients connected to the room get it from LiveKit; the channel list
  shows speaking rings only to people in the same call (Discord does the same).

### 1.7 Server code layout (proposal)
`crates/server/src/voice/{mod,state,token,livekit,webhook,calls,stage}.rs`. LiveKit access: the `livekit-api` crate
(Apache-2.0; token + webhook verification + Twirp RoomService) if its dependency tree fits the workspace, otherwise ~250 lines
on top of the existing `reqwest` + a JWT crate. Config env vars: `VOKKO_LIVEKIT_URL` (public wss URL handed to clients),
`VOKKO_LIVEKIT_API_URL` (internal http URL, default derived), `VOKKO_LIVEKIT_KEY`, `VOKKO_LIVEKIT_SECRET`; voice is disabled
(op 4 → `VOICE_CONNECT_FAILED media_unavailable`) when unset. No new crate, so `cargo xtask layers` is unaffected.

#### Multiple LiveKit backends with failover
`Config::livekit` is an ordered list (backend 0 = the variables above; `_2`, `_3`, ... add `URL`, `API_KEY`, `API_SECRET`, optional
`API_URL` and `LABEL`, until the first index with none of the first three set; a partial or gapped backend is a config error).
`voice/backends.rs` holds one RoomService per backend plus its health:

- **Placement.** A room (`v<channel id>`) lives on one backend while anyone is in it; `VoiceEntry::backend` records it, so the
  channel's backend is the one its participants are on. A join into an empty channel picks the first backend in rotation (all
  out: backend 0), under the same lock as the insert of the joiner's state, so two joins cannot split a room. A restore lists
  rooms on every backend and gives each restored state the backend it was listed on.
- **Health.** An API call that fails with HTTP 401/403/429, Twirp `resource_exhausted`/`unauthenticated`/`permission_denied`
  or connect/timeout (`RoomError::is_unavailable`) takes the backend out of rotation for `voice_backend_cooldown` (5 min). The
  cooldown is passive: reconciliation lists every backend each pass, and the first call after the cooldown either leaves it in
  or starts another one. Rooms already on it stay; nothing moves a live call.
- **Tokens.** The token is signed with the room's backend key/secret and `VOICE_SERVER_UPDATE.endpoint` is that backend's URL
  (the client connects to whatever endpoint the server sends).
- **Webhooks.** Verified against each backend's key and secret; the matching backend decides which states the event can touch
  (a leftover empty room finishing on another backend does not end a live call).
- **Restore.** Per backend: an unreachable one is retried with backoff while the others are restored and reconciled; DM calls
  are recovered once every backend is restored, or after 2 minutes with at least one restored (calls that lived on a
  still-unreachable one end). A backend that restores late skips participants of channels whose room already lives on
  another backend; reconciliation removes them there and their clients rejoin the live room. Reconciliation skips the rooms
  of a backend whose `ListRooms` failed with a quota/auth/unreachable error for that pass.
- **Config.** Two backends with the same API key and secret are a config error (webhooks could not tell them apart).

## 2. Wire contract proposal

Not applied to `types.ts` / `api.md` (owned elsewhere). Style follows those files: Discord shapes where they fit, snake_case,
snowflakes as strings, absent = not set.

### 2.1 Types

```ts
export enum ChannelType {
  // existing 0..4
  GuildStageVoice = 13,
}
export enum VideoQualityMode { Auto = 1, Full = 2 } // Discord values

// Channel additions (guild voice + stage only; absent elsewhere)
export interface Channel {
  bitrate?: number; // bps, 8000..guild ceiling; default 64000
  user_limit?: number; // 0 = unlimited, max 99 (stage: max 10000, audience included)
  video_quality_mode?: VideoQualityMode; // default Auto
}

export interface VoiceState {
  guild_id: Snowflake | null; // null for DM / group DM calls
  channel_id: Snowflake | null; // null = left voice
  user_id: Snowflake;
  member?: GuildMember; // guild only, so clients can render someone not yet in the member store
  session_id: string; // voice session (not the gateway session id)
  deaf: boolean; // server deafened
  mute: boolean; // server muted
  self_deaf: boolean;
  self_mute: boolean;
  self_video: boolean; // camera published (truth from LiveKit)
  self_stream: boolean; // screen share published (truth from LiveKit)
  suppress: boolean; // stage audience, or no SPEAK in a voice channel
  request_to_speak_timestamp: ISO8601 | null; // stage raised hand
  connected_at: ISO8601; // for call duration / "in voice for" display
}

// Guild-level media settings: part of the owner-editable limits block (api.md: "no boost levels").
export type ScreenshareQuality = "720p30" | "1080p60";
export interface GuildMediaSettings {
  screenshare_max: ScreenshareQuality; // default "720p30"; "1080p60" only if the instance allows it
  voice_bitrate_max: number; // bps, default 128000, never above the instance ceiling
  max_video_channel_users: number; // cameras per voice channel, default 10 (Discord: 25)
  soundboard_enabled: boolean; // default true
}
export interface Guild {
  media?: GuildMediaSettings; // absent → instance defaults
}
export interface GuildMember { mute?: boolean; deaf?: boolean } // server mute/deafen, persist across rejoin

export interface Call {
  channel_id: Snowflake; // DM / group DM
  message_id: Snowflake; // the type 3 Call system message
  ringing: Snowflake[]; // users currently being rung
  voice_states: VoiceState[];
}
export enum MessageType { Call = 3 /* + existing */ }
export interface Message {
  call?: { participants: Snowflake[]; ended_timestamp: ISO8601 | null }; // type 3 only (Discord shape)
}

export enum StagePrivacyLevel { GuildOnly = 2 }
export interface StageInstance { id: Snowflake; guild_id: Snowflake; channel_id: Snowflake; topic: string /* 1-120 */; privacy_level: StagePrivacyLevel }

export interface SoundboardSound {
  sound_id: Snowflake;
  guild_id: Snowflake | null; // null = Vokko default set
  name: string; // 2-32 chars
  emoji_id: Snowflake | null;
  emoji_name: string | null;
  volume: number; // 0..1
  available: boolean;
  url: string; // opaque absolute URL like Attachment.url
}

export interface InstanceMediaConfig { // in READY so the client can pre-check and hide what the instance disallows
  voice_enabled: boolean;
  voice_bitrate_ceiling: number; // default 128000, configurable up to 384000
  screenshare_qualities: ScreenshareQuality[]; // default ["720p30", "1080p60"]
  video_enabled: boolean;
}
```

### 2.2 REST additions

| Method | Path | Notes |
| --- | --- | --- |
| POST | /guilds/{id}/channels | accepts `type: 13`, `bitrate?`, `user_limit?`, `video_quality_mode?` |
| PATCH | /channels/{id} | same three keys (MANAGE_CHANNELS; `bitrate` clamped to `guild.media.voice_bitrate_max`, 400 50035 above) |
| PATCH | /guilds/{id} | `media?: Partial<GuildMediaSettings>` (MANAGE_GUILD) |
| PATCH | /guilds/{id}/members/{uid} | `EditMemberRequest` gains `mute?` (MUTE_MEMBERS), `deaf?` (DEAFEN_MEMBERS), `channel_id?: Snowflake \| null` (MOVE_MEMBERS on source and target, target must allow the member to CONNECT unless the mover is admin; null = disconnect; target not in voice → 400 40032). Discord sends one key per call; we accept any combination. Emits GUILD_MEMBER_UPDATE (mute/deaf) and VOICE_STATE_UPDATE |
| POST | /channels/{id}/call/ring | `{recipients?: Snowflake[]}` (default: every recipient not in the call) → 204; starts the call if none. Blocked → 403 50007 |
| POST | /channels/{id}/call/stop-ringing | `{recipients: Snowflake[]}` → 204 (decline = yourself; caller can cancel others) |
| POST | /stage-instances | `{channel_id, topic, privacy_level?}` → `StageInstance` (stage moderator: MANAGE_CHANNELS + MUTE_MEMBERS + MOVE_MEMBERS) |
| PATCH / DELETE | /stage-instances/{channel_id} | topic edit / end stage (moves every speaker back to audience) |
| PATCH | /guilds/{id}/voice-states/@me | `{channel_id, suppress?, request_to_speak_timestamp?}`; raise hand needs REQUEST_TO_SPEAK; `suppress: false` on yourself needs stage moderator |
| PATCH | /guilds/{id}/voice-states/{uid} | `{channel_id, suppress}` (stage moderator): invite to speak / move to audience |
| GET | /soundboard-default-sounds | `SoundboardSound[]` (Vokko's own set, never Discord audio) |
| GET / POST | /guilds/{id}/soundboard-sounds | list / create `{name, sound_attachment_id, volume?, emoji_id?, emoji_name?}` (CREATE_GUILD_EXPRESSIONS; ≤512 KiB, ≤5.2 s, mp3/ogg; 48 per guild) |
| PATCH / DELETE | /guilds/{id}/soundboard-sounds/{sid} | MANAGE_GUILD_EXPRESSIONS or own sound |
| POST | /channels/{id}/send-soundboard-sound | `{sound_id, source_guild_id?}` → 204; caller must be connected and unmuted in that channel with SPEAK + USE_SOUNDBOARD, and USE_EXTERNAL_SOUNDS for another guild's sound; 1 per 2 s per user (429) |
| POST | /channels/{id}/voice-channel-effects | `{emoji_id?, emoji_name}` → 204 (voice reactions, ADD_REACTIONS); 1 per s per user |
| POST | /internal/livekit/webhook | LiveKit only (§1.5), not part of the client contract |

### 2.3 Gateway additions

```ts
export enum GatewayOp { VoiceStateUpdate = 4 /* + existing */ }
export interface VoiceStateUpdateCommand { // op 4, client → server
  guild_id: Snowflake | null;
  channel_id: Snowflake | null;
  self_mute: boolean;
  self_deaf: boolean;
  self_video: boolean; // hint only; truth comes from LiveKit
}
export type VoiceConnectFailure =
  | "missing_permissions" | "channel_full" | "video_full" | "blocked" | "timed_out" | "media_unavailable";

export interface ReadyEvent {
  guilds: (Guild & { /* existing */ voice_states: VoiceState[]; stage_instances: StageInstance[] })[];
  media: InstanceMediaConfig;
}
export interface GatewayEvents {
  VOICE_STATE_UPDATE: VoiceState;
  VOICE_SERVER_UPDATE: { guild_id: Snowflake | null; channel_id: Snowflake; endpoint: string; token: string };
  VOICE_CONNECT_FAILED: { guild_id: Snowflake | null; channel_id: Snowflake; reason: VoiceConnectFailure }; // Vokko-only
  CALL_CREATE: Call;
  CALL_UPDATE: Omit<Call, "voice_states">;
  CALL_DELETE: { channel_id: Snowflake };
  STAGE_INSTANCE_CREATE: StageInstance;
  STAGE_INSTANCE_UPDATE: StageInstance;
  STAGE_INSTANCE_DELETE: StageInstance;
  GUILD_SOUNDBOARD_SOUND_CREATE: SoundboardSound;
  GUILD_SOUNDBOARD_SOUND_UPDATE: SoundboardSound;
  GUILD_SOUNDBOARD_SOUND_DELETE: { sound_id: Snowflake; guild_id: Snowflake };
  VOICE_CHANNEL_EFFECT_SEND: {
    channel_id: Snowflake; guild_id: Snowflake | null; user_id: Snowflake;
    emoji?: ReactionEmoji | null; sound_id?: Snowflake; sound_volume?: number;
  };
}
// GUILD_CREATE gains voice_states + stage_instances like READY guilds.
```

Op 4 limits: 30 per minute per session with a burst of 10 (mute toggles are op 4), else close 4008 like op 3. The
`VOICE_CONNECT_FAILED` event is the only non-Discord addition: Discord silently ignores a bad op 4 and relies on client
pre-checks, which leaves a hung "connecting" state when the client and server disagree. Clients still pre-check with
`permissions.ts` and the known `voice_states` so the common case never round-trips.

`DM_PERMISSIONS` in `access.rs` grows CONNECT | SPEAK | STREAM | USE_VAD for call participants.

## 3. Client

### 3.1 Stack
`livekit-client` (Apache-2.0) inside the React webview, behind a `VoiceEngine` module that owns one `Room` and exposes a
zustand store (it replaces the mock-only `apps/desktop/src/api/voice.ts`). Room options: `adaptiveStream: true`,
`dynacast: true`, `webAudioMix: true` (needed for per-user volume above 100 %), `autoSubscribe: false` with an explicit policy:
subscribe every microphone track on publish, subscribe camera tracks only when a tile is visible, subscribe screen shares only
when the user clicks **Watch Stream** (Discord's model; the biggest egress saver on a home uplink).

| Runtime | Engine | Status for WebRTC |
| --- | --- | --- |
| Browser (Chromium, Firefox, Safari) | native | supported; page must be a secure context (HTTPS or localhost) |
| Windows (Tauri, WebView2 = Chromium) | native | supported incl. getDisplayMedia; permission prompts via WebView2, Tauri can pre-grant |
| macOS (Tauri, WKWebView) | WebKit | getUserMedia supported with `NSMicrophoneUsageDescription`/`NSCameraUsageDescription`; **verify** getDisplayMedia in WKWebView on the target macOS, and `setSinkId` (output device) is missing in WebKit |
| Linux (Tauri, WebKitGTK) | WebKit | **risk**: WebRTC in WebKitGTK depends on distro build flags + GStreamer plugins; spike V0 decides (fallback: browser client, later a native path via LiveKit's Rust SDK) |

### 3.2 Devices and processing
- Device lists from `Room.getLocalDevices()`; `devicechange` re-enumerates; the chosen device ids persist locally, and a
  vanished device falls back to "default" with a toast. Output device via `switchActiveDevice('audiooutput')` where `setSinkId`
  exists; hidden elsewhere.
- Capture constraints: `echoCancellation`, `autoGainControl` on by default (toggles in Voice & Video settings, SET-004).
- Noise suppression setting, three options: **Off**; **Standard** = the browser's built-in `noiseSuppression` constraint
  (default); **Enhanced** = RNNoise (BSD) compiled to WASM in an AudioWorklet, publishing the processed track via
  `MediaStreamAudioDestinationNode`. Krisp is not available to self-hosted LiveKit, and Discord's Krisp is proprietary.
- Opus: mono, DTX on, RED/FEC on (livekit-client defaults), `maxBitrate` = channel `bitrate`.
- Mic test / input meter in settings uses a local `AnalyserNode`; no LiveKit connection needed.

### 3.3 Push-to-talk vs voice activity
- **Voice activity** (default when USE_VAD): an AudioWorklet computes RMS dBFS every 10 ms; above the threshold opens a gain
  gate, closing after a 400 ms hangover. "Automatically determine input sensitivity" = adaptive threshold (noise floor + 15 dB);
  manual slider -100..0 dB like Discord. The gate is a GainNode on the processed track, not `track.mute()`, so toggling never
  sends signalling; DTX makes the silent gate cost ~1 kbps.
- **Push-to-talk** (forced when the server sets `vokko.vad = "0"`): gate opens while the key is held, release delay 20 ms
  default (0-2000 ms slider). In-window PTT uses `keydown`/`keyup` on `window` (ignored while typing in inputs unless the key
  has a modifier). Global PTT needs Tauri (§3.7).
- Self mute = gate forced closed + `track.mute()` (so others see the muted icon via VOICE_STATE_UPDATE, and the mic light
  stays honest); self deafen = self mute + all remote audio elements muted.

### 3.4 Speaking indicator
- Self: from the local VAD gate state (instant, no network).
- Others: LiveKit `ActiveSpeakersChanged` / `participant.isSpeaking`, computed by the SFU. Set `audio.update_interval: 200` in
  the LiveKit config (§5) so the ring follows speech within ~200 ms. Ring colour token `--status-speaking`; priority speakers
  get the louder variant. A server- or self-muted user never shows a ring.

### 3.5 Per-user volume, local mute, priority speaker
- Per-user volume 0-200 % via `RemoteAudioTrack.setVolume` (Web Audio gain), stored locally by user id (later in synced
  settings). Local mute = volume 0 **and** unsubscribe (saves egress). Separate "stream volume" for screen-share audio.
- Priority speaker: while any participant with `vokko.priority = "1"` is speaking, every other participant is attenuated by
  the "priority speaker ducking" setting (default -10 dB). Client-side, as in Discord.

### 3.6 Server mute/deafen, disconnect, reconnect
- Server mute/deafen arrive as VOICE_STATE_UPDATE (`mute`/`deaf`); the UI shows the red server icon and disables the toggle.
  The SFU already enforces it (§1.4), the UI only reflects it.
- LiveKit handles ICE restarts and full rejoins (`Reconnecting`/`Reconnected`/`SignalReconnecting`). The panel shows
  "Connecting" / "RTC connecting" / "Voice connected" with the ping from `room.engine` stats, like Discord's RTC panel.
- On `Disconnected` with reason other than client-initiated: retry by re-sending op 4 (fresh token) with backoff 1 s → 5 s
  (Discord's RTC backoff max is 5 s, client facts §Backoff), give up after 2 minutes. `DUPLICATE_IDENTITY` and
  `PARTICIPANT_REMOVED` are final (moved to another device / kicked) and never retried.
- Gateway reconnect keeps media running; after a re-identify the client re-sends op 4 for its current channel (§1.6), and
  the room is kept. A real reconnect into the same channel (a new token, or a retry after a lost room) publishes the camera
  and screen share again: captures that are still live move to the new room; a camera LiveKit stopped is reopened on the same
  device with the same background (or stays off if that fails); an ended screen capture stays off.

### 3.7 Tauri-native help (desktop only, `src-tauri`)
- **Global PTT and mute/deafen hotkeys.** `tauri-plugin-global-shortcut` reports press and release but grabs the key
  exclusively, so a PTT key would be swallowed from games. Proposal: a non-consuming listener (e.g. the `rdev` crate) on
  Windows and X11; macOS needs the Input Monitoring permission (prompt with an explanation); Wayland has no global key access,
  use the XDG GlobalShortcuts portal where available, otherwise in-window PTT only. Only press/release booleans cross the
  bridge, never audio.
- **Tray**: mute, deafen, disconnect, and "close to tray while in voice" (DESK row in parity-inventory).
- **OS permissions**: macOS Info.plist usage strings + entitlements for mic, camera, screen recording; Windows WebView2
  permission handler to remember grants per origin.
- **Background**: keep the webview from throttling timers while minimised during a call (WebView2/WKWebView settings, verify).
- Out of scope here: the in-game overlay, system-audio capture on macOS (needs ScreenCaptureKit natively), custom screen picker
  with thumbnails (native enumeration can't hand frames to the webview without breaking the "no media over the bridge" rule;
  use the engine's own picker).

## 4. Features in Discord-parity order

Free-Nitro rule (parity.md): every perk is available to everyone, but numbers are moderate defaults with instance ceilings
(nitro-perks §Moderate defaults). Each subsection lists the decision.

### 4.1 Voice channels (GLD-007)
Join on click, connected users listed under the channel (avatar, name, mute/deaf/video/live icons, speaking ring when you are
in the same call), user panel at the bottom with mute/deafen/disconnect, `user_limit` with "full" lock icon, drag to move
(MOVE_MEMBERS), context menu: server mute, server deafen, disconnect, move to, per-user volume, local mute.
**Decisions**: new channel bitrate 64 kbps (Discord's default); per-guild max **128 kbps** default, instance ceiling 128 kbps
(raise to 384 kbps in config). Discord gates 128/256/384 behind boost tiers; we expose the slider up to the guild max.
Text-in-voice chat: later (separate design with the chat owner). AFK channel/timeout: later, open question.

### 4.2 DM and group DM calls (DM-001, DM-008)
Call / video buttons in the DM header ring the other participants: `POST /call/ring`, CALL_CREATE to recipients with
`ringing`, an incoming-call card with accept (op 4 into the DM channel) / decline (`stop-ringing`). Ringing stops after
**60 s** (proposal) or when everyone answered. The call ends when the last participant leaves: CALL_DELETE, and the type 3
system message gets `call.ended_timestamp` (MESSAGE_UPDATE); missed calls render as "missed call". Group DM max 10
participants (Discord's cap). A block (403 50007) forbids ringing and joining 1:1 calls. DM calls use the same room scheme.

### 4.3 Video (camera)
Camera publish with simulcast: layers 180p / 360p / 720p @ 30 fps, VP8 (broadest webview support), max bitrates 150 / 500 /
1200 kbps. Viewers get the layer that fits the tile (adaptiveStream). `video_quality_mode` Full = viewers request the top
layer regardless of tile size. Cap: `max_video_channel_users` default **10** cameras per channel (Discord 25; egress grows with
cameras × viewers), checked when the client sends `self_video: true` and enforced on `track_published` (over cap →
`MutePublishedTrack` + `VOICE_CONNECT_FAILED video_full`). Background blur: later (client-side segmentation, N14); custom
backgrounds ≤10 MiB, 10 per user (nitro-perks table) when it lands.

### 4.4 Screenshare ("Go Live")
Source picked through `getDisplayMedia` (engine picker). Presets, all free (N13):

| Preset | Encoding | Max bitrate | Simulcast | Availability |
| --- | --- | --- | --- | --- |
| 720p30 (default) | 1280×720 @ 30, VP8 (VP9 where both sides support it) | 2.0 Mbps | + 360p @ 15, 400 kbps | always |
| 1080p60 | 1920×1080 @ 60 | 6.0 Mbps | + 720p @ 30, 2.0 Mbps | only if `guild.media.screenshare_max = "1080p60"` and the instance allows it |
| Documents | source res @ 5 fps, `contentHint: "text"`, maintain-resolution | 1.5 Mbps | none | always (Discord's "documents" preset) |

Screen audio (`screen_share_audio`) where the engine supports it (Chromium on Windows; tabs in browsers). Watch-on-click
(§3.1) means a stream costs nothing until someone opens it. LiveKit cannot cap a publisher's resolution from the token, so
enforcement is: the client offers only allowed presets, and the `track_published` webhook checks reported dimensions/layers;
above the guild cap the server mutes the track and the sender sees "Stream quality not allowed in this server". The
instance-wide `limit.bytes_per_sec` (§5) is the hard backstop. Viewer cap per stream: none by default (open question).

### 4.5 Stage channels (GLD-015)
Channel type 13 with a stage instance (topic). Everyone joins as audience (`suppress: true`, token without `microphone`),
raises a hand (`request_to_speak_timestamp`, needs REQUEST_TO_SPEAK), moderators (MANAGE_CHANNELS + MUTE_MEMBERS +
MOVE_MEMBERS, client facts) invite to speak (`suppress: false` → `UpdateParticipant` adds `microphone`, plus camera/screen
if STREAM). Audience members are hidden from the speaker grid and not subscribed to by anyone, so a large audience costs only
egress of the few speakers. Stage video capped at 10 publishers (Discord: 50 without boosts). Starting a stage can ping
@everyone with MENTION_EVERYONE (later, with notifications).

### 4.6 Soundboard and voice reactions
Discord plays soundboard sounds **on each listener's client** (VOICE_CHANNEL_EFFECT_SEND carries a `sound_id`), so no SFU
mixing is needed (correcting the "voice mixing in the SFU" note in nitro-perks N6). Free: sounds from every server you are in
(SOUNDBOARD_EVERYWHERE / USE_EXTERNAL_SOUNDS still apply), 48 slots per guild, ≤512 KiB, ≤5.2 s; Vokko ships its own small
default set (CC0/own recordings, no Discord audio). Clients cache sound files by URL. Entrance sounds (N17): user picks one of
their accessible sounds, the server sends it as an effect on join; later. Voice reactions (N24, emoji bursts): the
`voice-channel-effects` endpoint, all animations free.

### 4.7 Activities
Third-party embedded apps (`EMBEDDED_ACTIVITY_*` is out of scope for v1 per client facts); not planned here (open question 7).

## 5. Self-hosting

### 5.1 Topology
`vokko-server` + Postgres + `livekit-server` (single node, no Redis needed for one node) behind Caddy (TLS for both the API
and LiveKit's signal websocket). Clients need: `https://vokko.example.org` (API + gateway), `wss://lk.example.org`
(LiveKit signal, proxied to 7880), and direct UDP/TCP to the media ports.

| Port | Proto | Purpose | Forward on the router |
| --- | --- | --- | --- |
| 443 | TCP | Caddy: API, gateway, LiveKit signal | yes |
| 7881 | TCP | ICE over TCP (fallback when UDP is blocked) | yes |
| 7882 | UDP | all WebRTC media muxed on one port (`rtc.udp_port`) | yes |
| 3478 | UDP | embedded TURN/UDP | yes |
| 5349 | TCP | embedded TURN/TLS (strict corporate networks) | yes, optional |
| 7880 | TCP | LiveKit HTTP/ws + RoomService, behind Caddy only | no |

Single-port UDP mode is chosen over the default 50000-60000 range because port-range forwarding is painful on home routers
and slow in Docker Desktop. TURN needs its own hostname with a certificate (`turn.example.org`, Caddy-issued cert files
shared via a volume). The browser client must be served over HTTPS (getUserMedia needs a secure context), so plain-LAN HTTP
setups work only on localhost.

Home-network caveats: CGNAT (no public IPv4) breaks inbound media; the fix is a small VPS running LiveKit (or only its TURN)
instead of the home machine. LAN clients reaching the public IP need NAT hairpinning; LiveKit also offers host candidates, but
**verify** with a LAN client.

### 5.2 macOS host note
Docker Desktop on macOS runs a Linux VM with userspace UDP forwarding, which adds latency and CPU for media. Recommended on
macOS: run `livekit-server` natively (Homebrew `livekit` formula or the release binary under launchd) and keep vokko-server +
Postgres in Docker; on a Linux host use the compose snippet below with `network_mode: host`.

### 5.3 livekit.yaml

```yaml
port: 7880
bind_addresses: ["0.0.0.0"]
rtc:
  tcp_port: 7881
  udp_port: 7882          # single muxed UDP port
  use_external_ip: true   # discover the public IP via STUN; or set node_ip
keys:
  vokko: ${LIVEKIT_API_SECRET}   # key name = VOKKO_LIVEKIT_KEY
room:
  auto_create: true
  empty_timeout: 60
  departure_timeout: 20
  max_participants: 100
audio:
  update_interval: 200    # speaker updates every 200 ms (speaking rings)
turn:
  enabled: true
  domain: turn.example.org
  udp_port: 3478
  tls_port: 5349
  cert_file: /certs/turn.crt
  key_file: /certs/turn.key
webhook:
  api_key: vokko
  urls: ["http://vokko-server:8710/internal/livekit/webhook"]
limit:
  bytes_per_sec: 12500000  # ~100 Mbit/s total egress backstop; set below your uplink
```
(Key names follow LiveKit's config sample; **verify** against the pinned release, especially `limit.*`.)

### 5.4 docker-compose snippet (addition to the selfhost worker's `deploy/docker-compose.yml`)

```yaml
services:
  livekit:
    image: livekit/livekit-server:v1.9   # pin the exact tested tag in V0
    command: --config /etc/livekit.yaml
    network_mode: host                   # Linux hosts; on macOS run natively (5.2)
    restart: unless-stopped
    environment:
      LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
      - caddy_data:/certs:ro             # TURN cert, see 5.1
  vokko-server:
    environment:
      VOKKO_LIVEKIT_URL: wss://lk.example.org
      VOKKO_LIVEKIT_API_URL: http://host.docker.internal:7880
      VOKKO_LIVEKIT_KEY: vokko
      VOKKO_LIVEKIT_SECRET: ${LIVEKIT_API_SECRET}
    extra_hosts: ["host.docker.internal:host-gateway"]
```
Caddy: `lk.example.org { reverse_proxy 127.0.0.1:7880 }`. The webhook URL must match how LiveKit reaches vokko-server
(with host networking: `http://127.0.0.1:8710/...` if vokko-server publishes 8710 on loopback).

### 5.5 Resource estimates (proposal, to be measured with `lk load-test` in V0/V1)
The SFU forwards, it does not transcode, so CPU stays low; the binding constraint at home is **upload bandwidth**
(egress = each published stream × each subscriber). Opus at 64 kbps ≈ 70 kbps on the wire; DTX makes silent senders ~1 kbps.

| Scenario | Egress (typical) | Egress (worst) | LiveKit CPU / RAM (estimate) |
| --- | --- | --- | --- |
| 1 voice room, 10 users, ~2 talking | 2 × 9 × 70 kbps ≈ 1.3 Mbps | all talking: 10 × 9 × 70 ≈ 6.3 Mbps | < 10 % of one core / ~100 MB |
| 3 rooms, 25 users total | ≈ 3 Mbps | ≈ 15 Mbps | < 15 % of one core / ~150 MB |
| 8 users, 5 cameras (viewers mostly at 360p, 500 kbps) | 5 × 7 × 0.5 ≈ 17.5 Mbps | all at 720p: 5 × 7 × 1.2 ≈ 42 Mbps | ~25 % of one core / ~200 MB |
| 1 screenshare 720p30 to 10 viewers | 10 × 2 Mbps = 20 Mbps | | small |
| 1 screenshare 1080p60 to 10 viewers | 10 × 6 Mbps = 60 Mbps | | small |
| Stage: 3 speakers, 200 audience, audio only | 3 × 200 × 70 kbps ≈ 42 Mbps | | ~1 core / ~300 MB |

Ingress is small (each publisher sends its simulcast layers once: ~1.9 Mbps per 720p camera). A 20-100 Mbps home uplink
runs voice for dozens of users plus a couple of 720p streams; 1080p60 to many viewers or big stages is what needs the opt-in and
`limit.bytes_per_sec`. Rule of thumb: **~0.1 Mbps per speaker-listener pair, 2 Mbps per 720p viewer, 6 Mbps per 1080p60 viewer**.

## 6. Milestones

Each milestone ends with the listed tests green in CI (server: `cargo test -p vokko-server`, client: `npm test`, e2e:
Playwright). LiveKit in tests: unit/integration tests use a fake RoomService + signed webhook fixtures (no SFU needed);
e2e tests start `livekit-server --dev` and run two Chromium contexts with `--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream` (fake mic = a beep WAV via `--use-file-for-fake-audio-capture`).

**V0 spike (no product merge).** LiveKit on the dev host, token minted by a throwaway script, join from: Chrome, Firefox,
Safari, Tauri on Windows, macOS, Linux. Record per runtime: mic, camera, getDisplayMedia, screen audio, setSinkId, global
hotkey option. Run `lk load-test` for the §5.5 rows. Output: a filled compatibility table appended to this doc, pinned
LiveKit version. Acceptance: the table exists; the decision on Linux webview vs browser fallback is made.

**V1 voice channels.** Op 4, VOICE_SERVER_UPDATE, token grants, webhooks + reconciliation, voice_states in READY/GUILD_CREATE,
VOICE_CONNECT_FAILED, channel `bitrate`/`user_limit`, self mute/deaf, device selection, VAD, speaking rings, per-user volume,
reconnect. Acceptance:
- Token claims decoded in tests match a permission matrix: {CONNECT, SPEAK, STREAM} × {allow, deny via role, deny via member
  overwrite} → expected `roomJoin`/`canPublishSources`; no token at all without VIEW_CHANNEL or CONNECT, or when timed out.
- Join broadcasts VOICE_STATE_UPDATE only to sessions that can see the channel (a member denied VIEW_CHANNEL receives nothing).
- `user_limit` reached → `channel_full`; MOVE_MEMBERS holder still joins.
- Webhook with a bad signature → 401 and no state change; duplicated / out-of-order `participant_left` does not drop a newer
  session; no `participant_joined` within the connect timeout (default 30 s) → state removed and `channel_id: null` broadcast.
- Second gateway session joining voice moves the state (old session sees the new `session_id`).
- Server restart with a fake RoomService listing participants → voice states restored, no leave events emitted.
- Client: voice store reducer tests from event sequences; VAD gate tests with synthetic level sequences (opens above
  threshold, closes after hangover, never opens in PTT mode).
- e2e: user A and B join; B's client reports A's audio track subscribed and A's speaking ring turns on while the beep plays.

**V2 moderation and desktop.** Server mute/deafen/move/disconnect, PRIORITY_SPEAKER ducking, USE_VAD → PTT forced,
permission recompute on role/overwrite/timeout changes, global PTT + tray in Tauri. Acceptance: server mute → fake
RoomService received `UpdateParticipant` without `microphone` and `MutePublishedTrack`; mute persists across leave/rejoin;
move without CONNECT on the target → 403 50013; removing CONNECT from a role disconnects connected holders; timeout
disconnects; e2e: A server-mutes B → B's mic track is muted at A's side within 2 s and B's toggle is disabled.

**V3 DM and group calls.** Ring/stop-ringing, CALL_*, type 3 message with duration, 60 s ring timeout, block rules.
Acceptance: ring creates CALL_CREATE for recipients only; blocked → 403 50007; last leave → CALL_DELETE and
`ended_timestamp` set; missed call when nobody answered; group DM 11th participant refused.

**V4 video.** Camera publish/subscribe, video grid, `max_video_channel_users`, `video_quality_mode`. Acceptance: 11th camera
→ `video_full` and the track is muted; `self_video` follows `track_published`/`unpublished`; e2e: fake camera tile renders
for the other user and is unsubscribed when the tile scrolls out.

**V5 screenshare.** Go Live presets, watch-on-click, guild `media.screenshare_max`, webhook enforcement. Acceptance: 1080p60
stream in a 720p30 guild gets muted by the server; a stream nobody watches has zero subscribers (LiveKit room stats);
e2e: B clicks Watch Stream and receives frames, stops watching → unsubscribed.

**V6 stage.** Type 13, stage instances, raise hand, invite to speak, audience hidden. Acceptance: audience token has no
`microphone`; promote → `UpdateParticipant` with `microphone`; non-moderator `suppress: false` → 403 50013; ending the stage
moves speakers back to audience.

**V7 soundboard and effects.** Default + guild sounds, cross-server sounds, send-soundboard-sound, voice reactions, entrance
sound. Acceptance: limits (48 slots, 512 KiB, 5.2 s) enforced with 400s; USE_EXTERNAL_SOUNDS respected; rate limit 429;
VOICE_CHANNEL_EFFECT_SEND only to the channel's connected users.

**Later.** Background blur/custom backgrounds, text-in-voice, AFK channel, E2EE, activities, recording (out of scope now).

## 7. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| WebKitGTK WebRTC unavailable or broken on common distros | no voice in the Linux desktop app | V0 spike; fallback to the browser client; later a native media path with LiveKit's Rust SDK in `src-tauri` |
| WKWebView lacks getDisplayMedia / setSinkId on some macOS versions | no screenshare / output choice on macOS app | V0 spike; hide features by capability detection; native ScreenCaptureKit later |
| Home uplink saturation (1080p60, big stages) | everyone's call degrades | modest defaults, watch-on-click, `limit.bytes_per_sec`, guild opt-in for 1080p60 |
| CGNAT / no port forwarding | no media from outside the LAN | documented VPS relay (LiveKit or TURN on a VPS) |
| Client-enforced pieces (VAD-only, priority speaker, screenshare resolution) | modified clients can bypass | documented trust gap; server-side checks via webhooks where possible |
| Global PTT on Wayland / macOS permissions | PTT only in-window for some users | portal + permission prompts; clear settings copy |
| Webhook loss or vokko-server restart | stale or missing voice states | idempotent handlers, 60 s reconciliation, rebuild on start |
| LiveKit config/API churn between releases | breakage on upgrade | pin the version tested in V0; integration tests against the pinned image |

## 8. Open questions for the user

1. Does the host have a public IPv4 (not CGNAT), and can you forward 443/TCP, 7881/TCP, 7882/UDP, 3478/UDP? What is
   the upload bandwidth? (This sets `limit.bytes_per_sec` and whether 1080p60 is allowed instance-wide.)
2. LiveKit natively on macOS (recommended) or in Docker Desktop?
3. Voice bitrate: the nitro-perks proposal says 128 kbps default / 384 kbps ceiling; this doc proposes 64 kbps per new channel
   (Discord default) with a 128 kbps guild max and the 384 kbps ceiling only by config. OK?
4. Cameras per channel: 10 (proposed) or Discord's 25? Viewer cap per stream: none, or a number?
5. How important is the Linux desktop app for voice vs. using the browser on Linux?
6. End-to-end encryption for DM calls (Discord has rolled out E2EE for calls; LiveKit supports E2EE via insertable streams,
   webview support varies): needed for V3, later, or never?
7. Activities / "watch together": out of scope, or a later milestone of our own design?
8. Ring timeout 60 s and gateway-loss grace 60 s: acceptable?

### 8.1 Decisions (user, 2026-10-11)

The user accepted the recommendations: LiveKit runs natively on macOS (not Docker); 64 kbps default per new channel, 128 kbps guild
max, 384 kbps ceiling only by instance config; 10 cameras per channel, no viewer cap per stream; Linux desktop voice is low
priority (browser on Linux is fine at first); E2EE for DM calls later (not V3); Activities out of scope; ring timeout 60 s and
gateway-loss grace 60 s. Question 1 (public IPv4, port forwarding, upload bandwidth) stays open: it only affects calls from
outside the LAN and instance-wide stream limits, and is settled before deploying voice beyond the home network.
