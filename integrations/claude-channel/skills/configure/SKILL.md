---
name: configure
description: Set up the Vokko channel — save the bot token and server URL, and review access policy. Use when the user pastes a Vokko bot token, asks to configure Vokko, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /vokko:configure — Vokko Channel Setup

Writes settings to `~/.claude/channels/vokko/.env` and orients the user on
access policy. The server reads both files at boot.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Settings** — check `~/.claude/channels/vokko/.env` for
   `VOKKO_API_URL` (show it), `VOKKO_BOT_TOKEN` (set/not-set; if set, show
   the first 6 chars masked), and the optional `VOKKO_BOT_NAME` and
   `VOKKO_OWNER_NAME`.

2. **Access** — read `~/.claude/channels/vokko/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count, and list display names or IDs
   - Pending pairings: count, with codes if any
   - Guild channels opted in: count

3. **What next** — end with a concrete next step based on state:
   - No URL → *"Run `/vokko:configure url https://your.vokko.server`."*
   - No token → *"Run `/vokko:configure <token>` with your bot token from
     User Settings → Advanced → Applications → Reset Token."*
   - Token set, policy is pairing, nobody allowed → *"DM your bot on
     Vokko. It replies with a code; approve with `/vokko:access pair
     <code>`."*
   - Token set, someone allowed → *"Ready. DM your bot to reach the
     assistant."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list, and by default that list is only the owner. `pairing`
is a temporary way to capture IDs you don't know.

1. Read the allowlist. Tell the user who's in it.
2. Ask: *"Is that everyone who should reach you through this bot?"* Remind
   them that anyone else on the list steers this Claude Code session on this
   machine, on their Claude subscription.
3. **If yes and policy is still `pairing`** → offer to run
   `/vokko:access policy allowlist`. Do this proactively.
4. **If people are missing** → *"Have them DM the bot; you'll approve each
   with `/vokko:access pair <code>`."* Or with Developer Mode on (User
   Settings → Advanced), right-click them → Copy ID, then
   `/vokko:access allow <id>`.
5. **If the allowlist is empty** → *"DM your bot to capture your own ID
   first."*
6. **If policy is already `allowlist`** → confirm this is the locked state.

### `<token>` — save the token

1. Treat `$ARGUMENTS` as the token (trim whitespace).
2. `mkdir -p ~/.claude/channels/vokko`
3. Read existing `.env` if present; update/add the `VOKKO_BOT_TOKEN=` line,
   preserve other keys. Write back, no quotes around the value.
4. `chmod 600 ~/.claude/channels/vokko/.env` — the token is a credential.
5. Confirm, then show the no-args status.

### `url <url>` — save the server URL

The server root the Vokko app talks to (e.g. `https://vokko.example.com`,
no `/api/v1`). Update/add `VOKKO_API_URL=` the same way.

### `name <name>` / `owner <name>`

Update/add `VOKKO_BOT_NAME=` (default "Claude"; guild nickname is
"<owner>'s <name>") or `VOKKO_OWNER_NAME=` (default: the application
owner's display name, read from the server).

### `clear` — remove the token

Delete the `VOKKO_BOT_TOKEN=` line (or the file if that's the only line).

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- The server reads `.env` once at boot. Changes need a session restart or
  `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/vokko:access` take effect immediately, no restart.
