# Vokko server API (v1 contract)

Types: `apps/desktop/src/api/types.ts` is the source of truth for JSON shapes until generated bindings replace it. The Rust side (`crates/protocol` `api` module) must serialize identically. Shapes follow Discord's public API where it fits, so behaviour can be compared one to one.

General rules:
- Base URL `http://<host>:<port>/api/v1`. Auth header `Authorization: <token>` (opaque session token, no "Bearer" prefix, Discord-style). Everything except `/auth/*` requires it.
- IDs are 64-bit snowflakes (Discord epoch 2015-01-01, worker/process bits, increment) serialized as strings.
- Errors: HTTP status + `ApiError` body. 400 → 50035, 401 → 0 "401: Unauthorized", 403 → 50001/50013, 404 → 10003 (channel), 10008 (message), 10004 (guild), 10013 (user).
- Server is authoritative for every permission check. Message content max 2000 chars, trimmed, not empty unless attachments exist.
- CORS allows `http://localhost:*`, `http://127.0.0.1:*` and `tauri://localhost` / `http://tauri.localhost` in dev.

## REST

| Method | Path | Notes |
| --- | --- | --- |
| POST | /auth/register | `RegisterRequest` → `AuthResponse` |
| POST | /auth/login | `AuthRequest` → `AuthResponse` |
| POST | /auth/logout | revokes token, 204 |
| GET | /users/@me | `User` |
| PATCH | /users/@me | `{global_name?, bio?, banner_color?, avatar_attachment_id?}` → `User` |
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
| PATCH | /guilds/{id} | `{name?, icon_attachment_id?, system_channel_id?}` → `Guild` |
| DELETE | /guilds/{id} | owner only, 204 |
| GET | /guilds/{id}/channels | `Channel[]` |
| POST | /guilds/{id}/channels | `{name, type, parent_id?, topic?, permission_overwrites?}` → `Channel` (private channel = @everyone deny VIEW_CHANNEL overwrite) |
| PATCH | /channels/{id} | `{name?, topic?, position?, parent_id?}` → `Channel` |
| DELETE | /channels/{id} | 200 + `Channel` (guild) / closes DM |
| GET | /guilds/{id}/members?limit&after | `GuildMember[]` |
| DELETE | /users/@me/guilds/{id} | leave guild, 204 |
| DELETE | /guilds/{id}/members/{uid} | kick (KICK_MEMBERS + hierarchy), 204, emits GUILD_MEMBER_REMOVE |
| PATCH | /guilds/{id}/members/{uid} | `EditMemberRequest` → `GuildMember`: nick needs MANAGE_NICKNAMES, roles MANAGE_ROLES (only roles below your highest), timeout MODERATE_MEMBERS; emits GUILD_MEMBER_UPDATE |
| PATCH | /guilds/{id}/members/@me | `{nick}` (CHANGE_NICKNAME) → `GuildMember` |
| GET | /guilds/{id}/bans | `Ban[]` (BAN_MEMBERS) |
| PUT | /guilds/{id}/bans/{uid} | `BanRequest`, 204; removes the member, emits GUILD_BAN_ADD + GUILD_MEMBER_REMOVE; banned users can't rejoin via invite (403 40007) |
| DELETE | /guilds/{id}/bans/{uid} | unban, 204, emits GUILD_BAN_REMOVE |
| POST | /guilds/{id}/roles | `RoleRequest` → `Role` (MANAGE_ROLES; new role at position 1; can't grant bits you lack) |
| PATCH | /guilds/{id}/roles | `RolePositionUpdate[]` → `Role[]` (only roles below your highest) |
| PATCH | /guilds/{id}/roles/{rid} | `RoleRequest` → `Role` |
| DELETE | /guilds/{id}/roles/{rid} | 204 (not @everyone) |
| PUT | /channels/{id}/permissions/{oid} | `OverwriteRequest`, 204 (MANAGE_ROLES on the channel), emits CHANNEL_UPDATE |
| DELETE | /channels/{id}/permissions/{oid} | 204, emits CHANNEL_UPDATE |
| POST | /channels/{id}/invites | `{max_age?, max_uses?}` → `{code, guild, channel, expires_at}` |
| GET | /invites/{code} | invite preview |
| POST | /invites/{code} | accept → `Guild` |
| GET | /channels/{id}/messages?before&after&around&limit | `Message[]` newest first, limit 1-100 (default 50) |
| POST | /channels/{id}/messages | `CreateMessageRequest` → `Message` |
| PATCH | /channels/{id}/messages/{mid} | author only, `EditMessageRequest` → `Message` |
| DELETE | /channels/{id}/messages/{mid} | author or MANAGE_MESSAGES, 204 |
| PUT | /channels/{id}/messages/{mid}/reactions/{emoji}/@me | emoji URL-encoded (unicode or `name:id`), 204 |
| DELETE | /channels/{id}/messages/{mid}/reactions/{emoji}/@me | 204 |
| GET | /channels/{id}/messages/{mid}/reactions/{emoji} | `User[]` who reacted |
| GET | /channels/{id}/messages/pins?limit&before | `PinnedMessagesPage` (newest pin first, limit 1-50, `before` = pinned_at ISO) |
| PUT/DELETE | /channels/{id}/messages/pins/{mid} | 204; max 250 pins per channel → 400 code 30003 |
| POST | /read-states/ack-bulk | `{read_states: [{channel_id, message_id}]}` → 204 ("mark server as read") |
| POST | /channels/{id}/typing | 204, emits TYPING_START (expires after 10 s client-side) |
| POST | /channels/{id}/messages/{mid}/ack | updates read state, 204 |
| POST | /channels/{id}/attachments | multipart `file` (max 10 MiB, Discord's default) → `Attachment` (pending until referenced by a message) |
| GET | /attachments/{id}/{filename} | serves the file (no auth required in v1; unguessable id) |

## Gateway

`GET /gateway` (at the server root, not under `/api/v1`; e.g. `ws://127.0.0.1:8710/gateway`) upgrades to WebSocket. Text frames carrying `GatewayPayload`.

1. Server sends `op 10 Hello {heartbeat_interval: 41250}`.
2. Client sends `op 2 Identify {token}`. Bad token → close code 4004.
3. Server dispatches `READY` (op 0, `s` increments per dispatch).
4. Client sends `op 1 Heartbeat {d: last_seq}` every interval; server replies `op 11`. Missing two heartbeats → server closes 4009.
5. `op 6 Resume {token, session_id, seq}` replays missed dispatches if the session buffer still has them; otherwise `op 9 InvalidSession`, and the client re-identifies.

Events are delivered only to users who can see the channel/guild. Event names and payloads: `GatewayEvents` in types.ts. Presence: connected → online, last connection closed → offline; `op 3 {status, custom_status}` updates it.

Semantics notes: a reply puts the replied-to author in `mentions` (Discord default). Pinning emits MESSAGE_UPDATE for the pinned message plus a type 6 system message (MESSAGE_CREATE). `referenced_message.reactions` is always `[]`. Role mentions only drive `mention_count` (no `mention_roles` field).

Read states: READY includes a read state for every channel the user can see that has messages. When a user joins a guild or a DM is created, their read state starts at the channel's latest message (nothing is unread). A channel without a read state counts as unread on the client.

## Adopted from Discord client facts (docs/research/discord-client-facts.md)
We match Discord's user-visible behaviour, not its wire protocol byte for byte. Adopted: `allowed_mentions` on send (reply ping toggle), paginated pins with `pinned_at` and the 250-pin cap, 10 files per message and 10 MiB per file, bulk ack, 429 responses with `RateLimitError` + `Retry-After` header (code 20016 for slowmode later).
Client gateway behaviour (shell): first heartbeat after `random() * interval`, then every interval; no ACK before the next beat → close and reconnect; Hello must arrive within 30 s; resume only if the last ACK is under 3 minutes old, else identify; reconnect backoff 1 s doubling to 60 s with jitter; stop reconnecting only on close 4004 (bad token); the client closes its own sockets with 4000.
Not adopted for now: op 40 QoS heartbeat, ETF encoding, zstd/zlib compression, capabilities/client_state in Identify, the cloud upload flow (resumable PUT to an upload URL), ack tokens.

Embeds: on message create/edit the server extracts up to 5 http(s) URLs (not inside code, not `<url>`-wrapped), fetches each with a 5 s timeout, 1 MiB cap, no private/loopback addresses (SSRF guard), and parses Open Graph / Twitter card / oEmbed-less HTML meta into `Embed` (type link/article/image/video). Results arrive via MESSAGE_UPDATE after the create. Editing with flags SUPPRESS_EMBEDS (1<<2) clears them. Invite links are rendered client-side from GET /invites/{code}, not unfurled.

Moderation: missing permission → 403 50013; acting on someone at or above your highest role (or the owner) → 403 50013. Role/role-position edits are limited to roles below the actor's highest role (owner exempt). Channel overwrites resolve in Discord's order (@everyone, roles combined, member); ADMINISTRATOR in an overwrite is ignored. On guild join the server posts a UserJoin (type 7) system message in `system_channel_id` when set.
