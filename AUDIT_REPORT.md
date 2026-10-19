# Audit report (branch audit/2026-10-19)

## 1. Summary

**Project.** Vokko v0.1.13 (pre-1.0, AGPL-3.0-or-later; `crates/protocol` and `examples/` Apache-2.0) is a self-hostable, Discord-parity community chat app. The server is a single-process Rust 2024 workspace (axum 0.8, tokio, sqlx/PostgreSQL, argon2, rustls). It holds gateway sessions, presence, voice, Watch Together, Stremio/Spotify sessions and rate limiters in memory, and stores attachments on local disk or S3. Voice and video go through LiveKit. The client is React 19 + TypeScript (Vite, zustand), running in the browser or a Tauri 2 shell, with a full in-memory mock backend used by vitest and Playwright.

**Scope.** 14 slices: server-auth-accounts, server-guild-permissions, server-messages-threads, gateway-realtime, storage-sql-migrations, uploads-outbound-ssrf, voice-livekit-games, apps-bots-integrations, stremio-spotify-bots, client-api-types, client-ui-rendering-perf, tauri-host, deploy-config-secrets, deps-ci-tests-docs.

**Method.**
1. Full suite baseline (fmt, clippy, Rust tests, layers, privacy, UI build, vitest, e2e, Tauri crate build).
2. One Opus audit per slice.
3. Every medium-or-higher finding verified adversarially by three independent lenses; refuted findings dropped.
4. Confirmed findings fixed one per commit, each with a regression test where feasible, and each commit reviewed. A commit that failed review was reverted.
5. Full suite rerun on the final branch.

**Headline numbers.**

| | Count |
|---|---|
| Fixed and committed | 30 (3 high, 10 medium, 17 low) |
| Fix reverted after review, then redone | 1 |
| Confirmed, left alone | 12 (9 medium, 3 low) |
| Refuted | 2 |
| Low, unverified, not fixed | 49 |

Branch diff vs `main`: 36 commits (30 fixes, the reverted first attempt and its revert, one line-ending restore, this report and its follow-up update). Executed Rust tests went from 812 (808 passed) to 822 (all passed), vitest from 2100 to 2115.

## 2. Fixed

All shas confirmed present in `git log --oneline main..HEAD` and not reverted. "API" = public behavior or API change; "Docs" = documentation updated in the same commit.

