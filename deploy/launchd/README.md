# launchd jobs (macOS hosts)

On a Mac host, the native pieces of a Vokko deployment run as per-user launchd agents. The repo ships no plists: write your
own from the example below, one file per job, in `~/Library/LaunchAgents/` (mode 600 when it holds a secret), then load it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.vokko.media-livekit.plist
launchctl kickstart -k gui/$(id -u)/org.vokko.media-livekit   # restart after editing it or its config
```

Use your own reverse-DNS labels (`org.vokko.*` below is an example) and absolute paths: launchd expands neither `~` nor
`$HOME`.

| Job | Program and arguments | Environment | Notes |
|---|---|---|---|
| `media-livekit` | `/opt/homebrew/bin/livekit-server --config <repo checkout>/deploy/media-livekit.local.yaml` | `LIVEKIT_KEYS="<key>: <secret>"` (the server's `VOKKO_MEDIA_LIVEKIT_API_KEY` / `_API_SECRET`) | `ProcessType` `Interactive`, `RunAtLoad`, `KeepAlive`. The local yaml is a copy of `deploy/media-livekit.yaml` with your interface and address. |
| `stremio-bot` | `/Users/<you>/.local/bin/stremio-bot` (`cargo build --release -p stremio-bot`) | `PATH` with `ffmpeg`/`ffprobe`, `VOKKO_STREMIO_BOT_SECRET` (the server's), `VOKKO_STREMIO_BOT_LISTEN=127.0.0.1:8720`, `VOKKO_STREMIO_SERVER_URL=http://127.0.0.1:8710`, optional `VOKKO_STREMIO_MAX_SESSIONS` | `ProcessType` `Interactive`, `RunAtLoad`, `KeepAlive`. |
| `spotify-bot` | `/Users/<you>/.local/bin/spotify-bot` (`cargo build --release -p spotify-bot`, then `spotify-bot login` once) | `VOKKO_SPOTIFY_BOT_SECRET` (the server's), `VOKKO_SPOTIFY_BOT_LISTEN=127.0.0.1:8721`, `VOKKO_SPOTIFY_SERVER_URL=http://127.0.0.1:8710`, `VOKKO_SPOTIFY_MARKET` (same as the server's) | `RunAtLoad`, `KeepAlive`. |
| `backup` | `/bin/bash <repo checkout>/tools/backup.sh` | `PATH` with `docker` and `rsync`, `VOKKO_BACKUP_COMPOSE_DIR=<repo checkout>/deploy`, `VOKKO_BACKUP_DIR` (another disk than the Docker volumes), optional `VOKKO_BACKUP_OFFSITE` | `StartCalendarInterval` (e.g. 04:00; a run missed while asleep starts on wake). See docs/backups.md. |

Example (`media-livekit`; the other jobs differ only in the rows above):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>org.vokko.media-livekit</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/livekit-server</string>
        <string>--config</string>
        <string>/path/to/vokko/deploy/media-livekit.local.yaml</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>LIVEKIT_KEYS</key>
        <string>REPLACE_ME_KEY: REPLACE_ME_SECRET</string>
    </dict>
    <!-- Interactive: launchd throttles unspecified jobs, and a movie stalls when builds load the machine -->
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/REPLACE_ME/Library/Logs/vokko-media-livekit.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/REPLACE_ME/Library/Logs/vokko-media-livekit.log</string>
</dict>
</plist>
```
