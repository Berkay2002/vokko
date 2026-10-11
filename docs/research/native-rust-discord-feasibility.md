# Native Rust Discord alternative: initial assessment

Research date: 2026-10-11. These are architecture recommendations, not a committed implementation plan. No application was built or benchmarked.

## Conclusion

A fully open source Discord alternative with a native Rust desktop client is feasible. Rust can implement application logic, a custom-rendered desktop interface, networking, and server services. Matching Discord's layout does not require HTML or Electron. Completing feature parity remains a substantial product and distributed-systems effort; language choice does not establish parity.

Distinguish a native application written in Rust from a dependency tree containing only Rust. Operating-system integrations and established media libraries can use other languages while remaining open source. Rust GUI frameworks generally draw their own controls; native execution does not mean using the operating system's standard widgets.

## ArtCraft's relevant example

The [Crafting Apps page](https://getartcraft.com/apps) describes native Rust applications with familiar layouts and several WebAssembly builds. [PhotoCraft](https://github.com/storytold/photocraft#under-the-hood) documents a Rust document/command engine with a thin egui interface, shared command execution across UI and automation, and CPU/GPU rendering oracles. It also explicitly labels itself early alpha and distinguishes menu wiring from actual behavior parity. Adopt that separation and evidence-based parity tracking for Vokko.

## Desktop UI shortlist

| Candidate | Evidence | Assessment for Vokko |
| --- | --- | --- |
| [Iced](https://github.com/iced-rs/iced) | Responsive layout, custom widgets, async actions, native GPU/software renderers; project describes itself as experimental. | A reasonable first candidate for a state-driven chat interface. Validate message selection, rich composition, accessibility, and long histories before commitment. |
| [GPUI Kit](https://github.com/longbridge/gpui-kit) | Project documents variable-height virtual lists, Markdown, AccessKit, and Windows/macOS/Linux support. | A strong candidate for a polished desktop chat UI. Validate its actual behavior and integration cost on target platforms. |
| [egui](https://github.com/emilk/egui) | ArtCraft's demonstrated approach; native and web support. Its README discusses layout tradeoffs and CPU costs for large scroll areas unless only visible content is laid out. | Viable, especially for quick development, but using ArtCraft's toolkit alone is insufficient reason to select it for chat. |

These comparisons are design judgments based on project documentation, not comparative benchmarks. Start with a small representative UI prototype before locking the toolkit: familiar server/channel/chat/member layout, variable-height messages, scroll anchoring, message text selection, a multiline composer with mentions, keyboard focus, IME, and accessibility.

## Voice and video

[str0m](https://github.com/algesten/str0m) supplies WebRTC transport and is developed heavily for SFU use. Its capability table explicitly excludes media capture, encoding/decoding, audio rendering, adaptive jitter buffering, and TURN support. Its chat example is not a production SFU. Choosing it entails assembling and maintaining the rest of the media pipeline.

[LiveKit's Rust SDK](https://github.com/livekit/rust-sdks) supports connection to a self-hosted server and uses libwebrtc through native bindings. The [LiveKit server](https://github.com/livekit/livekit) is open source and written in Go. This is a plausible way to retain a native Rust client and open source deployment while accepting a mixed-language media stack. It does not establish Discord parity; screen capture, system audio, device changes, permissions, reconnect behavior, and call quality still need evaluation.

## Proposed boundaries and scope

Keep shared protocol/domain types, client state/cache/synchronization, desktop presentation, server authorization/persistence/realtime delivery, and media integration separate. A Rust service stack with Tokio/Axum and PostgreSQL is a proposed starting point. Keep the server authoritative for permissions and message history; shared Rust types alone do not supply authorization.

Open source completeness should include client, application server, required media services, protocol documentation, migrations, and instructions to operate an independent deployment. Assets and dependencies also need suitable open licenses. Source availability does not remove bandwidth, storage, or operational costs.

Maintain two acceptance matrices: interface fidelity and actual feature behavior. Set a dated Discord reference because its interface and features evolve. Progress from the desktop shell to real text messaging and roles, voice, screen sharing/video, and then broader platform and advanced feature coverage. Browser and mobile clients need their own platform assessment; WebAssembly compilation alone does not establish their parity.
