# Initial architecture (historical)

> Note (2026-10): this records the initial local-only skeleton. It still holds for `crates/engine`, `apps/cli`, the Tauri dispatch bridge and the `cargo xtask layers` rules, but not for the chat backend.
>
> Current shape: the chat backend is `crates/server`, a single-process axum server. It serves the REST API under `/api/v1` and a websocket gateway backed by an in-process hub; the hub, replay buffers, presence and rate limiters live in memory, so it runs as a single instance. PostgreSQL holds durable state, uploads go to local disk or an S3-compatible bucket, and voice uses LiveKit (the server checks permissions, mints tokens and receives LiveKit webhooks). Bots such as the Stremio and Spotify players report back over internal HTTP endpoints (`/internal/...`) that are never exposed through the reverse proxy, apart from the LiveKit webhook when using LiveKit Cloud. The server checks permissions for every operation (`crates/server/src/access.rs`). The desktop and web client (`apps/desktop`) talks to that server over REST and the gateway, or to an in-memory mock backend when built without an API URL. See [api.md](api.md) for the wire contract and [self-hosting.md](self-hosting.md) for deployment.

Decision: use a reusable Rust skeleton with a React/TypeScript UI hosted by Tauri. Keep UI dependencies outside the shared engine. This is a local foundation, not a distributed chat system yet.

## Boundaries

`vokko-protocol` defines serializable domain records, snapshots, and requests. `vokko-platform` owns copied/adapted desktop configuration and logging helpers. Neither depends on the UI or engine.

`vokko-engine` owns a session and command registry. It depends only on protocol and general-purpose Rust libraries. It validates requests and returns errors for unknown commands, bad channels, empty/oversized messages, and unsupported actions. Its sample identities are not authentication or authorization.

The Tauri host owns `Mutex<Session>` and exposes one dispatch adapter. React renders returned snapshots and owns transient input drafts. No message body is interpreted as HTML. The CLI independently owns a session and calls the same dispatch function. The browser preview renders the shared fixture and allows presentation-only navigation; message mutations require the desktop Rust bridge.

`cargo xtask layers` rejects UI dependencies in shared crates and workspace dependencies that point upward or sideways. Register future crates explicitly in the table. The first engine returns small complete snapshots for simplicity. Replace these with paged queries and incremental events before introducing large message histories; media frames must not travel through this JSON command endpoint.

## Next architectural additions

1. Generated Rust/TypeScript bindings to enforce the wire contract. Still open: `apps/desktop/src/api/types.ts` is maintained by hand next to `crates/protocol/src/api.rs`.
2. Persistent local cache and asynchronous client synchronization.
3. Done: server authentication, authoritative permissions, durable messages, and realtime events (`crates/server`).
4. Done: media goes through a self-hosted LiveKit server, not this endpoint.
5. Done: desktop updater, installers and OS integration ([desktop-release.md](desktop-release.md)).

Do not infer server permissions from `CommandSpec.enabled`: it is local command availability. Server authorization must independently verify every operation. The memory-backed demo is temporary, bounded to 1000 messages; no disk persistence or network delivery is implied.
