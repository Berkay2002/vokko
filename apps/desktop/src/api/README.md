# Client data layer

| Module | What |
| --- | --- |
| `config.ts` | `MOCK` (no `VITE_VOKKO_API` → in-memory backend), `REST_BASE` (`<origin>/api/v1`), `GATEWAY_URL` (`<origin as ws>/gateway`, server root, not under /api/v1, override with `VITE_VOKKO_GATEWAY`), token storage (`localStorage["vokko.token"]`). |
| `rest.ts` | `request<T>(method, path, body?)`, `uploadAttachment(channelId, file, onProgress?, signal?)`, `ApiRequestError` (`.status`, `.api`, `.code`), `resolveUrl`. A 401 on any non-`/auth/` call drops the session. A 429 throws `RateLimitedError` (`.retryAfter` seconds, from `errors.ts`). |
| `gateway.ts` | `gateway.connect/disconnect/send/on/onStatus`. Timing per docs/api.md: first heartbeat after random()*interval, unACKed beat → close 4000 and reconnect, Hello within 30 s, resume only if the last ACK is under 3 min old (else identify), backoff 1 s doubling to 60 s with jitter, InvalidSession → re-identify, close 4004 → session cleared. |
| `store.ts` | `useStore(selector)` (shallow-compared, safe to return fresh arrays/objects), `appStore` (raw zustand store), `displayName`, `roleColor`, `defaultAvatarUrl`, `avatarUrl`, `dmName`, `guildInitials`, unread selectors (`isChannelUnread`, `channelMentionCount`, `guildUnread`), `typingUserIds`, `useUser`. |
| `auth.ts` | `login`, `register`, `logout`, `clearSession`, `bootstrap` (called from `main.tsx`). |
| `snowflake.ts` | `compareIds`, `maxId`, `snowflakeToTimestamp`, `timestampToSnowflake`. IDs are decimal strings: compare with `compareIds`, never as numbers. |
| `mock/` | Router for every route in `docs/api.md`, a mock gateway socket speaking the real protocol, seed data like `vokko-server seed`. |

## Store notes for consumers

- Unread = `channel.last_message_id` newer than `readStates[channel].last_message_id` (no read state counts as unread). The store updates `last_message_id`, `mention_count` and read states itself on `MESSAGE_CREATE` / `MESSAGE_ACK`; a chat view only has to `POST .../ack`.
- Own messages advance the read state immediately.
- `typing[channelId]` is pruned by the store 10 s after the last `TYPING_START`; use `typingUserIds(state, channelId)`.
- Pins are paginated: `GET /channels/{id}/messages/pins?limit&before` → `{items:[{message,pinned_at}], has_more}`; `PUT/DELETE .../pins/{messageId}` (250 max → 400 / 30003). Bulk ack: `POST /read-states/ack-bulk` (the shell's "Mark server as read" chunks by 100).
- The store never holds messages: the message cache per channel belongs to `src/chat`.

## Mock mode

`npm run dev` without `VITE_VOKKO_API` serves the seeded mock (login `sam` / `vokko-dev`, same password for `carol`, `alice`, `bob`, `nova`).

- `?as=<username>` signs in without the form; `?mockLatency=0` removes the simulated 25 ms request latency.
- `window.__vokkoMock`: `say(channelId, username, text, {replyTo})`, `typing`, `presence`, `dropConnections()` (client must resume), `offline(true|false)` (drop everything and refuse new sockets, the reconnecting banner shows; false lets the client back in), `rateLimit(count, retryAfter)` (next N requests answer 429), `addUser`, `messageTimestamp`, `channelIdByName`, `tokenFor`, `reset`. Mock snowflakes are time based: a page reload re-seeds the DB and invalidates the stored token.
- `window.__vokko`: `gateway`, `request`, `appStore` and the store helpers, for Playwright scripts.
