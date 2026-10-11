# Initial architecture

Decision: use a reusable Rust skeleton with a React/TypeScript UI hosted by Tauri. Keep UI dependencies outside the shared engine. This is a local foundation, not a distributed chat system yet.

## Boundaries

`vokko-protocol` defines serializable domain records, snapshots, and requests. `vokko-platform` owns copied/adapted desktop configuration and logging helpers. Neither depends on the UI or engine.

`vokko-engine` owns a session and command registry. It depends only on protocol and general-purpose Rust libraries. It validates requests and returns errors for unknown commands, bad channels, empty/oversized messages, and unsupported actions. Its sample identities are not authentication or authorization.

The Tauri host owns `Mutex<Session>` and exposes one dispatch adapter. React renders returned snapshots and owns transient input drafts. No message body is interpreted as HTML. The CLI independently owns a session and calls the same dispatch function. The browser preview renders the shared fixture and allows presentation-only navigation; message mutations require the desktop Rust bridge.

`cargo xtask layers` rejects UI dependencies in shared crates and workspace dependencies that point upward or sideways. Register future crates explicitly in the table. The first engine returns small complete snapshots for simplicity. Replace these with paged queries and incremental events before introducing large message histories; media frames must not travel through this JSON command endpoint.

## Next architectural additions

1. Generated Rust/TypeScript bindings to enforce the wire contract.
2. Persistent local cache and asynchronous client synchronization.
3. Server authentication, authoritative permissions, durable messages, and realtime events.
4. Independent native/browser media adapters and a self-hostable media service.
5. Desktop update/installer infrastructure and platform-specific integration.

Do not infer server permissions from `CommandSpec.enabled`: it is local command availability. Server authorization must independently verify every operation. The memory-backed demo is temporary, bounded to 1000 messages; no disk persistence or network delivery is implied.
