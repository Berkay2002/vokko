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

## Server

`crates/server` is the chat backend (`vokko-server`): the REST API under `/api/v1`, the WebSocket gateway at `/gateway`, PostgreSQL storage and local attachment storage. The wire contract is [docs/api.md](docs/api.md). Rust types live in `crates/protocol/src/api.rs`, the TypeScript twins in `apps/desktop/src/api/types.ts`.

Requirements: a reachable PostgreSQL (14+). Configuration comes from the environment, then the nearest `.env.dev` (git-ignored):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres connection URL of the server database |
| `VOKKO_BIND` | `127.0.0.1:8710` | listen address (the project uses port 8710 only) |
| `VOKKO_DATA_DIR` | `<repo>/data/server-dev` | attachments are stored in `<dir>/attachments` |
| `VOKKO_PUBLIC_URL` | `http://<bind>` | origin used in absolute attachment URLs |
| `TEST_DATABASE_URL` | tests only | server URL whose role may `CREATE DATABASE`; every test creates and drops its own `vokko_test_*` database |

```powershell
cargo run -p vokko-server -- serve   # applies migrations, listens on 127.0.0.1:8710 (the default command)
cargo run -p vokko-server -- seed    # idempotent demo data
cargo test -p vokko-server           # integration tests against throwaway databases
```

`seed` creates the users `sam`, `carol`, `alice`, `bob` and `nova` (password `vokko-dev`), the guild "Sam's server" (categories, text and voice channels, a Moderator role, a hidden `#mods` channel, invite code `vokko-dev`), a DM between `sam` and `carol` with about 60 messages (replies, reactions, edits, a code block, a pin, an image attachment), a second unread DM, friendships, one pending friend request and pinned presences. Running it again changes nothing.

Smoke test against the running server:

```powershell
$login = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8710/api/v1/auth/login -ContentType application/json -Body '{"login":"sam","password":"vokko-dev"}'
Invoke-RestMethod -Uri http://127.0.0.1:8710/api/v1/users/@me -Headers @{ Authorization = $login.token }
```

Authentication is the raw token in the `Authorization` header (no `Bearer`). The gateway is `ws://127.0.0.1:8710/gateway`. Uploads are limited to 10 MiB per file and 10 per message; REST calls are rate limited per route with `429` and `Retry-After`.
## Workspace

```text
crates/protocol/             serializable domain data and command requests
crates/engine/               session and shared command registry
crates/platform/             adapted configuration paths and bounded rotating logs
crates/server/               chat backend: REST API, gateway, PostgreSQL storage
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
