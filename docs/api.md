# Vokko server API (v1 contract)

Types: `apps/desktop/src/api/types.ts` is the source of truth for JSON shapes until generated bindings replace it. The Rust side (`crates/protocol` `api` module) must serialize identically. Shapes follow Discord's public API where it fits, so behaviour can be compared one to one.

General rules:
- Base URL `http://<host>:<port>/api/v1`. Auth header `Authorization: <token>` (opaque session token, no "Bearer" prefix, Discord-style). Everything except `/auth/*` requires it.
- IDs are 64-bit snowflakes (Discord epoch 2015-01-01, worker/process bits, increment) serialized as strings.
- Errors: HTTP status + `ApiError` body. 400 → 50035, 401 → 0 "401: Unauthorized", 403 → 50001/50013, 404 → 10003 (channel), 10008 (message), 10004 (guild), 10013 (user).
- Server is authoritative for every permission check. Message content max 2000 chars, trimmed, not empty unless attachments exist.
- CORS allows `http://localhost:*`, `http://127.0.0.1:*` and `tauri://localhost` / `http://tauri.localhost` in dev. `VOKKO_CORS_ORIGINS` (comma-separated exact origins) replaces the localhost part; the Tauri origins always stay allowed.
- `GET /healthz` (outside `/api/v1`, no auth, no rate limit): `200 {status: "ok", version, db: "ok"}`, or `503 {status: "unavailable", version, db: "error"}` when the database does not answer within 2 s.
- With `VOKKO_REGISTRATION=closed`, `POST /auth/register` answers `403` with code `40002` ("Registration is closed on this server"); login and existing sessions are unaffected.
- Profile images (avatar, banner, server icon, per-server avatar/banner) must be PNG, JPEG, GIF or WebP; the server stores them as uploaded (no resize): avatar/icon at most 8 MiB (animated GIF 2 MiB), banner at most 10 MiB (animated GIF 4 MiB), otherwise 400 / 50035 on the `*_attachment_id` field. `pronouns` ≤ 40 characters, `bio` ≤ 190, server tag 1-4 non-space characters, decoration / effect / badge / preset ids are 1-64 characters of `a-z 0-9 _ -`, colours are RGB ints (0..16777215).
- A user's `primary_guild` is only reported while they are still in that guild and the guild still has a tag; leaving, being kicked or banned, or the tag being removed clears it and sends USER_UPDATE (editing a tag sends USER_UPDATE for everyone wearing it).

## REST