| Id | Sev | Title | Location | Commit | API | Docs |
|---|---|---|---|---|---|---|
| gateway-realtime-1 | high | Unauthenticated op 6 Resume loop caused unlimited DB token lookups per pre-auth socket. Now session lookup first, close 4008 after two failed resumes | crates/server/src/gateway.rs:212 | 92a28c33 | yes | yes |
| uploads-outbound-ssrf-1 | high | Unfurl meta scanner copied the content value once per name/property attribute (multi-GB allocation from one link). Now one copy per key, at most 256 tags | crates/server/src/unfurl.rs:383 | f4b8c1f7 | | |
| uploads-outbound-ssrf-2 | high | `decode_entities` was quadratic in the number of `&`, blocking tokio workers. Now scans an 11-byte window | crates/server/src/unfurl.rs:232 | 656fbe9b | | |
| server-auth-accounts-1 | medium | Current-password confirmation had no failure counting, so a stolen session could brute-force the password. Now 429 after 10 wrong in 15 min (new `password_failures` table) | crates/server/src/account/me.rs:31 | 133c6387 | yes | yes |
| server-messages-threads-1 | medium | Replies skipped READ_MESSAGE_HISTORY but returned `referenced_message`. Now 403 50013 | crates/server/src/routes/messages.rs:722 | 16e4238a | yes | yes |
| gateway-realtime-2 | medium | Invisible / appear-offline users leaked activity through redundant offline PRESENCE_UPDATEs | crates/server/src/presence.rs:177 | b1393bad | | yes |
| gateway-realtime-3 | medium | Role changes and role permission edits never sent CHANNEL_CREATE/DELETE, leaving client channel lists stale | crates/server/src/routes/moderation.rs:688 | 10d37916 | | yes |
| apps-bots-integrations-2 | medium | Editing a webhook or interaction message never updated role mentions | crates/server/src/routes/interactions.rs:763 | 5a9fd47a | | |
| client-ui-rendering-perf-1 | medium | Pasted message links never opened in-app (onLink intercepted first) | apps/desktop/src/chat/markdown/render.tsx:268 | f6806074 | | |
| client-ui-rendering-perf-2 | medium | Web CSP in the Caddyfile lacked GIF provider image hosts and was untested | deploy/Caddyfile:52 | 0d58b074 | | |
| tauri-host-1 | medium | Changing the output device left a stale mic track published and published a second one (Linux native voice; compiled, live harness not run) | apps/desktop/src-tauri/src/native_voice/mod.rs:446 | 751549fb | | |
| deploy-config-secrets-1 | medium | Compose did not pass mail, OAuth/OIDC, CORS and several voice variables into the server container. Now `env_file: .env` | deploy/docker-compose.yml:34 | 584a84bd | | yes |
| server-messages-threads-2 | low | Edits re-resolved mentions and ignored `allowed_mentions`. PATCH now accepts the field | crates/server/src/routes/messages.rs:902 | b822b934 | yes | yes |
| gateway-realtime-5 | low | A token revoked while READY was building left a live session. Token re-checked after registration | crates/server/src/gateway.rs:205 | 2000ec7a | | |
| gateway-realtime-7 | low | docs/api.md misdescribed presence persistence across disconnects | docs/api.md:535 | 0f9e2b0d | | yes |
| storage-sql-migrations-1 | low | FK columns into messages/channels had no index (seq scans on delete). New migration plus schema test | crates/server/migrations/20261012090100_media_actions.sql:53 | abcb5ee8 | | |
| uploads-outbound-ssrf-4 | low | `text/jscript` and `text/livescript` uploads could be served as same-origin scripts | crates/server/src/media.rs:269 | 3e1c6cf9 | | |
| apps-bots-integrations-1 | low | Slash commands bypassed channel-type and locked-thread checks | crates/server/src/routes/interactions.rs:219 | d746e672 | yes | yes |
| stremio-spotify-bots-1 | low | Spotify bot LiveKit token minted once (12 h TTL) and never refreshed | crates/server/src/voice/spotify.rs:491 | 07a713f1 | | yes |
| stremio-spotify-bots-2 | low | A late Stremio `started` from the previous item overwrote the new item's state. Event now carries `generation` (internal bot wire change) | crates/server/src/voice/stremio.rs:937 | fc45d13c | | yes |
| client-api-types-1 | low | USER_UPDATE for another user was dropped when only profile/perk fields changed | apps/desktop/src/api/store.ts:149 | d5d346ec | | |
| client-ui-rendering-perf-3 | low | GIF-only messages bypassed embed settings and SUPPRESS_EMBEDS | apps/desktop/src/chat/MessageItem.tsx:164 | 41d92575 | | |
| client-ui-rendering-perf-5 | low | messageStore was not reset on logout or account switch (Retry posted the previous account's message) | apps/desktop/src/chat/messageStore.ts:24 | 5aa233f6 | | |
| tauri-host-4 | low | Log rotation ran before the single-instance check, so a second launch rotated the running session's log | apps/desktop/src-tauri/src/main.rs:175 | 19946d8b | | yes |
| deploy-config-secrets-2 | low | Server ignored SIGTERM as PID 1. Now handles SIGTERM on Unix (not compiled or tested on Unix here) | crates/server/src/main.rs:56 | 2f7b7824 | | |
| deps-ci-tests-docs-1 | low | CI actions pinned by mutable tag in the job holding the privacy secret. Now SHA-pinned, Dependabot added, privacy in its own job | .github/workflows/ci.yml:44 | 73152bde | | |
| deps-ci-tests-docs-4 | low | self-hosting.md understated what the sample Caddyfile forwards | docs/self-hosting.md:168 | 0d03fd14 | | yes |
| deps-ci-tests-docs-5 | low | README gave the VOKKO_MAX_UPLOAD_MB default as 25 (real: 500) | README.md:49 | e114375d | | yes |
| deps-ci-tests-docs-6 | low | docs/architecture.md described the original skeleton. Now marked historical with a current-shape section | docs/architecture.md:3 | f4d4009a | | yes |
| uploads-outbound-ssrf-3 | medium | Embed-media proxy: a joiner taking over a cancelled download ran it without a per-address slot, so one address could fill every server-wide download slot; a cancelled starter orphaned its inflight cell. Now whoever runs a download holds its own caller's slot (a slotless takeover gives up at once), and the cell is forgotten once nobody uses it. Redone after the first attempt was reverted (section 3), reviewed twice | crates/server/src/embed_media.rs:304 | 0af6be9e, 0966587b | | |
| server-messages-threads-6 | low | Poll answer custom emoji were only shape-checked, so members could attach role-restricted, external or made-up emoji. Now resolved like reactions (10014 unknown, 50013 unusable, USE_EXTERNAL_EMOJIS; stored name kept) | crates/server/src/polls.rs:55 | 42892c41 | yes | yes |

Notes on fixed items:
- The new CI `privacy` job must be added to required checks if branch protection lists them.
- The mock (`apps/desktop/src/api/mock`) was not updated for the password-failure 429 or the slash-command channel rules.
- Commits b822b934 and 5aa233f6 converted `apps/desktop/src/api/types.ts` and `apps/desktop/src/chat/messageStore.ts` from CRLF to LF; a86ea1c0 restores CRLF, so the branch diff against `main` shows only the real 1 and 22 changed lines. The tree mixes LF and CRLF files (no `.gitattributes`), which invites this churn again.

## 3. Reverted fixes

| Id | Title | Commit | Revert | Why |
|---|---|---|---|---|
| uploads-outbound-ssrf-3 | Embed-media inflight cell left behind when the starting request is cancelled, so later callers bypass the per-address download cap | 4ceb0f76 | 569cfbdb | Failed per-commit review of `crates/server/src/embed_media.rs` (`get_or_fetch`, the `Forget` drop guard, `EmbedMediaProxy::get` and `fetch`). The reviewer accepted moving cleanup into a Drop guard but rejected the commit as written. The reviewer showed the takeover still ran without a slot. Redone in 0af6be9e (admission inside the cell's init, `Using` drop guard); its review found a new per-URL stall (a takeover waiting 10 s for a slot while holding the cell), fixed in 0966587b. Both reviewed and passing. |

## 4. Confirmed but left alone

| Id | Sev | Title | Location | Why left | Recommended approach |
|---|---|---|---|---|---|
| server-auth-accounts-2 | medium | Unbounded argon2 semaphore queue: a few accounts can stall login for everyone | crates/server/src/auth.rs:17 | Risky (all auth paths) | Time-bound `acquire` (about 2 s) or `try_acquire` with a small queue, then 503/429 with Retry-After. Pairs with the password-failure counting already landed. |
| server-auth-accounts-3 | medium | No per-account cooldown on verification mail (mail-bombing, sender reputation) | crates/server/src/account/mod.rs:132 | Risky | Same 60 s cooldown as `send_reset` (429 with Retry-After), optional daily cap; document it. |
| server-guild-permissions-1 | medium | Forwards bypass AutoMod keyword, regex and spam rules | crates/server/src/safety.rs:226 | Risky (send path) | Run `check_send` on the forward snapshot's content before insert; clean up copied files on block; add a test. |
| gateway-realtime-4 | medium | Events dispatched while READY is being built are lost to the new session | crates/server/src/gateway.rs:198 | Risky (hub design) | Register a pending session with a hold buffer, push READY as seq 1, then flush held events. |
| gateway-realtime-6 | medium | No cap on concurrent gateway sessions per user | crates/server/src/hub.rs:298 | Product decision | Cap at 16 to 32 per user (higher for bots), close the oldest with a resumable code. |
| storage-sql-migrations-2 | medium | Mentions inbox scans whole readable history; no `message_mentions(user_id)` index | crates/server/src/routes/mentions.rs:49 | Risky (query rewrite) | Add `(user_id, message_id DESC)` index; drive the query from a UNION of candidate ids. |
| storage-sql-migrations-4 | medium | Offsite `rsync --delete` mirrors a local loss and wipes offsite history | tools/backup.sh:81 | Product decision | Drop `--delete` and rotate offsite by age, or use `--backup-dir`; at least refuse to sync when local sets are missing. Fix docs/backups.md. |
| voice-livekit-games-1 | medium | `participant_left` for a superseded participant (same identity and token) removes the live voice state | crates/server/src/voice/state.rs:984 | Risky (webhook ordering) | Record participant sid on join and require it to match on leave; add a join A, join B, leave A test. |
| tauri-host-2 | medium | .deb installs cannot auto-update (manifest has only the AppImage) | tools/release-desktop.sh:105 | Product decision | Sign the .deb and add a `linux-x86_64-deb` manifest entry checked by `check_manifest`, or disable the updater for deb builds. |
| client-ui-rendering-perf-4 | low | Embed videos load directly from third-party hosts, not the proxy | apps/desktop/src/chat/Embeds.tsx:163 | Product decision | Proxy video through embed_media with size and range caps, or show a proxied thumbnail with click-to-open. |
| tauri-host-5 | low | One global popup budget shared by link clicks, OAuth and framed games | apps/desktop/src-tauri/src/popups.rs:25 | Product decision | Unthrottled command for app-initiated opens; throttle only untrusted frames; toast when suppressed. |
| (follow-up) | medium | Slash commands and component clicks skip the rules gate and verification level that message sends enforce (`crate::safety::check_send`), and options are not AutoMod-screened or slowmode-limited | crates/server/src/routes/interactions.rs:224 | Product decision: docs/api.md (Rules gate) says interactions are not gated on purpose, and slowmode is documented as not applying | If reversed: call `check_rules_accepted` and `check_verification` in `invoke` for guild channels, decide whether autocomplete and component clicks are gated too, update docs/api.md. |
| deps-ci-tests-docs-3 | low | CI never lints or tests tools/*, the Tauri crate, xtask, integrations or echo-bot | .github/workflows/ci.yml:51 | Product decision (CI cost) | Add jobs for xtask and loadtest, the bots, `cargo test -p vokko-desktop`, and echo-bot/integrations; align README/CONTRIBUTING with CI. |

The fixer skipped no confirmed fix. Partial-scope items noted by fixers:
- **gateway-realtime-1:** repeated bad Identify on fresh sockets still costs one query each.
- **uploads-outbound-ssrf-4:** no allowlist rewrite, and rows already stored with these types are not rechecked.
- **apps-bots-integrations-1:** component clicks in threads locked later are not re-checked, and bot replies do not reopen archived threads.

## 5. Refuted findings

| Id | Title | Reason dropped |
|---|---|---|
| apps-bots-integrations-3 | claude-channel lets any guild member steer the session and attach local files | Documented, deliberate behavior: ACCESS.md "Server channels" and commit f3fb4235 chose the open guild default. |
| deps-ci-tests-docs-2 | Applied migrations edited in place | None of the cited edits touched a migration already on main's first-parent history; all were made on feature branches before merge. |

## 6. Low-severity findings (unverified, not fixed)

| Id | Title | Location | Suggested fix |
|---|---|---|---|
| server-auth-accounts-5 | Email validation accepts display-name forms | crates/server/src/account/rules.rs:29 | Parse addr-spec only, require exact round-trip |
| server-auth-accounts-6 | Password reset does not invalidate MFA login tickets | crates/server/src/account/security.rs:370 | Delete `mfa_tickets` for the user on reset and change |
| server-auth-accounts-7 | MFA lockout 429 has no Retry-After and code 0 | crates/server/src/account/security.rs:115 | Return `rate_limited(secs)` (also applies to the new password lockout) |
| server-auth-accounts-8 | OAuth unlink needs no identity confirmation | crates/server/src/account/oauth.rs:660 | Require `confirm_identity` or document |
| server-guild-permissions-2 | create_channel accepts a parent category the creator cannot view | crates/server/src/routes/guilds.rs:624 | Check VIEW_CHANNEL on the parent |
| server-guild-permissions-3 | Kick/ban hierarchy checks outside the removing transaction | crates/server/src/routes/moderation.rs:339 | Check inside tx after locking the member row |
| server-guild-permissions-4 | Role reorder and delete not transactional | crates/server/src/routes/moderation.rs:909 | One tx plus guild row lock |
| server-messages-threads-3 | Rejected send still starts slowmode | crates/server/src/routes/messages.rs:742 | Move check after prepare, or roll back the slot |
| server-messages-threads-4 | Forward with comment in slowmode reports the forward as failed | apps/desktop/src/media/ForwardModal.tsx:36 | Send comment in the same request |
| server-messages-threads-5 | Starting a thread skips the parent's slowmode | crates/server/src/routes/threads.rs:197 | Run check_slowmode on the parent |
| gateway-realtime-8 | Duplicate socket when `online` fires during backoff | apps/desktop/src/api/gateway.ts:59 | Teardown before open |
| gateway-realtime-9 | Client RESUME_WINDOW check is dead code; server ignores session_ttl on resume | apps/desktop/src/api/gateway.ts:197 | Capture lastAckAt first; enforce TTL server-side |
| gateway-realtime-10 | Handshake timeout during send_active leaves an orphan session | crates/server/src/gateway.rs:207 | Stop the timeout once the session opens |
| storage-sql-migrations-3 | Backups include the embed-media cache; docs say they do not | tools/backup.sh:44 | `--exclude=./embed-media` |
| storage-sql-migrations-6 | restore.sh URL mode drops the DB under a running server | tools/restore.sh:26 | Require confirmation flag or document |
| storage-sql-migrations-7 | Message loading fetches every reaction row | crates/server/src/store.rs:737 | Aggregate in SQL |
| storage-sql-migrations-8 | S3 copy fallback buffers the whole object | crates/server/src/storage/s3.rs:255 | Stream or spool to disk |
| storage-sql-migrations-9 | Snowflake state not seeded; backward clock across restart can reissue ids | crates/server/src/ids.rs:13 | Seed last_ts from `max(id)` |
| storage-sql-migrations-10 | backup.sh passes the DB URL with password on the command line | tools/backup.sh:29 | Use PGPASSWORD or a passfile |
| uploads-outbound-ssrf-5 | Sticker cap checked without a lock | crates/server/src/routes/stickers.rs:81 | Count inside tx after guild `FOR UPDATE` |
| uploads-outbound-ssrf-6 | SSRF guard misses 64:ff9b:1::/48 and ::ffff:0:0/96 | crates/server/src/unfurl.rs:173 | Treat all 64:ff9b::/32 as IPv4-carrying; reject ::ffff:0:0/96 |
| voice-livekit-games-2 | room_finished ignores which room instance finished | crates/server/src/voice/state.rs:1018 | Compare room sid or created_at |
| voice-livekit-games-3 | docs/api.md says 15 s DM call connect timeout (code: 30 s) | docs/api.md:663 | Fix the number |
| voice-livekit-games-4 | release_channel runs a stage-end query on every leave | crates/server/src/voice/state.rs:734 | Only for stage channels |
| voice-livekit-games-5 | Stage stays live when the last moderator loses permissions | crates/server/src/voice/state.rs:729 | Re-check after recompute |
| apps-bots-integrations-4 | echo-bot entry check never matches on Windows | examples/echo-bot/bot.ts:109 | Compare `fileURLToPath` with resolved argv |
| apps-bots-integrations-5 | Non-mentionable role pings tied to `parse` containing everyone | crates/server/src/apps.rs:66 | Separate role resolution from the everyone opt-in |
| apps-bots-integrations-6 | Autocomplete choices validated only by count | crates/server/src/routes/interactions.rs:568 | Reuse registration-time validation |
| client-api-types-2 | GUILD_MEMBER_UPDATE keeps stale mute/deaf/flags | apps/desktop/src/api/store.ts:483 | Normalize defaults or replace the entry |
| client-api-types-3 | Client moderation checks differ from server (timeout clamp, role tie-break) | apps/desktop/src/api/permissions.ts:172 | Mirror `access.rs` |
| client-api-types-4 | uploadAttachment sends when already aborted; 429 drops retry_after | apps/desktop/src/api/rest.ts:170 | Check signal first; parse 429 body |
| client-ui-rendering-perf-6 | inviteCache caches failures forever | apps/desktop/src/chat/Embeds.tsx:30 | Evict on failure |
| client-ui-rendering-perf-7 | Screen-reader announcement reads spoilers | apps/desktop/src/chat/MessageList.tsx:254 | Use notify/text formatter |
| tauri-host-6 | Upload Preview does nothing in the desktop app | apps/desktop/src/chat/Composer.tsx:442 | Preview in-app or hide under Tauri |
| tauri-host-7 | Prefs, window state and crash marker written non-atomically | apps/desktop/src-tauri/src/prefs.rs:76 | Temp file plus rename |
| tauri-host-8 | Release script uses a predictable /tmp path and exports signing secrets before npm ci | tools/release-desktop.sh:74 | `mktemp`; scope secrets to the build command |
| tauri-host-9 | Stale app_dirs and unsafe_code comments | crates/platform/src/app_dirs.rs:1 | Rewrite comments |
| deploy-config-secrets-4 | .dockerignore omits `.private/` and other ignored local files | .dockerignore:1 | Mirror .gitignore |
| deploy-config-secrets-6 | Privacy guard skips binary files | xtask/src/main.rs:125 | Second `git grep -l --text` pass plus path check |
| deploy-config-secrets-7 | self-hosting-free.md misstates S3 disk use and voice timeout | docs/self-hosting-free.md:98 | Correct both |
| deps-ci-tests-docs-7 | api.md says embed-media proxy has no cache | docs/api.md:579 | Describe the disk cache |
| deps-ci-tests-docs-8 | Dockerfile HEALTHCHECK only TCP-connects | Dockerfile:31 | Probe /healthz |
| deps-ci-tests-docs-9 | Stale pnpm-lock.yaml tracked beside package-lock.json | apps/desktop/pnpm-lock.yaml:1 | Delete it; set `packageManager` |
| deps-ci-tests-docs-10 | Docs cite commit hashes absent from public history | docs/parity.md:17 | Replace with rewritten hashes or tags |
| deps-ci-tests-docs-11 | No dependency vulnerability gate (npm audit: 10 advisories, 5 high) | .github/workflows/ci.yml:21 | cargo-deny and npm audit jobs; extend Dependabot to cargo and npm |
| deps-ci-tests-docs-12 | Privacy guard silently passes on fork PRs | .github/workflows/ci.yml:56 | Emit a visible warning or neutral status |
| deps-ci-tests-docs-13 | VOKKO_SECRETS_KEY missing from the self-hosting reference | docs/self-hosting.md:89 | Add a table row |
| deps-ci-tests-docs-14 | Prebuilt libwebrtc downloaded without integrity check | tools/stremio-bot/Cargo.toml:22 | Pin and verify SHA-256 in release builds |

## 7. Suite results

| Step | Baseline | Final |
|---|---|---|
| `cargo fmt --check` | pass | pass |
| clippy (server, protocol, engine, platform, cli; `-D warnings`) | pass | pass |
| Rust tests | fail: 808 passed, 4 failed, 2 ignored. 4 or 5 tests in `crates/server/tests/stremio.rs` timed out in `until()` (library write never seen) | pass on idle rerun: 822 passed, 0 failed across 64 binaries. A first run under parallel CPU load had the same 5 stremio timeouts |
| `cargo xtask layers` | pass | pass |
| `cargo xtask privacy` | pass | pass |
| UI build (`npm run build`) | pass (chunk-size warning) | pass (chunk-size warning) |
| vitest | pass: 225 files, 2100 tests | pass: 228 files, 2115 tests |
| Playwright e2e | fail: 812 passed, 3 failed, 70 skipped | fail: 813 passed, 2 failed, 70 skipped (both failures also fail on `main`, see below) |
| Tauri crate build | pass | pass |

e2e detail:
- **Pre-existing, still failing:** `e2e/apply-to-join.spec.ts:124` ("keeps the apply form open") times out waiting for the Add a Server button. It reproduces when run alone.
- **Baseline only, passing on final:** `e2e/messages.spec.ts:129` (toolbar after wheel scroll) and `e2e/block-confirm.spec.ts:118` (older page with folded runs; offset 64). The baseline e2e partly overlapped a cargo test run, so these may have been load-induced.
- **Load flake, not a regression:** `e2e/block-confirm.spec.ts:156` ("Show and Hide on a run of three or more keep the fold row where it is") failed in the final full run. A follow-up compared `main` and this branch in the same fresh worktree: 5/5 and 16/16 passes on both at 1 and 8 workers, and 2/48 failures on both at 16 workers, with the same timeout in `rowTop()`. The test relies on fixed waits and pixel positions in the virtualized list. Note: a Playwright baseline in a worktree needs its own `npm ci`; a junctioned `node_modules` makes Vite refuse the font files and shifts the layout.
- **Stremio Rust tests:** they fail under CPU load on both baseline and final and pass on an idle machine. Fix fc45d13c changed the same code path, and its idle run is green. The 30 s `common::WAIT` appears to be too tight under load.

## 8. Recommended next steps

1. **Done** (c02748e8, section 9). **Settle line endings.** Add a `.gitattributes` (for example `* text=auto eol=lf`) and normalize in one dedicated commit, so editors and agents stop flipping files.
2. **Done**: exemption kept and documented (section 9). **Decide on interaction gating** (section 4, follow-up row): keep the documented exemption or gate slash commands like sends.
3. **Done** (section 9). **Fix the open availability findings:** server-auth-accounts-2 (bounded argon2 queue) and server-auth-accounts-3 (verification mail cooldown). Both are small and directly abusable on open-registration instances.
4. **Done** (section 9). **Fix server-guild-permissions-1** (AutoMod bypass through forwards) and voice-livekit-games-1 (reconnect drops voice state).
5. **Partly done**: three decided and fixed, client-ui-rendering-perf-4 still open (section 9). **Make the product decisions** on gateway-realtime-6 (session cap), storage-sql-migrations-4 (offsite backup deletion), tauri-host-2 (.deb updates) and client-ui-rendering-perf-4 (embed video proxying).
6. **Partly done**: mock, audit job (advisory) and CI coverage landed; adding the privacy job to required checks is a repository setting, still open (section 9). **Close test and CI gaps.** Mirror the new password lockout and slash-command rules in the desktop mock. Add the CI `privacy` job to required checks. Add dependency audit jobs (deps-ci-tests-docs-11) and CI coverage for tools and the Tauri crate (deps-ci-tests-docs-3).
7. **Done** (section 9). **Verify on Unix:** compile and smoke-test the SIGTERM handling (2f7b7824) and the native-voice output switch (751549fb) on Linux, ideally with `docker compose stop` timing and the `live_room` harness.
8. **Done**, stremio root cause was a clock mismatch, not WAIT; other flaky e2e tests remain (section 9). **Deflake** `e2e/apply-to-join.spec.ts:124` and `e2e/block-confirm.spec.ts:156` and raise or scale `common::WAIT` for the stremio tests.
9. **Partly done**: 38 fixed, 3 refuted, 8 left (section 9). **Work through the section 6 list.** Cheap docs fixes first (voice-livekit-games-3, deps-ci-tests-docs-7, -13, deploy-config-secrets-7), then server-auth-accounts-6 and uploads-outbound-ssrf-6.

## 9. Follow-up round

Branch `audit-followups` (on top of `main`, which holds the first round): every commit is listed by `git log --oneline main..HEAD`. One sets line endings (c02748e8, `.gitattributes` keeps text files LF); the rest fix the items below, one commit per item plus review follow-ups. Nothing was reverted.

### Owner decisions

- **Interactions** keep their documented exemption from the rules gate, verification level, slowmode and AutoMod (section 4, follow-up row). docs/api.md now says so precisely.
- **Gateway sessions** are capped at 16 per user (64 per bot); a detached session goes first, otherwise the oldest live one is closed with 4000.
- **Offsite backups** keep `rsync --delete`, behind a guard that refuses to sync when local sets look lost.
- **.deb installs** skip the in-app updater and tell the user to update through the package manager.
- **Not decided, still open:** embed video proxying (client-ui-rendering-perf-4) and the popup budget (tauri-host-5).

### Fixed

"API" = public behavior or API change; "Docs" = docs updated in the same commits. Shas checked against `git log main..HEAD`.

| Id | Title | Commits | API | Docs |
|---|---|---|---|---|
| server-auth-accounts-2 | Unbounded argon2 semaphore queue (now a 2 s wait, then 429 busy with Retry-After; hashing before side effects) | 7b26740d, b3da6ab8 | | |
| server-auth-accounts-3 | No per-account cooldown on verification mail (now 60 s, 429 with Retry-After; check and new link in one transaction under the user row lock, also for password reset) | b8836742, 88c716ce | yes | yes |
| server-guild-permissions-1 | Forwards bypass AutoMod keyword, regex and spam rules (files are copied only after every gate passed; a dropped request removes its copies unless the forward committed) | 48c1f3cb, 6ad5ffe1, 9b032200, b8c5d7ac | yes | yes |
| voice-livekit-games-1 | `participant_left` for a superseded participant removes the live voice state | 111a3974 | | yes |
| gateway-realtime-6 | No cap on concurrent gateway sessions per user | 6a6e9214 | yes | yes |
| storage-sql-migrations-4 | Offsite `rsync --delete` mirrors a local loss and wipes offsite history | 2ac56a67 | yes | yes |
| tauri-host-2 | .deb installs cannot auto-update | 4d4454c9 | yes | yes |
| (follow-up) interactions | docs/api.md: interactions skip the rules gate, verification level, slowmode and AutoMod | 1d404f0d | | yes |
| mock parity | Desktop mock mirrors the password lockout and the slash-command channel rules | 98626bbc | | |
| deps-ci-tests-docs-11, deps-ci-tests-docs-3 | No dependency audit gate; CI skipped tools, the Tauri crate, xtask, integrations and echo-bot (the audit and media-bots jobs are advisory) | c0b6f912, cd957cf8, 1ce087b7 | | yes |
| deflake | `e2e/apply-to-join.spec.ts:124` (test bug), `e2e/block-confirm.spec.ts:156` (load flake), stremio tests (database vs server clock in `linked_at`, not `common::WAIT`) | d4cbe6c8, e3999db0, c0406fcd | | |
| server-guild-permissions-2 | create_channel accepts a parent category the creator cannot view | f87d3b8f | yes | |
| server-guild-permissions-4 | Role reorder and delete not transactional | cbba04d7 | | |
| uploads-outbound-ssrf-5 | Sticker cap checked without a lock | a33ff2a7 | | |
| uploads-outbound-ssrf-6 | SSRF guard misses 64:ff9b:1::/48 and ::ffff:0:0/96 | 67268ec7 | | yes |
| voice-livekit-games-2 | room_finished ignores which room instance finished | 078558e6 | | yes |
| voice-livekit-games-3 | docs/api.md says 15 s DM call connect timeout (code: 30 s) | d2479dc5 | | yes |
| voice-livekit-games-4 | release_channel runs a stage-end query on every leave | 3c9a6d0d | | |
| voice-livekit-games-5 | Stage stays live when the last moderator loses permissions | 4ca30f33 | | yes |
| client-api-types-2 | GUILD_MEMBER_UPDATE keeps stale mute/deaf/flags | c98efae7 | | |
| client-api-types-3 | Client moderation checks differ from server (timeout clamp, role tie-break) | 2cc66443 | | |
| apps-bots-integrations-4 | echo-bot entry check never matches on Windows | a7814c53 | | |
| apps-bots-integrations-6 | Autocomplete choices validated only by count | bba6b6b9 | yes | yes |
| server-messages-threads-3 | Rejected send still starts slowmode (a send that fails after its message was stored keeps the slot) | 9b5a06bd, 097536c4 | | |
| server-messages-threads-6 | Poll answer custom emoji only shape-checked | 42892c41 | yes | yes |
| tauri-host-6 | Upload Preview does nothing in the desktop app (now web-only) | 38361418 | | |
| tauri-host-7 | Prefs, window state and crash marker written non-atomically | 8158a5bd | | |
| tauri-host-9 | Stale app_dirs and unsafe_code comments | 31046905 | | yes |
| deploy-config-secrets-4 | .dockerignore omits `.private/` and other ignored local files | 4becc266 | | |
| deploy-config-secrets-6 | Privacy guard skips binary files (now scans binaries and file names; a file-name hit prints its position, not the path) | bf0b42af, ccc4630f | | yes |
| deploy-config-secrets-7 | self-hosting-free.md misstates S3 disk use and voice timeout | 0204d8d4 | | yes |
| client-ui-rendering-perf-6 | inviteCache caches failures forever (now only a 404) | dc12abaf | | |
| client-ui-rendering-perf-7 | Screen-reader announcement reads spoilers | c0ed1300 | | |
| storage-sql-migrations-3 | Backups include the embed-media cache | c84ca662 | | yes |
| storage-sql-migrations-6 | restore.sh URL mode drops the DB under a running server (documented) | df1b83c7 | | yes |
| storage-sql-migrations-8 | S3 copy fallback buffers the whole object (now spooled to a temp file) | 70691cfe | | |
| storage-sql-migrations-10 | backup.sh passes the DB URL with password on the command line (documented: use a passfile or PGPASSWORD) | f494d942 | | yes |
| server-auth-accounts-5 | Email validation accepts display-name forms | 25e3d9d4 | yes | |
| server-auth-accounts-6 | Password reset does not invalidate MFA login tickets | 84121913 | | |
| server-auth-accounts-7 | MFA lockout 429 has no Retry-After (also the password lockout) | 7762d98e | yes | yes |
| gateway-realtime-8 | Duplicate socket when `online` fires during backoff | aed5562f | | |
| gateway-realtime-9 | Client RESUME_WINDOW check is dead code; server ignores session_ttl on resume | 0dcfd5d2 | yes | yes |
| gateway-realtime-10 | Handshake timeout during send_active leaves an orphan session | 1b8d713a | | |
| deps-ci-tests-docs-7 | api.md says embed-media proxy has no cache | c5c2d14f | | yes |
| deps-ci-tests-docs-8 | Dockerfile HEALTHCHECK only TCP-connects | 7b8900ee | | yes |
| deps-ci-tests-docs-9 | Stale pnpm-lock.yaml tracked beside package-lock.json | 25d5153d | | |
| deps-ci-tests-docs-10 | Docs cite commit hashes absent from public history | fbd85788 | | yes |
| deps-ci-tests-docs-13 | VOKKO_SECRETS_KEY missing from the self-hosting reference | 17261810 | | yes |
| CI: tauri job | Failed on main: native voice's alsa-sys and webrtc-sys need libasound2-dev and clang 21 (now from apt.llvm.org, key pinned by fingerprint), plus libdbus-1-dev | 32809b09 | | |
| CI: e2e job | Cancelled on main: the single-worker suite (about 31 min) exceeded the 30 min timeout; now four shards of 20 min. Check names become `e2e (1)` to `e2e (4)` | 32144b58 | | |
| advisories | rustls 0.23.45 to 0.23.46 (RUSTSEC-2026-0346 to -0349) | 9879b88a | | |

Scope limits the fixers noted:
- **server-auth-accounts-2:** no regression test for the reset/edit ordering (holding all 4 hash slots would starve parallel tests); the `hash_slot` unit test covers the 429.
- **server-auth-accounts-3:** only the resend route is limited; the email-change mail (which needs the current password) is not, and there is no daily cap.
- **server-guild-permissions-1:** `forward::prepare` now runs first, so a forward of an unreadable source gets 404 10008 before the 150010, 50009, AutoMod and slowmode checks.
- **voice-livekit-games-1:** an out-of-order join webhook can record the older sid again; reconciliation does not record sids.
- **server-guild-permissions-4:** no new test; re-validation against the locked state is server-guild-permissions-3.
- **client-ui-rendering-perf-6:** successful invite lookups are still cached forever.
- **deps-ci-tests-docs-9:** no `packageManager` field (Corepack would pin one npm version for everyone).

### Not fixed or reverted

None. Every item handed to a fixer landed. Three (server-auth-accounts-2, server-guild-permissions-1, deploy-config-secrets-6) needed a second commit after review, and a security review of the branch found three regressions that 88c716ce, 9b032200 and 097536c4 fix: the cooldown check and the new link were not atomic (two concurrent resends both mailed), a forward copied files before the rules, verification and slowmode gates, and the slowmode slot was given back even when the insert had committed. Its review of those fixes closed two cancellation holes in the forward copy guard (b8c5d7ac).

### Low findings refuted in triage

| Id | Reason |
|---|---|
| client-api-types-4 | The only caller passing a signal (`apps/desktop/src/chat/draftStore.ts`) creates the AbortController in the same synchronous step as the upload, so the signal cannot be aborted before send; no caller is affected by the 429 part either. |
| tauri-host-8 | The code is as described, but it runs only on the owner's single-user release machines; no other local user or untrusted code can reach the fixed path or the exported key. |
| storage-sql-migrations-9 | Needs the wall clock to step back by more than the server's downtime between the last issued id and the restart; not a realistic failure. |

### Unix verification

Both confirmed, on a macOS machine and a Linux arm64 container on it.
- **SIGTERM (2f7b7824):** natively, the server exits 0 within milliseconds on SIGTERM and SIGINT (the previous build died from SIGTERM, status 143). In Docker, `docker stop` now takes 0.14 s with exit code 0; the previous build ignored SIGTERM as PID 1 and was killed after the 10 s grace period (137).
- **Native voice output switch (751549fb):** `cargo test -p vokko-desktop` passes on Linux (75 passed, 2 ignored), and the `live_room` harness against a local LiveKit server passed three runs that switch the output device (to missing devices, while muted, back to default). The server always saw one microphone publication, none while muted, never two. Real macOS devices were not tested: the module is Linux only.

### Suite results (follow-up branch, Windows)

| Step | Result |
|---|---|
| `cargo fmt --check` | pass |
| clippy (server, protocol, engine, platform, cli; `-D warnings`) | pass |
| Rust tests (same crates, test database) | pass: 64 binaries, 845 passed, 0 failed, 2 ignored |
| `cargo xtask layers` | pass |
| `cargo xtask privacy` | pass (18 patterns, contents and file names) |
| UI build (`npm run build`) | pass |
| vitest | pass: 231 files, 2122 tests |
| Playwright e2e (four shards, as CI now runs it) | pass: 815 passed, 0 failed, 70 skipped; shards took 6.4, 8.3, 7.8 and 7.5 min. An earlier single 31.5 min run had one timeout in `e2e/voice-ui.spec.ts:172` that passed alone |
| Tauri crate build | pass |
| clippy and tests: xtask, vokko-loadtest | pass (16 tests) |
| `cargo test -p vokko-desktop` | pass (68 tests) |
| clippy: spotify-bot, stremio-bot | pass |
| tests: spotify-bot, stremio-bot | spotify-bot pass (3); stremio-bot does not link on Windows (LNK2038, C runtime mismatch in livekit's prebuilt libwebrtc). CI runs this job on Linux, advisory |
| echo-bot `npm test` | pass (4) |
| integrations/ai-bridge (bun install, typecheck, test) | pass (123) |
| integrations/claude-channel (bun install, typecheck, test) | pass (61, 4 skipped; typecheck rerun after the last fixes) |
| `cargo audit` (advisory job) | fail: 15 vulnerabilities after 9879b88a (was 19). Left: rustls 0.22 / rustls-webpki 0.102 / quick-xml 0.38 via the librespot fork (spotify-bot only), rsa (no fix; the server only verifies RS256), zip via tauri-plugin-updater (fix only in 3.0 alpha; updates are signature-checked first) and webrtc-sys-build (build time) |
| `npm audit --omit=dev --audit-level=high` (advisory job) | fail: 10 (5 high, from boardgame.io's server-side koa/socket.io/ws dependencies; the only fix is a breaking downgrade) |

The Ubuntu-only CI setup (apt webkit/glib, `npx playwright install --with-deps`) and the CI privacy secret could not be reproduced here.

### Still open

- **Section 4:** gateway-realtime-4 (events lost while READY builds), storage-sql-migrations-2 (mentions index and query), and the undecided client-ui-rendering-perf-4 and tauri-host-5.
- **Section 6, left by class:** risky: server-guild-permissions-3, storage-sql-migrations-7. Product decision: apps-bots-integrations-5, server-messages-threads-4, server-messages-threads-5, server-auth-accounts-8, deps-ci-tests-docs-12, deps-ci-tests-docs-14.
- **Repository settings:** add the `privacy` job and the new blocking jobs to required checks if branch protection lists them.
- **Advisories:** the cargo and npm audit findings above (the spotify-bot ones need the librespot fork updated); the media-bots, tauri and sharded e2e jobs have not run on CI yet.
- **Flaky e2e:** `e2e/block-confirm.spec.ts:139` ("an older page that holds folded runs does not move the list"; about 6/48 at 16 workers on the original code too, likely an app bug in folded-row handling) and `e2e/voice-ui.spec.ts:172`.
