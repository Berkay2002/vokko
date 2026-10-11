# Client data layer

| Module | What |
| --- | --- |
| `config.ts` | `MOCK` (no `VITE_VOKKO_API` → in-memory backend), `REST_BASE` (`<origin>/api/v1`), `GATEWAY_URL` (`<origin as ws>/gateway`, server root, not under /api/v1, override with `VITE_VOKKO_GATEWAY`), token storage (`localStorage["vokko.token"]`). |
| `rest.ts` | `request<T>(method, path, body?)`, `uploadAttachment(channelId, file, onProgress?, signal?)`, `ApiRequestError` (`.status`, `.api`, `.code`), `resolveUrl`. A 401 on any non-`/auth/` call drops the session. |
| `gateway.ts` | `gateway.connect/disconnect/send/on/onStatus`. Heartbeat, zombie detection, resume with backoff, InvalidSession → re-identify, close 4004 → session cleared. |
| `store.ts` | `useStore(selector)` (shallow-compared, safe to return fresh arrays/objects), `appStore` (raw zustand store), `displayName`, `roleColor`, `defaultAvatarUrl`, `avatarUrl`, `dmName`, `guildInitials`, unread selectors (`isChannelUnread`, `channelMentionCount`, `guildUnread`), `typingUserIds`, `useUser`. |
| `auth.ts` | `login`, `register`, `logout`, `clearSession`, `bootstrap` (called from `main.tsx`). |
| `snowflake.ts` | `compareIds`, `maxId`, `snowflakeToTimestamp`, `timestampToSnowflake`. IDs are decimal strings: compare with `compareIds`, never as numbers. |
| `mock/` | Router for every route in `docs/api.md`, a mock gateway socket speaking the real protocol, seed data like `vokko-server seed`. |

## Store notes for consumers

- Unread = `channel.last_message_id` newer than `readStates[channel].last_message_id` (no read state counts as unread). The store updates `last_message_id`, `mention_count` and read states itself on `MESSAGE_CREATE` / `MESSAGE_ACK`; a chat view only has to `POST .../ack`.
- Own messages advance the read state immediately.
- `typing[channelId]` is pruned by the store 10 s after the last `TYPING_START`; use `typingUserIds(state, channelId)`.
- The store never holds messages: the message cache per channel belongs to `src/chat`.

## Mock mode

`npm run dev` without `VITE_VOKKO_API` serves the seeded mock (login `sam` / `vokko-dev`, same password for `carol`, `alice`, `bob`, `nova`).

- `?as=<username>` signs in without the form; `?mockLatency=0` removes the simulated 25 ms request latency.
- `window.__vokkoMock`: `say(channelId, username, text, {replyTo})`, `typing`, `presence`, `dropConnections()` (client must resume), `channelIdByName`, `tokenFor`, `reset`.
- `window.__vokko`: `gateway`, `request`, `appStore` and the store helpers, for Playwright scripts.