| Method | Path | Notes |
| --- | --- | --- |
| POST | /auth/register | `RegisterRequest` → `AuthResponse` |
| POST | /auth/login | `AuthRequest` → `AuthResponse` |
| POST | /auth/logout | revokes token, 204 |
| GET | /users/@me | `User` |
| PATCH | /users/@me | `EditUserRequest` → `User` (profile perks included: banner, pronouns, theme colours, decoration, effect, server tag) |
| GET | /users/{id} | `User` |
| GET | /users/@me/guilds | `Guild[]` |
| GET | /users/@me/channels | DM + group DM `Channel[]` |
| POST | /users/@me/channels | `{recipient_id}` → existing or new DM `Channel`; `{recipient_ids: []}` → group DM |
| GET | /users/@me/relationships | `Relationship[]` |
| PUT | /users/@me/relationships/{user_id} | body `{}` or `{type: 1}` = send/accept friend request; `{type: 2}` = block (removes any friendship/request, emits RELATIONSHIP_ADD type 2 to the blocker only; the blocked user gets RELATIONSHIP_REMOVE if they had a relationship). 204 |
| GET | /users/{id}/profile | `UserProfile`: user, mutual guilds, mutual friend count, guild member info when `?guild_id=` |
| POST | /users/@me/relationships | `{username}` → send friend request by username (204) |
| DELETE | /users/@me/relationships/{user_id} | remove friend / cancel / decline / unblock (204) |
| POST | /guilds | `{name, icon_attachment_id?}` → `Guild` (creates @everyone role, "Text Channels"/"Voice Channels" categories, #general, General voice) |
| GET | /guilds/{id} | `Guild` |
| PATCH | /guilds/{id} | `{name?, icon_attachment_id?, system_channel_id?, tag?: GuildTag \| null, theme?: GuildTheme \| null}` → `Guild` (MANAGE_GUILD) |
| DELETE | /guilds/{id} | owner only, 204 |
| GET | /guilds/{id}/channels | `Channel[]` |
| POST | /guilds/{id}/channels | `{name, type, parent_id?, topic?, permission_overwrites?}` → `Channel` (private channel = @everyone deny VIEW_CHANNEL overwrite) |
| PATCH | /channels/{id} | `{name?, topic?, position?, parent_id?}` → `Channel` |
| DELETE | /channels/{id} | 200 + `Channel` (guild) / closes DM |
| GET | /guilds/{id}/members?limit&after | `GuildMember[]` |
| DELETE | /users/@me/guilds/{id} | leave guild, 204 |
| DELETE | /guilds/{id}/members/{uid} | kick (KICK_MEMBERS + hierarchy), 204, emits GUILD_MEMBER_REMOVE to the guild and GUILD_DELETE to the kicked user |
| PATCH | /guilds/{id}/members/{uid} | `EditMemberRequest` → `GuildMember`: nick needs MANAGE_NICKNAMES, roles MANAGE_ROLES (only roles below your highest), timeout MODERATE_MEMBERS (not on admins/owner, max 28 days); only sent keys change; emits GUILD_MEMBER_UPDATE |
| PATCH | /guilds/{id}/members/@me | `EditOwnMemberRequest` → `GuildMember` (nick needs CHANGE_NICKNAME; per-server avatar/banner/bio/pronouns/theme colours need nothing) |
| GET | /guilds/{id}/bans | `Ban[]` (BAN_MEMBERS) |
| PUT | /guilds/{id}/bans/{uid} | `BanRequest`, 204; works on non-members; removes the member, emits GUILD_BAN_ADD + GUILD_MEMBER_REMOVE; banned users can't rejoin via invite (403 40007) |
| DELETE | /guilds/{id}/bans/{uid} | unban, 204, emits GUILD_BAN_REMOVE |
| POST | /guilds/{id}/roles | `RoleRequest` → `Role` (MANAGE_ROLES; name default "new role", placed just above @everyone; can't grant bits you lack, ADMINISTRATOR only by an admin), emits GUILD_ROLE_CREATE |
| PATCH | /guilds/{id}/roles | `RolePositionUpdate[]` → `Role[]` (only roles below your highest; @everyone fixed at 0), GUILD_ROLE_UPDATE per changed role |
| PATCH | /guilds/{id}/roles/{rid} | `RoleRequest` → `Role` (@everyone: permissions only), GUILD_ROLE_UPDATE |
| DELETE | /guilds/{id}/roles/{rid} | 204 (not @everyone), removes it from members, GUILD_ROLE_DELETE |
| PUT | /channels/{id}/permissions/{oid} | `OverwriteRequest`, 204 (MANAGE_ROLES on the channel; can't grant/deny bits you lack there), emits CHANNEL_UPDATE |
| DELETE | /channels/{id}/permissions/{oid} | 204, emits CHANNEL_UPDATE |
| POST | /channels/{id}/invites | `{max_age?, max_uses?}` → `{code, guild, channel, expires_at}` |
| GET | /invites/{code} | invite preview |
| POST | /invites/{code} | accept → `Guild` |
| GET | /channels/{id}/messages?before&after&around&limit | `Message[]` newest first, limit 1-100 (default 50) |
| GET | /guilds/{id}/messages/search | `MessageSearchResponse`; guild members only (403 50001 otherwise). Filters below; searches every channel of the guild where the caller has VIEW_CHANNEL + READ_MESSAGE_HISTORY |
| GET | /channels/{id}/messages/search | `MessageSearchResponse`; same filters minus `channel_id`; works for guild channels, DMs and group DMs. Caller without READ_MESSAGE_HISTORY gets an empty result |
| POST | /channels/{id}/messages | `CreateMessageRequest` → `Message` |
| PATCH | /channels/{id}/messages/{mid} | author only, `EditMessageRequest` → `Message`. `attachments` lists the ones to keep (others are removed and their files deleted); a result with no content and no attachments → 400 50006 |
| DELETE | /channels/{id}/messages/{mid} | author or MANAGE_MESSAGES, 204 |
| PUT | /channels/{id}/messages/{mid}/reactions/{emoji}/@me | emoji URL-encoded (unicode or `name:id`), 204 |
| DELETE | /channels/{id}/messages/{mid}/reactions/{emoji}/@me | 204 |
| GET | /channels/{id}/messages/{mid}/reactions/{emoji} | `User[]` who reacted |
| GET | /channels/{id}/messages/pins?limit&before | `PinnedMessagesPage` (newest pin first, limit 1-50, `before` = pinned_at ISO) |
| PUT/DELETE | /channels/{id}/messages/pins/{mid} | 204; max 250 pins per channel → 400 code 30003 |
| POST | /read-states/ack-bulk | `{read_states: [{channel_id, message_id}]}` → 204 ("mark server as read") |
| POST | /channels/{id}/typing | 204, emits TYPING_START (expires after 10 s client-side) |
| POST | /channels/{id}/messages/{mid}/ack | updates read state, 204 |
| POST | /channels/{id}/attachments | multipart `file` (max 25 MiB, configurable) → `Attachment` (pending until referenced by a message). On send, `CreateMessageRequest.attachments` may rename (`filename`, `SPOILER_` prefix = spoiler) and set `description` (alt text ≤1024) per id |
| GET | /attachments/{id}/{key}/{filename} | serves the file; `key` = 32 hex chars (128-bit random per attachment); wrong key or filename → 404. Avatars/icons use the same URLs. Clients treat `Attachment.url`, `User.avatar`, `Guild.icon` as opaque absolute URLs |

## Gateway

`GET /gateway` (at the server root, not under `/api/v1`; e.g. `ws://127.0.0.1:8710/gateway`) upgrades to WebSocket. Text frames carrying `GatewayPayload`.

1. Server sends `op 10 Hello {heartbeat_interval: 41250}`.
2. Client sends `op 2 Identify {token}`. Bad token → close code 4004.
3. Server dispatches `READY` (op 0, `s` increments per dispatch).
4. Client sends `op 1 Heartbeat {d: last_seq}` every interval; server replies `op 11`. Missing two heartbeats → server closes 4009.
5. `op 6 Resume {token, session_id, seq}` replays missed dispatches if the session buffer still has them; otherwise `op 9 InvalidSession`, and the client re-identifies.

Events are delivered only to users who can see the channel/guild. Event names and payloads: `GatewayEvents` in types.ts. Presence: connected → online, last connection closed → offline; `op 3 {status, custom_status}` updates it (custom_status max 128 chars). The presence preference is not kept across a full disconnect.

Semantics notes: a reply puts the replied-to author in `mentions` (Discord default). Pinning emits MESSAGE_UPDATE for the pinned message plus a type 6 system message (MESSAGE_CREATE). `referenced_message.reactions` is always `[]`. Role mentions only drive `mention_count` (no `mention_roles` field).

Message search (`MessageSearchQuery`): Discord's query shape. Array filters use repeated keys (`?has=image&has=link`, `?author_id=1&author_id=2`; values inside one filter are OR, different filters are AND, except repeated `has` which is AND). `content`: words, case-insensitive, all must appear (`simple` Postgres text search, so Swedish and English both work with no stemming); `"quoted phrase"` and `-excluded` follow `websearch_to_tsquery`. `author_id` (users), `mentions` (users, includes reply targets), `channel_id` (guild route only; channels the caller cannot read are ignored), `has` = `link | embed | file | image | video | sound | sticker` (`file` = any attachment; `image`/`video`/`sound` by attachment content type or embed type; `sticker` always matches nothing for now), `pinned` (`true` only pinned, `false` only unpinned, absent both), `min_id` / `max_id` (exclusive snowflakes: Discord's after/before/during are computed client-side from the date), `offset` (0-9975, default 0), `limit` (1-25, default 25), `sort_by` (`timestamp` default | `relevance`), `sort_order` (`desc` default | `asc`). Out-of-range values → 400 50035. `relevance` without `content` falls back to timestamp. Only user messages are searched (types 0 and 19): pin notices and join messages never match, so `from:` alone lists real messages. Response `{total_results, messages: Message[][]}`: `total_results` counts every match in the readable set (before offset/limit) and never includes channels the caller cannot read; each hit is a one-element array (Discord's shape, no context messages), with `Reaction.me` filled for the caller.

Read states: READY includes a read state for every channel the user can see that has messages. When a user joins a guild or a DM is created, their read state starts at the channel's latest message (nothing is unread). A channel without a read state counts as unread on the client.

## Adopted from Discord client facts (docs/research/discord-client-facts.md)
We match Discord's user-visible behaviour, not its wire protocol byte for byte. Adopted: `allowed_mentions` on send (reply ping toggle), paginated pins with `pinned_at` and the 250-pin cap, 10 files per message (25 MiB per file, configurable), bulk ack, 429 responses with `RateLimitError` + `Retry-After` header (code 20016 for slowmode later).
Client gateway behaviour (shell): first heartbeat after `random() * interval`, then every interval; no ACK before the next beat → close and reconnect; Hello must arrive within 30 s; resume only if the last ACK is under 3 minutes old, else identify; reconnect backoff 1 s doubling to 60 s with jitter; stop reconnecting only on close 4004 (bad token); the client closes its own sockets with 4000.
Not adopted for now: op 40 QoS heartbeat, ETF encoding, zstd/zlib compression, capabilities/client_state in Identify, the cloud upload flow (resumable PUT to an upload URL), ack tokens.

Embeds: on message create/edit the server extracts up to 5 http(s) URLs (not inside code, not `<url>`-wrapped), fetches each with a 5 s timeout, 1 MiB cap, no private/loopback addresses (SSRF guard), and parses Open Graph / Twitter card / oEmbed-less HTML meta into `Embed` (type link/article/image/video). Results arrive via MESSAGE_UPDATE after the create. Editing with flags SUPPRESS_EMBEDS (1<<2) clears them. Invite links are rendered client-side from GET /invites/{code}, not unfurled.

Moderation: missing permission → 403 50013; acting on someone at or above your highest role (or the owner) → 403 50013. Role/role-position edits are limited to roles below the actor's highest role (owner exempt). Channel overwrites resolve in Discord's order (@everyone, roles combined, member); ADMINISTRATOR in an overwrite is ignored. On guild join the server posts a UserJoin (type 7) system message in `system_channel_id` when set. A member timeout survives leaving or being kicked and is restored on rejoin (a ban drops it). Overwrite PUT/DELETE and `lock_permissions` require MANAGE_ROLES in the channel and every permission bit the change flips (403 50013); a caller who cannot see the channel gets 403 50001. A user can neither kick, ban nor time out themselves or the owner (403 50013). Bodies of `PUT /bans/{uid}` and `POST /roles` must be present (send `{}`).

Further semantics: `embed.url` is the normalised parsed URL; `proxy_url` is never set (clients load og:image/video straight from the origin; CSP + IP-exposure trade-off, revisit with a media proxy). Only the author may set message flags. Unfurling has no cache. A block closes 1:1 DMs both ways (403 50007) and DELETE never lifts the other side's block. Presence (READY and PRESENCE_UPDATE) is shared only with guild members, accepted friends and peers of DMs open on both sides. A closed DM is hidden for that user until a new message arrives. Pending (unreferenced) attachments are deleted after 1 h.

Presence on join: when a user joins a guild, existing members who didn't already share a guild/DM/relationship with them get GUILD_MEMBER_ADD followed by a PRESENCE_UPDATE with the joiner's current presence (if not offline). The joiner's GUILD_CREATE carries `presences` for the guild's online members. On leave/kick/ban, members who no longer share anything with the user get PRESENCE_UPDATE offline for them (and vice versa).

Presence status: `PresenceStatus` includes `invisible` (valid in op 3 and in the user's own READY presence; everyone else sees `offline`). The chosen status and custom_status are stored and restored on the user's first connection (default online); on the last disconnect others see offline but the choice is kept. Others never see a custom_status while the user is offline or invisible; the user's own READY and PRESENCE_UPDATE carry the chosen status (including `invisible`) and custom_status. `offline` sent in op 3 is stored as `invisible`. Deleting a guild does not send presence clean-up (members reconnect or learn from the next update).

Category sync: a channel created with `parent_id` copies the category's overwrites. PATCH /channels/{id} takes `lock_permissions?: boolean` together with `parent_id` (true = copy the new parent's overwrites, false/absent = keep its own). PUT/DELETE of an overwrite on a category also applies to every child whose overwrites equalled the category's before the change (CHANNEL_UPDATE per child). Clients show "synced" by comparing the arrays.

Limits and abuse controls: uploads max 25 MiB per file (server setting `VOKKO_MAX_UPLOAD_MB`, deliberately moderate: Vokko gives Nitro perks free but not Nitro's 500 MiB), 10 files per message, pending uploads quota 100 MiB per user (413, code 40005). Attachment files are streamed with `Cache-Control: private`. Gateway: frames over 16 KiB end the connection; custom_status over 128 chars → close 4002; op 3 more than 5/min per session or Identify more than 10/min per user → close 4008; a slow reader (queue full or a write stalled 10 s) → close 1013 (resumable); no Identify within 30 s → dropped; more than 16 unidentified sockets per address → HTTP 429. Logout closes that token's sessions with 4004. REST rate limits are per user, and per client address on /auth/* (burst 10, then 1 per 2 s). ack-bulk max 100 entries.

Profile perks (docs/research/discord-nitro-perks.md): every Discord Nitro profile perk is free. Animated avatars/banners are accepted as GIF/WebP with moderate caps (avatar ≤8 MiB in, 512x512 out, animated ≤2 MiB stored; banner ≤10 MiB in, ≤1360x480 out, animated ≤4 MiB stored). Decorations, profile effects and tag badges are ids into Vokko's own open asset set (shipped with the client), never Discord assets. Per-server member profile fields override the user's inside that guild; USER_UPDATE / GUILD_MEMBER_UPDATE carry the changes. Message length stays 2000 for now (the 4000 perk is a later decision with the composer). No boost levels: per-server limits are one owner-editable config block.
