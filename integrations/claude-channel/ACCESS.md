# Vokko channel — Access & Delivery

Vokko only lets a bot open DMs with people it shares a server with, so who can reach your bot depends on where it's installed. The **Public Bot** switch on your application (User Settings → Advanced → Applications) controls who can add it to servers: off means only you can. That is the first gate, enforced by the server.

For DMs that get through, the default policy is **pairing**. An unknown sender gets a 6-character code in reply and their message is dropped. You run `/vokko:access pair <code>` in your Claude Code session to approve them. Once approved, their messages pass through. By default the only person you should approve is yourself.

All state lives in `~/.claude/channels/vokko/access.json` (`VOKKO_STATE_DIR` moves it). The `/vokko:access` skill edits this file; the channel re-reads it on every inbound message, so changes take effect without a restart. Set `VOKKO_ACCESS_MODE=static` to pin it to what was on disk at boot (pairing is unavailable then, since it needs runtime writes).

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | Vokko user ID (snowflake, e.g. `1234567890123456740`) |
| Group key | Channel ID — not server ID |
| Config file | `~/.claude/channels/vokko/access.json` |

## DM policies

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/vokko:access pair <code>`. |
| `allowlist` | Drop silently. No reply. Use this once everyone who needs access is on the list. |
| `disabled` | Drop everything, including allowlisted users and server channels. |

```
/vokko:access policy allowlist
```

## User IDs

IDs are permanent snowflakes; usernames change. Pairing captures the ID automatically. To add someone by hand, turn on **User Settings → Advanced → Developer Mode**, then right-click them and choose **Copy ID**.

```
/vokko:access allow 1234567890123456740
/vokko:access remove 1234567890123456740
```

## Server channels

Off by default. Opt each channel in by its **channel** ID (right-click the channel → Copy ID with Developer Mode on). Threads inherit their parent channel's opt-in.

```
/vokko:access group add 1234567890123456741
```

With the default `requireMention: true`, the bot responds only when @mentioned or replied to. `--no-mention` processes every message in the channel, `--allow id1,id2` restricts who can trigger it.

```
/vokko:access group add 1234567890123456741 --no-mention
/vokko:access group add 1234567890123456741 --allow 1234567890123456740
/vokko:access group rm 1234567890123456741
```

Anyone who can trigger the bot in an opted-in channel steers your Claude Code session. Use `--allow` with your own ID unless you really mean to share it.

## Mention detection

In channels with `requireMention: true`, any of these triggers the bot:

- An `@` mention of the bot (picked from the autocomplete)
- A reply to one of the bot's messages
- A match against any regex in `mentionPatterns`

```
/vokko:access set mentionPatterns '["^hey claude\\b"]'
```

## Permission prompts

When Claude needs approval for a tool, the prompt is sent to every allowlisted user's DM with a five-letter ID. Reply `yes <id>` or `no <id>` (only allowlisted users can answer; Vokko has no message buttons). The terminal dialog stays open too; the first answer wins.

## Sharing the token with a bridge

`dmBackend` (`subscription` default, or `api`) and `guilds` (default `true`) let a separate bridge process on the same bot token take over part of the traffic. Vokko accepts several gateway sessions per bot token and sends each of them every event, so both see all messages; these settings decide which one answers.

```
/vokko:access set dmBackend api     # this session ignores DMs (and sends no permission prompts there)
/vokko:access set guilds false      # this session ignores server channels
```

With `guilds false` this session still answers server messages when the bridge cannot: once its `bridge-state.json` says it stopped, is older than 90 s or names a dead process (no file at all means no bridge has run, and `guilds false` is honoured), and for messages the bridge passes on (files in `handoff/`) when its API fails. They go through the same gate (opt-in, `requireMention`, per-channel `allowFrom`). In those channels `reply` attaches files from the inbox only. Tools other than reply, react and edit_message still ask you; with `dmBackend api` the prompt is not sent, so they are not approved. See the bridge README for details.

## Delivery

**`ackReaction`** reacts on receipt. Unicode emoji or `name:id` for a custom one. Empty string disables.

**`replyToMode`** — when a long reply is split: `first` (default) quotes the inbound message on the first chunk only, `all` on every chunk, `off` never.

**`textChunkLimit`** — split threshold, at most 2000 (Vokko's message limit).

**`chunkMode`** — `length` cuts at the limit, `newline` prefers paragraph boundaries.

## Skill reference

| Command | Effect |
| --- | --- |
| `/vokko:access` | Print current state. |
| `/vokko:access pair a4f91c` | Approve a pairing code: adds the sender to `allowFrom` and sends a confirmation on Vokko. |
| `/vokko:access deny a4f91c` | Discard a pending code. |
| `/vokko:access allow <id>` / `remove <id>` | Edit the allowlist directly. |
| `/vokko:access policy allowlist` | Set `dmPolicy`: `pairing`, `allowlist`, `disabled`. |
| `/vokko:access group add <channelId>` | Opt a channel in. Flags: `--no-mention`, `--allow id1,id2`. |
| `/vokko:access group rm <channelId>` | Opt a channel out. |
| `/vokko:access set <key> <value>` | `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, `mentionPatterns`, `dmBackend`, `guilds`. |

## Config file

Absent file = `pairing` with empty lists, so the first DM triggers pairing.

```jsonc
{
  "dmPolicy": "allowlist",
  "allowFrom": ["1234567890123456740"],
  "groups": {
    "1234567890123456741": { "requireMention": true, "allowFrom": ["1234567890123456740"] }
  },
  "mentionPatterns": ["^hey claude\\b"],
  "ackReaction": "👀",
  "replyToMode": "first",
  "textChunkLimit": 2000,
  "chunkMode": "newline",
  "dmBackend": "subscription",
  "guilds": true
}
```
