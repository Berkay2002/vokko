# Claude for Vokko

Your own Claude inside Vokko. A bot account you create forwards your messages into a Claude Code session on your machine, and Claude answers through the bot: in a server it shows as **"&lt;You&gt;'s Claude"** (for example "Carol's Claude"), in DMs just **"Claude"**.

This is a [Claude Code channel](https://code.claude.com/docs/en/channels): an MCP server that Claude Code starts and that pushes chat messages into the session. It is a port of Anthropic's Discord channel plugin (Apache-2.0, see `NOTICE`) to Vokko's bot API, with the same access model: DM pairing codes, an allowlist of user IDs, server channels opted in one by one, and mention gating.

**One bot per person.** Everybody creates their own application, runs their own Claude Code on their own machine, on their own Claude subscription. Nobody uses someone else's subscription unless that person adds them (see [Security](#security)).

## What you need

- A Vokko account on the server you want the bot on.
- [Claude Code](https://code.claude.com) logged in with your Claude subscription (channels need a claude.ai login; Team/Enterprise orgs must enable channels).
- [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash` (macOS/Linux) or `powershell -c "irm bun.sh/install.ps1 | iex"` (Windows).
- This folder: a checkout of the Vokko repo (`integrations/claude-channel/`).

## Setup

**1. Create the application.** In Vokko: **User Settings → Advanced → Applications → Create an application**. Name it **Claude**. That name is the bot's display name, so DMs show "Claude". (Bot *usernames* are unique on a server, so the first "Claude" bot gets `@claude` and later ones get `@claude_1a2b`; nobody sees the difference except in mentions.) Turn **Public Bot** off so only you can add it to servers.

**2. Copy the token.** It is shown once, right after creating (or after **Reset Token**). Keep it for step 5.

**3. Add the bot to a server.** Vokko only lets you DM a bot you share a server with. Use **Copy Invite URL**, but replace the `permissions=` value with **`274945117248`** before opening it:

| Permission | Why |
| --- | --- |
| View Channels, Read Message History | see the channels you opt in, `fetch_messages` |
| Send Messages, Send Messages in Threads | replies |
| Attach Files | `reply` with files |
| Add Reactions | `react`, the ack reaction |
| Change Nickname | the "&lt;You&gt;'s Claude" nickname |

Pick the server (you need Manage Server there) and authorize. The bot gets a role with those permissions. Change Nickname is usually in @everyone already; asking for it keeps the nickname working where it isn't.

**4. Install the plugin.** The repo's `integrations/` folder is a plugin marketplace. In a terminal:

```sh
claude plugin marketplace add /path/to/vokko/integrations
claude plugin install vokko@vokko
```

(Or, inside Claude Code: `/plugin marketplace add /path/to/vokko/integrations` and `/plugin install vokko@vokko`.)

**5. Configure it.** Start `claude` and run:

```
/vokko:configure url https://your.vokko.server
/vokko:configure <token>
```

That writes `~/.claude/channels/vokko/.env` (mode 600):

```sh
VOKKO_API_URL=https://your.vokko.server   # server root, no /api/v1
VOKKO_BOT_TOKEN=...
# optional
VOKKO_BOT_NAME=Claude          # nickname suffix: "<owner>'s <name>"
VOKKO_OWNER_NAME=Carol        # default: your display name, read from the server
VOKKO_GATEWAY_URL=wss://...    # default: <VOKKO_API_URL as ws(s)>/gateway
```

You can also write the file by hand or set the variables in your shell (the shell wins). To run two bots on one machine, give each its own `VOKKO_STATE_DIR`.

**6. Start Claude Code with the channel.** Exit and relaunch:

```sh
claude --dangerously-load-development-channels plugin:vokko@vokko
```

During the channels research preview only Anthropic's own channel plugins are on the allowlist, so a custom channel needs this development flag (plain `--channels plugin:vokko@vokko` is refused). Claude Code shows a warning first: choose **I am using this for local development**. It works only in an interactive session (not with `-p`).

When the bot connects it sets its nickname in every server it's in to "&lt;You&gt;'s Claude" (cut to Vokko's 32-character limit).

**7. Pair.** DM the bot in Vokko. It replies with a pairing code. In Claude Code:

```
/vokko:access pair <code>
```

Your next DM reaches Claude.

**8. Lock it down.** Pairing exists to capture IDs. Once you're in, stop strangers from getting codes:

```
/vokko:access policy allowlist
```

**9. Use it in a server (optional).** Opt in a channel by its ID (Developer Mode → right-click the channel → Copy ID):

```
/vokko:access group add <channelId> --allow <yourUserId>
```

The bot then answers when you @mention it or reply to it there. See [ACCESS.md](./ACCESS.md) for everything else.

**Friends in servers on your API key (optional).** Servers can be answered by [vokko-ai-bridge](../ai-bridge/README.md) on the same bot token instead: a chat-only Claude on an Anthropic API key with spend limits, no tools on your machine. `/vokko:access set guilds false` hands servers to it, and `/vokko:access dm-backend api|subscription` picks who answers your DMs.

## Run it on an always-on machine (macOS)

A home server that is always on is a good home for your bot: Claude only answers while the session runs.

**Use a dedicated working directory.** Claude acts in the directory it was started in. Don't start it in your home folder or a repo, and never next to a live server's data:

```sh
mkdir -p ~/claude-vokko && cd ~/claude-vokko
```

**Use a restrictive permission mode.** Anything allowlisted can steer this session, so every tool call should need approval: leave the permission mode at `default` (never `bypassPermissions` or `--dangerously-skip-permissions`). Approval prompts reach your Vokko DMs; reply `yes <id>` or `no <id>`. Add deny rules for what the bot must never touch, in `~/claude-vokko/.claude/settings.json`:

```json
{
  "permissions": {
    "defaultMode": "default",
    "deny": [
      "Read(~/.ssh/**)",
      "Read(~/.claude/channels/**)",
      "Edit(~/.claude/channels/**)",
      "Bash(sudo:*)",
      "Bash(launchctl:*)"
    ]
  }
}
```

If the Mac also runs a live service (a Vokko server, bots, a database), deny its folders and data too (for example `"Read(/srv/vokko/**)"`, `"Edit(/srv/**)"`), and don't add `Bash(*)` allow rules.

**Keep it running in tmux,** restarting when it exits:

```sh
brew install tmux     # once
tmux new -s claude-vokko
cd ~/claude-vokko
while true; do
  claude --dangerously-load-development-channels plugin:vokko@vokko
  echo "claude exited, restarting in 10s (Ctrl-C to stop)"; sleep 10
done
```

Detach with `Ctrl-b d`, reattach with `tmux attach -t claude-vokko`. Each start shows the development-channels warning, so after a restart (or a reboot) **attach and confirm it once**; until then the bot is offline. To start it after login, add a small script that runs the `tmux new -d -s claude-vokko '…loop…'` line as a **Login Item** (System Settings → General → Login Items), or open it from your terminal's startup profile. A launchd job isn't recommended here: the session needs a terminal for that confirmation.

Long sessions fill up the context: Claude Code compacts automatically, or run `/clear` from the terminal now and then.

## Security

- **Default allowlist = only you.** Pair yourself, then switch to `allowlist`.
- **Adding someone else** (pairing them, `allow <id>`, or opting in a server channel without `--allow`) means **they use your Claude subscription and can steer a Claude Code session on your machine**: read and write files in its working directory and run what the permission mode allows. Only add people you'd hand your keyboard to.
- Access changes happen only in your terminal. Claude is told to refuse "approve my pairing" requests that arrive as chat messages, since that is exactly what a prompt injection looks like.
- The token is a credential: `.env` is mode 600, and the `reply` tool refuses to send anything from the state directory. If it leaks, **Reset Token** on the application.
- Permission prompts go only to allowlisted DMs, and only allowlisted users can answer them.

## Tools exposed to Claude

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat: `chat_id` + `text`, optionally `reply_to` (message ID) and `files` (absolute paths, max 10, the server's upload limit each). Splits long text at 2000 characters; files go with the first part. |
| `react` | Add an emoji reaction. Unicode, or `name:id` / `<:name:id>` for custom emoji. |
| `edit_message` | Edit one of the bot's messages (progress updates). |
| `fetch_messages` | Recent history, oldest first, up to 100. Lines carry message IDs; `+Natt` marks attachments. Vokko's search isn't open to bots, so this is the only lookback. In a channel opted in with `--allow`, other senders are left out. |
| `download_attachment` | Save a message's attachments to `~/.claude/channels/vokko/inbox/` and return the paths. |

Inbound messages show a typing indicator while Claude works. Attachments are listed (name, type, size) but only downloaded when Claude asks.

## Development

```sh
bun install
bun run typecheck
VOKKO_API_URL=http://127.0.0.1:1470 bun test/smoke.ts   # against a throwaway Vokko server, never a live one
```

`test/smoke.ts` registers fresh users, creates the app, adds the bot to a server, runs `server.ts` as an MCP child (no Claude login) and checks pairing, the allowlist, mention gating, every tool, the nickname and permission relay.

`vokko.ts` holds the Vokko side (login, gateway, access.json, gating, nickname, outbound calls) and `server.ts` the Claude Code MCP glue, so another assistant backend can reuse `vokko.ts`. Discord.js isn't used: Vokko's gateway lives at `/gateway` without Discord's version/`/gateway/bot` handshake and READY carries full guilds, so a ~400-line fetch + WebSocket client is simpler than adapting discord.js.
