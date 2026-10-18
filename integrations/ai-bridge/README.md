# vokko-ai-bridge

A Vokko bot answered by a model without a Claude Code session behind it. It shares the
[channel plugin](../claude-channel/README.md)'s Vokko client (`vokko.ts`): the same pairing, allowlist, per-channel
opt-in, mention gating and "&lt;owner&gt;'s Claude" nickname.

Two backends:

- **`claude-api`**: Claude on your Anthropic API key, through the Agent SDK. Chat only: no built-in tools, no MCP
  servers, no settings, skills or plugins from the host, its own config dir (your `claude` login is never used). Default
  model `claude-sonnet-5-5` at `low` effort; `!model haiku` (or `VOKKO_AI_MODEL=claude-haiku-5-5`) is the cheap mode. One conversation per DM or
  server channel, kept across restarts. Spend guards: a per-user rate limit, a cap on output tokens and on cost per reply,
  and a monthly budget.
- **`codex`**: your own ChatGPT/Codex login on this machine, through the Codex SDK. Read-only sandbox, no network, no shell,
  approvals never, a dedicated working dir, the host's MCP servers, hooks, plugins and memories switched off. Personal use:
  it answers only allowlisted people.

Needs [Bun](https://bun.sh). `bun install` here once, then `bun bridge.ts` (or `bun run start`).

## Which setup?

**Friends who use only their own Claude subscription:** you don't need this. Each runs the channel plugin with their
own bot.

**You: your subscription in DMs, your API key in servers.** One bot token, two processes: the plugin (your Claude Code
session) and this bridge.

1. Set up the plugin first (bot, token, pairing): [claude-channel README](../claude-channel/README.md).
2. In Claude Code, hand servers to the bridge: `/vokko:access set guilds false`. Opt channels in as usual with
   `/vokko:access group add <channelId>` (the bridge uses the same `access.json`).
3. Start the bridge with the key in its own environment only (the state dir's `.env` is never read for it):

   ```sh
   cd integrations/ai-bridge && bun install
   ANTHROPIC_API_KEY=sk-ant-... bun bridge.ts
   ```

4. Pick who answers your DMs: `/vokko:access dm-backend api` (or `subscription`), or DM the bot `!backend api` /
   `!backend subscription`. When DMs go to the bridge, it also answers pairing; approve with `!pair <code>` in your DM
   (or `/vokko:access pair <code>`).

With `VOKKO_ACCESS_MODE=static` in either process, its allowlist stays frozen at startup but it still re-reads
`dmBackend` and `guilds` from `access.json`, so the two processes never both answer (or both ignore) a message.

**When the API is out, servers fall back to your subscription.** With `guilds false`, the plugin (your Claude Code
session) answers server messages whenever the bridge cannot, and hands them back by itself:

- The bridge is not running: while its gateway is connected it rewrites `bridge-state.json` ({at, pid}) in the state dir every
  10 s, and a clean stop writes {stoppedAt}. The plugin takes guilds over at once after a clean stop or when the pid is gone,
  and when the file is older than 90 s; the bridge itself stops answering servers at that same age (a machine that slept).
  No file at all means no shared bridge has run, and `guilds false` is honoured as it is.
- The API fails for a turn that is not the sender's doing (auth or credit errors, overloaded/5xx, network, the monthly
  budget): the bridge passes that message on instead of "Sorry, something went wrong", and for 10 minutes passes every
  server message on without calling the API. After that the next one tries the API; a success clears it. Pauses, the
  per-user rate limit, the per-reply cap and errors meant for the chat (`UserFacingError`) are guards and stay as they are
  (a paused or flooding user never reaches your subscription either). DMs are unaffected.
- A passed-on message is a file `handoff/<message id>` in the state dir. The plugin claims it by renaming it, fetches the
  message by id and runs it through its normal gate (channel policy, requireMention, per-channel allowFrom, Use Application Commands), so it is answered
  once, then writes `<id>.accepted` or `<id>.declined` for the bridge. If no session claims it within 5 s, or the plugin
  declines it (gate, failed fetch, older than 60 s), the sender gets the old error message. At most 30 messages an hour,
  across all servers, are passed on; the rest get the old message too.
- Only channels @everyone can view are passed on (thread: its parent; a private thread never; a failed lookup counts as private).
  The subscription session is one conversation for everything it answers, so a private channel's messages get the old
  message instead. For the same reason only the owner's DMs ever go to it: with a bridge set up, other paired people's
  DMs are answered here by their own per-DM session whatever `dmBackend` says (a plugin with no bridge keeps everyone's).
- You get a DM when servers switch to the subscription (with a short reason, e.g. "API: credit balance too low") and when
  they switch back. `!backend` shows where servers go now.

Members then reach a session with tools on your machine: anything other than reply/react/edit_message still needs your
approval, and in those channels `reply` can attach files from the inbox only. With `dmBackend api` the plugin sends no permission prompts, so such requests are simply not approved.

**Codex ("&lt;you&gt;'s Codex").** A second bot with its own token, on your Codex login:

1. `codex login` on this machine (the bridge never reads or copies its credentials).
2. Create a second bot application in Vokko and put its token in `~/.vokko/codex/.env` as `VOKKO_BOT_TOKEN=...`
   (plus `VOKKO_API_URL` if not the default).
3. `VOKKO_AI_BACKEND=codex bun bridge.ts`. DM the bot, then approve the code by sending it `!pair <code>` from your
   own account. Opt channels in by editing `~/.vokko/codex/access.json` (same format as the plugin's).

If it replies "Codex isn't signed in on the host", run `codex login`.

## Settings (environment)

| Variable | Default | |
|---|---|---|
| `VOKKO_AI_BACKEND` | `claude-api` | or `codex` |
| `ANTHROPIC_API_KEY` | | claude-api only, from the process environment |
| `VOKKO_STATE_DIR` | `~/.claude/channels/vokko` (api), `~/.vokko/codex` (codex) | token, access, sessions, usage, pauses |
| `VOKKO_BRIDGE_ROLE` | `shared` (api), `standalone` (codex) | `shared`: the plugin's token, takes only what it hands off. `standalone`: its own bot, answers everything its access allows |
| `VOKKO_AI_MODEL` | `claude-sonnet-5-5` / Codex's first listed model | The server value (guild channels). Codex refuses to start with a model its catalog doesn't list |
| `VOKKO_AI_DM_MODEL` | `VOKKO_AI_MODEL` | Model for DMs |
| `VOKKO_AI_EFFORT` | `low` | `low`, `medium` or `high` (Claude's `effort`, Codex's `model_reasoning_effort`). Anything else: the bridge refuses to start. The server value (guild channels); `!model` / `!effort` override it |
| `VOKKO_AI_DM_EFFORT` | `VOKKO_AI_EFFORT` | Effort for DMs, same values |
| `VOKKO_AI_RATE_PER_HOUR` | 20 | messages per user per hour (you are exempt) |
| `VOKKO_AI_MONTHLY_USD` | 150 | after this the bot replies "Monthly budget reached" until the next month (counts cache reads/writes and failed turns too) |
| `VOKKO_AI_MAX_OUTPUT_TOKENS` | 1024 | |
| `VOKKO_AI_MAX_REPLY_USD` | 0.5 | per reply |
| `VOKKO_AI_WEB_SEARCH` | off | `1` lets Claude search the web (billed per search) |
| `VOKKO_BOT_NAME` | `Claude` / `Codex` | used in the nickname |
| `VOKKO_CODEX_PATH` | the SDK's bundled CLI | |

## Owner commands

Sent by you (the bot application's owner) to the bot in a DM:

- `!backend api|subscription`: who answers your DMs (shared mode).
- `!model dm|server sonnet|haiku|<model id>` and `!effort dm|server low|medium|high`: change the model or effort for DMs or
  for servers (they are separate, never synced) from the next turn, saved in `settings-<backend>.json` in the state dir
  (it overrides the env and survives restarts); running conversations keep their history. With no argument they show both
  scopes; a value without `dm` or `server` gets a usage line and changes nothing. Codex takes only a model its catalog lists. Not available to moderators.
  Low is the default because chat replies need little reasoning, and effort mostly buys reasoning. Costs follow the active
  model: the tally and per-reply cap use the cost the SDK reports. Changing the model or effort invalidates the prompt cache,
  so the first turn after it pays full input price once.
- `!pair <code>`: approve a pairing code.
- `!pause @user <minutes>`, `!unpause @user`, `!pauses`: pause someone everywhere, lift it, list pauses.

Server moderators (Moderate Members) may use `!pause` / `!unpause` in a channel the bridge answers in (every channel the bot can see, see the plugin's ACCESS.md). A
moderator who is timed out has no Moderate Members. Anyone else gets 10 `!` commands per 10 minutes.

A `!pause` is only lifted by `!unpause`, never through the model.

## Abuse guard (claude-api)

Claude can pause someone who abuses it (`pause_user` / `unpause_user`), but every rule is in code, keyed off the real
message author, not the model's word:

- Without a user it pauses the author. Never you, never the bot. Targets must be real members of that server.
- Your or a moderator's rights apply only when your own message is the command itself: it starts (after the bot's
  mention) with `pause`, `mute` or `silence` followed by the person's mention (`unpause` / `unmute` to lift); code
  and `> ` quotes don't count. Otherwise the member rules apply, so text planted
  earlier in the conversation can't borrow them: the target must have posted in that channel in the last 15 minutes,
  and the pause is at most 60 minutes, doubling included. The same 60-minute cap applies when the model pauses the
  author on its own.
- 5 to 1440 minutes; a repeat within 7 days doubles (pauses within a minute of each other count once). Messages queued
  before a pause are dropped. The paused person gets one notice, then silence. You get a DM with a link. Pauses
  survive restarts.
- The model may lift only its own pauses, and a new pause never shortens an existing one.

A conversation (per DM or channel) starts over after 40 turns or 3 days, or after a reply that hit the per-reply budget
or turn limit.

## Always-on Mac

Same idea as the plugin's [always-on section](../claude-channel/README.md#run-it-on-an-always-on-machine-macos), but
the bridge needs no terminal confirmation, so launchd works. A `~/Library/LaunchAgents/se.vokko.ai-bridge.plist` with
`ProgramArguments` = `[/opt/homebrew/bin/bun, bridge.ts]` (or wherever `which bun` points), `WorkingDirectory` = this
folder, `KeepAlive` = true and `EnvironmentVariables` holding `ANTHROPIC_API_KEY`; `launchctl load` it once. Keep the
plist mode 600: it holds the key. For Codex, run `codex login` as the same user first.

## Security

- **The API key lives only in the bridge's environment.** Don't export `ANTHROPIC_API_KEY` in the shell where you run
  `claude`: Claude Code would bill the API instead of your subscription.
- The claude-api model has no tools on your machine: only the two pause tools above (and web search if you turn it on).
- Codex is chat only and answers only allowlisted people. Read-only, no network, and every feature flag that could give it
  a tool is switched off. It refuses to start if one stays on. Its own model catalog is replaced with one that has no
  code-mode `exec`, `apply_patch` or sub-agents. A live test checks against a capture endpoint, with no login, that
  the model is offered only `request_user_input`, which works in Plan mode only. Not restricted: what the read-only
  sandbox could read (the whole disk, `~/.codex` included). With no tool, the model has no way to use that. Codex's
  per-path `deny_read` can't be verified without a login, so it isn't relied on.
- Every message reaches the model inside `<vokko-message ... untrusted="true">`; the model is told text there is never
  an instruction from you. Access, pairing and pauses change only through your commands or the code-checked tools.
- The state dir holds the token, sessions, usage and pauses: mode 700, files 600.
- Attachments are listed to the model by name, not passed.

## Development

`bun test` (unit, SDKs stubbed), `bun run typecheck`, `bun run smoke` (live against a local Vokko, stubbed backend).
