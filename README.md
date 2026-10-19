# Vokko

An open source community chat app, free of paid tiers, aiming at feature and layout parity with Discord. It is a self-hostable Rust server (Axum, Tokio, PostgreSQL) with a React 19 + TypeScript client that runs in the browser or inside a Tauri 2 desktop shell. Every perk that Discord sells is a normal feature here; only the paid machinery (billing, shop, boosts, quests, badges) is out of scope.

**Status:** under active development, pre-1.0. Servers, channels, threads, DMs and group DMs, roles and permissions, invites, messages with replies, reactions, polls, stickers, custom emoji, attachments and link previews, friends, presence, voice and video (LiveKit), bots and slash commands, activities (web games in calls), a soundboard, moderation tools and an audit log all exist. [docs/parity.md](docs/parity.md) tracks every row of the target inventory, with "looks the same" and "works the same" judged separately and honestly. Expect rough edges.

## Layout

```text
crates/protocol/             serializable domain data and wire types
crates/platform/             configuration paths and bounded rotating logs
crates/engine/               local session and command registry (desktop shell, CLI)
crates/server/               chat backend: REST API, gateway, PostgreSQL storage
apps/desktop/                React interface (src/), Playwright specs (e2e/), Tauri host (src-tauri/)
apps/cli/                    headless access to the local engine over stdin/stdout
tools/                       load test, Spotify and Stremio bots, backup and release scripts
examples/echo-bot/           a tiny bot using only the public API
integrations/                AI bridge and Claude Code channel for bots
deploy/                      Docker Compose, Caddy and LiveKit configuration for self-hosting
xtask/                       dependency-layer check and privacy guard
docs/                        API contract, architecture, self-hosting, parity roadmap
```

The wire contract is [docs/api.md](docs/api.md). Rust types live in `crates/protocol/src/api.rs`, their TypeScript twins in `apps/desktop/src/api/types.ts`. Initial engine/desktop architecture (historical, with a summary of the current server): [docs/architecture.md](docs/architecture.md).

## Run it locally

Requirements: Rust 1.95+, Node.js 22.12+, npm, a reachable PostgreSQL 14+, and [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/) for the desktop shell.

```sh
npm install
cargo run -p vokko-server -- seed    # applies migrations, adds idempotent demo data
cargo run -p vokko-server -- serve   # REST /api/v1 and gateway /gateway on 127.0.0.1:8710
VITE_VOKKO_API=http://127.0.0.1:8710 npm run dev   # web client on http://127.0.0.1:1420
npm run desktop                      # or the Tauri desktop shell (start one of the two, both use port 1420)
```

Without `VITE_VOKKO_API` the web client runs against an in-memory mock, which is what the e2e tests use.

Server configuration comes from the environment, then the nearest `.env.dev` (git-ignored):

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres connection URL of the server database |
| `VOKKO_BIND` | `127.0.0.1:8710` | listen address |
| `VOKKO_DATA_DIR` | `<repo>/data/server-dev` | attachments are stored in `<dir>/attachments` |
| `VOKKO_PUBLIC_URL` | `http://<bind>` | origin used in absolute attachment URLs |
| `VOKKO_UNFURL` | `on` | `off` disables link previews (the server then makes no outbound requests) |
| `VOKKO_MAX_UPLOAD_MB` | `500` | per-file upload limit in MiB (whole number, at least 1); values above 500, Nitro's limit, are lowered to 500 |
| `VOKKO_TRUST_PROXY` | `off` | `on` behind a reverse proxy that appends the client address to `X-Forwarded-For` |
| `TEST_DATABASE_URL` | tests only | server URL whose role may `CREATE DATABASE`; every test creates and drops its own `vokko_test_*` database |

`seed` creates the users `sam`, `carol`, `alice`, `bob` and `nova` (password `vokko-dev`), a guild with categories, channels, a role and an invite (`vokko-dev`), and a DM with some history. Never seed a server that other people can reach.

Smoke test against the running server (authentication is the raw token in the `Authorization` header, no `Bearer`):

```sh
curl -s -X POST http://127.0.0.1:8710/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"login":"sam","password":"vokko-dev"}'
```

## Self-hosting

One Rust binary plus PostgreSQL, packaged with Docker Compose and optional Caddy (HTTPS) and LiveKit (voice and video). See [docs/self-hosting.md](docs/self-hosting.md); [docs/self-hosting-free.md](docs/self-hosting-free.md) covers free-tier hosting and [docs/backups.md](docs/backups.md) backups.

## Develop

```sh
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p vokko-server -p vokko-protocol -p vokko-engine -p vokko-platform -p vokko-cli
cargo xtask layers                   # dependency-layer boundaries
cargo xtask privacy                  # personal-data guard, see CONTRIBUTING.md
npm run build                        # tsc --noEmit + vite build
npm test --workspace @vokko/desktop  # vitest
npm run e2e --workspace @vokko/desktop  # Playwright against the mock
```

Desktop releases and the updater are described in [docs/desktop-release.md](docs/desktop-release.md); bots in [docs/api.md](docs/api.md) (applications, commands, interactions) and [examples/echo-bot](examples/echo-bot); web games in [docs/games-sdk.md](docs/games-sdk.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Third-party asset credits are in [docs/assets-credits.md](docs/assets-credits.md). Vokko uses no Discord-owned assets.

## License

Copyright 2026 Berkay Orhan. Vokko is licensed under [AGPL-3.0-or-later](LICENSE). The protocol types (`crates/protocol`) and the bot examples (`examples/`) are
[Apache-2.0](crates/protocol/LICENSE), so bots and third-party clients can use any license. The bundled games keep their own licenses
(`apps/desktop/public/games/*/LICENSE-*`). Repository: https://github.com/Berkay2002/vokko
