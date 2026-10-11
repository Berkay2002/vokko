# Vokko

A community chat application, with a fully open source release and Discord feature and layout parity as its long-term goals. The initial foundation uses a Rust workspace, shared command engine, and desktop utilities, with a React/Tauri interface.

**Current stage:** local scaffold. Community/channel navigation and temporary local text messages work in the desktop shell. There are no real accounts, network connections, persistent message history, voice calls, uploads, or production deployments yet. The browser displays a read-only sample workspace with channel navigation.

## Run

Requirements: Rust 1.95+, Node.js 22.12+ (Node 24 recommended), npm, and [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/). Windows desktop builds need the MSVC build tools and WebView2.

```powershell
npm install
npm run desktop
```

Browser preview only:

```powershell
npm run dev
```

Open `http://localhost:1420`. The desktop command starts this frontend automatically; use one mode at a time because both use port 1420.

Build the frontend or desktop executable:

```powershell
npm run build
npm run desktop:build
```

Installer packaging is not configured yet. Desktop messages are kept in memory and reset on exit. Logging uses `VOKKO_CONFIG_DIR`, portable markers, or the platform's configuration directory; it does not log message bodies.

## Workspace

```text
crates/protocol/             serializable domain data and command requests
crates/engine/               session and shared command registry
crates/platform/             adapted configuration paths and bounded rotating logs
apps/cli/                    headless command access over stdin/stdout
apps/desktop/src/            React interface and desktop bridge
apps/desktop/src-tauri/      Tauri host, owning the Rust session
fixtures/demo.json           shared sample data, not a backend
xtask/                       dependency-layer enforcement
docs/                        architecture and parity planning
.references/                 ignored checkouts for research
```

Headless tools:

```powershell
cargo run -p vokko-cli -- inspect
cargo run -p vokko-cli -- commands
cargo run -p vokko-cli -- serve
```

`serve` reads one JSON request per line and writes one JSON response. Example requests:

```json
{"command":"channel.select","params":{"channel_id":"development"}}
{"command":"message.send","params":{"channel_id":"development","content":"Hello from the CLI"}}
```

The CLI and desktop are separate local sessions using the same engine. The CLI is not connected to an already running desktop instance.

Build and architecture checks:

```powershell
cargo check
cargo check -p vokko-desktop
cargo xtask layers
```

Read [architecture](docs/architecture.md) and [parity roadmap](docs/parity.md).
