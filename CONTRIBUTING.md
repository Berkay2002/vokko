# Contributing to Vokko

Thanks for helping. Vokko is licensed under AGPL-3.0-or-later, except `crates/protocol` and `examples/` (Apache-2.0); contributions are accepted under the license of the files they change (inbound = outbound).

## Setup

Requirements: Rust 1.95+, Node.js 22.12+, npm, PostgreSQL 14+ (for server tests, via `TEST_DATABASE_URL`). See the README for running the server and client.

```sh
npm install
```

## Checks

Run the narrowest relevant ones while working, and all of them before opening a pull request:

```sh
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p vokko-server -p vokko-protocol -p vokko-engine -p vokko-platform -p vokko-cli
cargo xtask layers
cargo xtask privacy
npm run build
npm test --workspace @vokko/desktop
npm run e2e --workspace @vokko/desktop
```

When you touch them, also run: `cargo test -p xtask -p vokko-loadtest -p spotify-bot -p stremio-bot -p vokko-desktop`, `npm test` in `examples/echo-bot`, and `bun install && bun run typecheck && bun test` in each `integrations/*` folder. CI gates on everything above except the media bots, the Tauri crate and the dependency audits (`cargo audit`, `npm audit --omit=dev --audit-level=high`), which run as non-blocking jobs: the bots and the Tauri shell need native libraries, and new advisories would otherwise block unrelated pull requests.

Keep each file's existing line endings. Changes to the wire contract update `docs/api.md`, `crates/protocol/src/api.rs` and `apps/desktop/src/api/types.ts` together. Do not add Discord-owned assets (logos, icons, fonts, sounds, art).

## Personal data and deployment values never go in commits

No real names, handles, email addresses, personal domains, hostnames, IP addresses, home-directory paths, tokens, keys or `.env` files. Use placeholders: `example.com`, `vokko.example.com`, `192.0.2.10`, `sam`, `carol`. Deployment-specific values belong in git-ignored files (`deploy/.env`, `.private/`) or environment variables.

`cargo xtask privacy` checks tracked files (binary ones too, reported by path only) and their file names (a hit is reported by its position in `git ls-files`) against a pattern list. Maintainers keep that list in `.private/denylist.txt` (git-ignored) or the `VOKKO_PRIVACY_DENYLIST` environment variable (a CI secret); without either the check skips itself. Never write those patterns into a tracked file.

## Security

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).
