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
- Threads (types 10-12) live in `threads` (by id), not in `channels`: READY / GUILD_CREATE `threads`, THREAD_CREATE / UPDATE / DELETE and the member events keep them current (`thread.member` = the current user's membership, `upsertThread` keeps it when an update omits it). Archived threads are fetched on demand (`listArchivedThreads`, `searchThreads` in `rest.ts`) and added when opened. There is no thread list sync: `refreshActiveThreads(guildId)` refetches `GET /guilds/{id}/threads/active` after own role / role / overwrite changes. `useChannel(id)` in `src/chat/shell.ts` falls back to `threads`, so the chat view works on a thread id. Permissions inside a thread: `threadPermissions(parentBits)` in `permissions.ts` (SEND_MESSAGES replaced by SEND_MESSAGES_IN_THREADS).

## Mock mode

`npm run dev` without `VITE_VOKKO_API` serves the seeded mock (login `sam` / `vokko-dev`, same password for `carol`, `alice`, `bob`, `nova`).

- `?as=<username>` signs in without the form; `?mockLatency=0` removes the simulated 25 ms request latency.
- `window.__vokkoMock`: `say(channelId, username, text, {replyTo})`, `typing`, `presence`, `dropConnections()` (client must resume), `restart()` (a server restart: sessions are forgotten, clients identify again, voice states stay), `offline(true|false)` (drop everything and refuse new sockets, the reconnecting banner shows; false lets the client back in), `rateLimit(count, retryAfter)` (next N requests answer 429), `addUser`, `messageTimestamp`, `channelIdByName`, `tokenFor`, `seedOnboardingGuild(owner?)` (a guild with onboarding questions, rules, an invite code and a stranger member, for the community e2e), `reset`. Mock snowflakes are time based: a page reload re-seeds the DB and invalidates the stored token.
- `window.__vokko`: `gateway`, `request`, `appStore`, the store helpers and the `localState` / `prefs` / `sounds` modules, for Playwright scripts. Specs use these, never `import('/src/...')` in the page: after an HMR edit that loads a second module instance.
- Threads, forums and announcements (`mock/threads.ts`): every route of docs/api.md with the server's error codes and THREAD_* events; threads are `MockChannel`s of type 10-12 in `db.channels` (hidden from the guild channel lists, resolved through their parent in `access.ts`), follows are in `db.followers`. The seed gives "Sam's server" two threads in #general (one archived), the announcement channel #announcements and the forum #support with five tags and five posts. Idle threads are archived by `sweepArchivedThreads` (every 30 s and before each list).
- Apps (`mock/apps.ts`): applications, OAuth2-style authorize, commands, interactions (with ephemeral messages kept per recipient), webhooks and their token URLs, with the server's error codes and events. The seed has the Echo application owned by sam, not in any server; `__vokkoMock.installEchoBot()` adds it to "Sam's server" and its handler answers /echo (ephemeral), /roll (deferred), /pick (autocomplete), Wave at and Quote like `examples/echo-bot`. `__vokkoMock.executeWebhook(channelId, content, username?)` posts through a channel's webhook. The client side lives in `src/apps` (README there is `index.ts`).
