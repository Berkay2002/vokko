# Self-hosting Vokko

Vokko's server is one Rust binary (`vokko-server`) plus PostgreSQL. Uploaded files live on local disk by default, or in an S3-compatible bucket. No always-on machine? See [self-hosting-free.md](self-hosting-free.md) for free-tier recipes (Oracle Always Free VM, Neon/Supabase + R2). Everything here assumes Docker with Compose v2; the files are in `deploy/`, `Dockerfile` and `deploy/web.Dockerfile`.

## Requirements

- Linux (or any host with Docker Engine + the compose plugin), 1-2 CPU cores, 1-2 GB RAM. That is the target size: the server idles in tens of MB and PostgreSQL is the larger consumer. Building the image from source needs about 2 GB RAM and a few minutes; build elsewhere and `docker save`/push if the box is smaller.
- Disk: the database plus uploads. Budget uploads at roughly (users x 100 MiB pending quota) at the very worst; real usage is far lower.
- A domain name and open ports 80/443 if you want HTTPS (recommended for anything beyond a LAN).

## Quick start

```sh
cd deploy
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD (openssl rand -hex 24) and VOKKO_PUBLIC_URL
docker compose up -d --build        # postgres + vokko-server on 127.0.0.1:8710
docker compose logs -f server       # "vokko-server listening on http://0.0.0.0:8710"
```

Register the first account through a client (`POST /api/v1/auth/register`, or the web client below). Migrations run on every start, so there is no separate setup step.

Optional demo data (five users, a guild, DMs; every user has the password `vokko-dev`). Never do this on a server people can reach:

```sh
docker compose run --rm server seed
```

Web client plus automatic HTTPS (Caddy):

```sh
# .env: VOKKO_PUBLIC_URL=https://chat.example.com  VOKKO_SITE_ADDRESS=chat.example.com  VOKKO_TRUST_PROXY=on
docker compose --profile web up -d --build
```

For a local trial without a domain use `VOKKO_PUBLIC_URL=http://localhost`, `VOKKO_SITE_ADDRESS=:80` and open `http://localhost`.

The web image bakes `VOKKO_PUBLIC_URL` into the bundle (`VITE_VOKKO_API`); after changing it run `docker compose --profile web up -d --build web`. A bundle built without an API URL runs on the in-memory mock, which the build rejects.

Desktop (Tauri) clients connect to `VOKKO_PUBLIC_URL` directly; their `tauri://localhost` origin is already allowed by the server.

## Configuration

Read by `vokko-server` from the environment (a `.env.dev` file found from the working directory upwards is a fallback for development; the container uses real environment variables). Compose maps the `.env` file onto these.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL URL. Compose builds it from `POSTGRES_PASSWORD`. `sslmode` (`disable`, `prefer` (default), `require`, `verify-ca`, `verify-full`) and `sslrootcert` are honoured (TLS via rustls). Over the internet use `verify-full`: `prefer` and `require` encrypt without checking the certificate. A provider with its own CA (Supabase) needs `sslrootcert=<file>`; see [self-hosting-free.md](self-hosting-free.md). |
| `VOKKO_DB_MAX_CONNECTIONS` | `10` | Database pool size (1-1000). Lower it on free tiers with small connection limits. |
| `VOKKO_BIND` | `127.0.0.1:8710` (image: `0.0.0.0:8710`) | Listen address. |
| `VOKKO_DATA_DIR` | image: `/data` | Where attachments are stored (`<dir>/attachments`) with local storage. Mounted as the `vokko-data` volume. |
| `VOKKO_STORAGE` | `local` | `local` (files under `VOKKO_DATA_DIR`) or `s3` (any S3-compatible bucket: Cloudflare R2, Backblaze B2, Supabase Storage, MinIO, AWS S3). Switching does not move existing files (copy `<data dir>/attachments/*` to `<prefix>*` in the bucket, e.g. with rclone, or old attachments answer 404). With `s3`, deleted guilds, channels and accounts remove their files in the background. |
| `VOKKO_S3_ENDPOINT` | required with `s3` | Endpoint without the bucket, e.g. `https://<account>.r2.cloudflarestorage.com`, `https://s3.<region>.backblazeb2.com`, `https://<project>.supabase.co/storage/v1/s3`, `http://minio:9000`. Path-style addressing (`<endpoint>/<bucket>/<key>`). |
| `VOKKO_S3_BUCKET` / `VOKKO_S3_REGION` | required / `auto` | Bucket name and its region (`auto` for R2; e.g. `us-west-004` for B2, the project region for Supabase). |
| `VOKKO_S3_ACCESS_KEY_ID` / `VOKKO_S3_SECRET_ACCESS_KEY` | required with `s3` | Keys with read, write and delete on the bucket. |
| `VOKKO_S3_PREFIX` | `attachments/` | Object key prefix (objects are `<prefix><attachment id>`). |
| `VOKKO_S3_SERVE` | `proxy` | `proxy`: downloads stream through vokko-server (the bucket stays private). `presigned`: after the same key/filename check the server answers `302` to a short-lived presigned bucket URL, so file bytes skip the server. |
| `VOKKO_S3_PRESIGN_TTL_SECS` | `300` | Lifetime of presigned URLs (1-604800). |
| `VOKKO_PUBLIC_URL` | `http://<bind>` | Origin used in absolute attachment URLs. Set it to what clients type. |
| `VOKKO_MAX_UPLOAD_MB` | `25` | Per-file upload limit in MiB (whole number, at least 1). |
| `VOKKO_UNFURL` | on | `off`/`0`/`false`/`no` disables link previews (no outbound requests at all). |
| `VOKKO_GIF_PROVIDER` | `none` | `klipy`, `giphy`, `tenor` or `none`. The server proxies GIF search/trending/categories so the key never reaches clients; with `none` the GIF picker shows each user's favourites only. Needs outbound HTTPS to the provider. |
| `VOKKO_GIF_API_KEY` | empty | Provider API key; required when `VOKKO_GIF_PROVIDER` is not `none`. |
| `VOKKO_GIF_BASE_URL` | provider default | Override of the provider's API origin (mirrors, tests). |
| `VOKKO_REMINDER_POLL_SECS` | `15` | How often due message reminders are delivered. |
| `VOKKO_TRUST_PROXY` | off | `on`/`1`/`true`/`yes`: take the client address from the last `X-Forwarded-For` entry. Only behind a proxy that sets it (the bundled Caddy does), otherwise clients can spoof their address and dodge rate limits. Uses the last `X-Forwarded-For` line, so exactly one proxy hop. |
| `VOKKO_CORS_ORIGINS` | unset (localhost on any port) | Comma-separated exact origins allowed to call the API from a browser, e.g. `https://chat.example.com,https://web.example.com`. Scheme and host (and port if not default), no path, no `*`. When set it replaces the localhost defaults; the Tauri origins stay allowed. Bad entries stop the server at start. |
| `VOKKO_REGISTRATION` | `open` | `closed`: `POST /api/v1/auth/register` answers 403 (code 40002). Existing accounts, login and `seed` are unaffected, so create the accounts you need first, then close it. Anything else than `open`/`closed` stops the server at start. |
| `VOKKO_MIN_AGE` | `13` | Minimum age in years, checked against the date of birth at sign-up. |
| `VOKKO_TERMS_TEXT` / `VOKKO_TERMS_URL` | unset | Either one adds a required consent checkbox to sign-up (plain-text label, optional link). |
| `VOKKO_WEB_URL` | `VOKKO_PUBLIC_URL` | Origin of the web client, used in emailed verification and password-reset links. |
| `VOKKO_SMTP_HOST` | unset | SMTP server for account mail. Unset: every mail (with its link) is written to the server log instead, see below. |
| `VOKKO_SMTP_PORT` / `VOKKO_SMTP_SECURITY` | `587` / `starttls` | `starttls`, `tls` (implicit TLS, default port 465) or `none` (port 25, local relays only). |
| `VOKKO_SMTP_USERNAME` / `VOKKO_SMTP_PASSWORD` / `VOKKO_SMTP_FROM` | unset | Credentials (optional) and the sender address (required with a host), e.g. `Vokko <noreply@chat.example.com>`. |
| `VOKKO_OAUTH_GITHUB_CLIENT_ID` / `_SECRET` | unset | "Sign in with GitHub" (GitHub OAuth app). See "Sign-in providers" below. |
| `VOKKO_OAUTH_GOOGLE_CLIENT_ID` / `_SECRET` | unset | "Sign in with Google" (Google OAuth client, web application type). |
| `VOKKO_OIDC_<NAME>_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` / `_DISPLAY_NAME` | unset | Any OpenID Connect provider (GitLab, Microsoft Entra, Keycloak, Authentik...). `<NAME>` becomes the provider id (lowercased); the display name defaults to it. |
| `VOKKO_LIVEKIT_URL` | unset | Public LiveKit signal URL handed to clients, e.g. `wss://lk.example.com`. Voice needs this and the two below; with none of them set voice is off (joining a voice channel fails with `media_unavailable`); setting only some stops the server at start. See [Voice](#voice-livekit). |
| `VOKKO_LIVEKIT_API_KEY` | unset | LiveKit API key name (the key in `livekit.yaml` `keys:`). |
| `VOKKO_LIVEKIT_API_SECRET` | unset | Its secret. Only vokko-server holds it; it signs every voice token and verifies LiveKit's webhooks. |
| `VOKKO_LIVEKIT_API_URL` | derived from `VOKKO_LIVEKIT_URL` (`wss` → `https`) | Where vokko-server reaches LiveKit's RoomService, e.g. `http://127.0.0.1:7880` when both run on one host. |
| `VOKKO_VOICE_BITRATE_MAX` | `128000` | Highest voice channel bitrate in bps (8000-384000). New channels start at 64000. |
| `VOKKO_VOICE_CONNECT_TIMEOUT_SECS` | `30` | How long a client may take to reach LiveKit after getting its voice token (5-600 s) before its voice state is dropped. Raise it when clients connect over slow TURN/TCP. |
| `RUST_LOG` | `vokko_server=info,warn` | Log filter. |

Compose-only variables (`deploy/.env.example`): `POSTGRES_PASSWORD`, `VOKKO_SERVER_LISTEN` (host publish address for the server, default `127.0.0.1:8710`), `VOKKO_SITE_ADDRESS`, `VOKKO_WEB_HTTP_PORT`, `VOKKO_WEB_HTTPS_PORT`.

The binary has two subcommands: `serve` (default) and `seed`. Both connect and migrate first.

## Account mail

Sign-up sends an email verification link; email changes and password resets send links too. Invalid `VOKKO_SMTP_*` settings (bad sender address, unknown security mode, username without password, any `VOKKO_SMTP_*` without `VOKKO_SMTP_HOST`) stop the server at start. Without `VOKKO_SMTP_HOST` nothing is mailed: the server logs each mail at info level, so a self-hoster on a private instance can hand the link over by hand:

```sh
docker compose logs server | grep -A4 "mail (SMTP not configured)"
```

Links point at `VOKKO_WEB_URL` (`/verify#token=...`, `/reset#token=...`) and are single use: verification links expire after 24 hours, reset links after one hour. Anyone who can read the log can use them, so keep the log private or configure SMTP.

## Sign-in providers

Each provider shows up on the login and register pages only when its variables are set. Register this redirect (callback) URL with the provider, using the provider id (`github`, `google`, or the lowercased `<NAME>`):

```
<VOKKO_PUBLIC_URL>/api/v1/auth/oauth/<id>/callback
```

- GitHub: Settings > Developer settings > OAuth Apps > New OAuth App; "Authorization callback URL" as above. Vokko asks for `read:user` and `user:email` and only trusts a primary, verified email.
- Google: Google Cloud console > APIs & Services > Credentials > OAuth client ID (Web application); add the URL under "Authorized redirect URIs".
- OpenID Connect: create a confidential client with the authorization code flow and the redirect URL; set `VOKKO_OIDC_<NAME>_ISSUER` to the issuer URL (the one whose `/.well-known/openid-configuration` exists), e.g. `https://gitlab.com`, `https://login.microsoftonline.com/<tenant>/v2.0`, `https://keycloak.example.com/realms/<realm>`, `https://authentik.example.com/application/o/<slug>/`.

The server talks to the provider itself (token exchange, ID token signature and nonce checks); client secrets stay on the server. A first sign-in asks for a username and date of birth and creates the account; an email that already belongs to an account is not merged automatically, the user links the provider from My Account > Sign-in Methods instead. The desktop app gets the result through the `vokko://auth/callback` link.

## Voice (LiveKit)

Voice channels use a self-hosted [LiveKit](https://livekit.io) server (Apache-2.0, a single Go binary). Media flows between clients and LiveKit; vokko-server only checks permissions, mints short-lived tokens and listens to LiveKit's webhooks. Clients need `https` for the API (browsers only allow microphone access in a secure context; plain HTTP works on `localhost` only), `wss://` to LiveKit's signal port, and direct UDP/TCP to its media ports.

Ports (forward the "yes" rows on your router):

| Port | Proto | Purpose | Forward |
| --- | --- | --- | --- |
| 443 | TCP | Caddy: API, gateway, LiveKit signal (`lk.example.com` → 7880) | yes |
| 7881 | TCP | ICE over TCP (fallback when UDP is blocked) | yes |
| 7882 | UDP | all WebRTC media on one port | yes |
| 3478 | UDP | embedded TURN/UDP | yes |
| 5349 | TCP | embedded TURN/TLS (strict networks) | optional |
| 7880 | TCP | LiveKit HTTP/websocket + RoomService, behind Caddy only | no |

Behind CGNAT (no public IPv4) calls from outside the LAN cannot reach a home server; run LiveKit (or only its TURN) on a small VPS instead.

`livekit.yaml` (key names follow LiveKit's sample config; check them against the release you install):

```yaml
port: 7880
bind_addresses: ["0.0.0.0"]
rtc:
  tcp_port: 7881
  udp_port: 7882            # single muxed UDP port: easy to forward
  use_external_ip: true     # discover the public IP via STUN, or set node_ip
keys:
  vokko: <a long random secret>   # name = VOKKO_LIVEKIT_API_KEY, value = VOKKO_LIVEKIT_API_SECRET
room:
  auto_create: true
  empty_timeout: 60
  departure_timeout: 20
  max_participants: 100
audio:
  update_interval: 200      # speaking rings follow speech within ~200 ms
turn:
  enabled: true
  domain: turn.example.com
  udp_port: 3478
  tls_port: 5349
  cert_file: /path/to/turn.crt
  key_file: /path/to/turn.key
webhook:
  api_key: vokko
  urls: ["http://127.0.0.1:8710/internal/livekit/webhook"]
limit:
  bytes_per_sec: 12500000   # ~100 Mbit/s egress backstop; set it below your upload bandwidth
```

The webhook URL is how LiveKit reaches vokko-server, not a public URL: keep `/internal/*` off the reverse proxy (the sample Caddyfile only forwards `/api/*` and `/gateway`). Webhooks are signed with the API secret; anything unsigned gets 401.

**macOS (recommended for a home server): run LiveKit natively.** Docker Desktop on macOS forwards UDP through a VM in userspace, which adds latency and CPU for every packet. Install the native binary (`brew install livekit`, or the release binary from GitHub) and run it under launchd, keeping vokko-server and PostgreSQL in Docker:

```sh
livekit-server --config /usr/local/etc/livekit.yaml     # test in the foreground first
```

A minimal `~/Library/LaunchAgents/io.livekit.server.plist` runs the same command with `RunAtLoad` and `KeepAlive` set to true (`launchctl load` it). vokko-server in Docker reaches the host's LiveKit at `http://host.docker.internal:7880` (`VOKKO_LIVEKIT_API_URL`), and LiveKit reaches vokko-server's published port at `http://127.0.0.1:8710/internal/livekit/webhook`.

**Linux: Docker Compose alternative.** Add to `deploy/docker-compose.yml` (host networking avoids Docker's UDP proxy):

```yaml
services:
  livekit:
    image: livekit/livekit-server:v1.9      # pin the exact tag you tested
    command: --config /etc/livekit.yaml
    network_mode: host
    restart: unless-stopped
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
  server:
    environment:
      VOKKO_LIVEKIT_URL: wss://lk.example.com
      VOKKO_LIVEKIT_API_URL: http://host.docker.internal:7880
      VOKKO_LIVEKIT_API_KEY: vokko
      VOKKO_LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}
    extra_hosts: ["host.docker.internal:host-gateway"]
```

Caddy for the signal websocket: `lk.example.com { reverse_proxy 127.0.0.1:7880 }`. TURN needs its own hostname with a certificate (`turn.example.com`; point `cert_file`/`key_file` at a copy of Caddy's certificate).

Sizing: the SFU forwards and never transcodes, so CPU stays low (a 10-person voice room is well under 10 % of a core); upload bandwidth is the limit. Each speaker costs about 70 kbit/s per listener (silence ~1 kbit/s), so a 20 Mbit/s uplink carries dozens of voice users. Voice states live in vokko-server's memory and are rebuilt from LiveKit after a restart, so restarting vokko-server does not drop calls.

## Backups

State is the `pgdata` volume (messages, users, everything structured) and the `vokko-data` volume (uploaded files; with `VOKKO_STORAGE=s3` the bucket instead). Back up both; the database rows reference files by id.

```sh
cd deploy
docker compose exec -T postgres pg_dump -U vokko -Fc vokko > vokko-$(date +%F).dump
docker run --rm -v vokko_vokko-data:/data:ro -v "$PWD":/backup debian:bookworm-slim tar czf /backup/vokko-data-$(date +%F).tgz -C /data .
```

(The volume prefix is the compose project name, `vokko`; check with `docker volume ls`.) For a consistent pair take the dump right before the tar; a file uploaded between them is at worst an orphan. Restore into a fresh stack:

```sh
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U vokko -d vokko --clean --if-exists < vokko-YYYY-MM-DD.dump
docker run --rm -v vokko_vokko-data:/data -v "$PWD":/backup debian:bookworm-slim sh -c 'tar xzf /backup/vokko-data-YYYY-MM-DD.tgz -C /data && chown -R 10001:10001 /data'
docker compose up -d
```

Test a restore before you rely on it. Keep copies off the machine.

## Upgrades

```sh
git pull
cd deploy && docker compose up -d --build        # add --profile web if you run the web client
```

Migrations are embedded in the binary and applied on start; the old container keeps serving until the new one is built. Back up first: migrations only move forward, so rolling back means restoring the dump taken before the upgrade. PostgreSQL major upgrades (16 to 17) need a dump and restore, not just a tag change.

## Desktop app updates

The desktop app updates itself only if it was built for it. Updates are off by default: a build without updater settings never contacts a server for updates, and Windows Settings > Updates says so. To turn them on for your own builds, put a `plugins.updater` entry (your signing public key and an HTTPS endpoint that serves the update manifest) into the Tauri config at build time through `TAURI_CONFIG`, and sign the bundles with your private key. The steps, the manifest format and the in-app flow (check, download progress, "Restart to update") are in [desktop-release.md](desktop-release.md#updater). The endpoint is fixed when the app is built; it is not a server setting, and Vokko does not host update files for you.

## Reverse proxy and TLS

The bundled `web` profile already runs Caddy with automatic certificates (`deploy/Caddyfile`). If you run your own Caddy on the host and want only the server container, publish the server on loopback (the default), set `VOKKO_TRUST_PROXY=on` and `VOKKO_PUBLIC_URL=https://chat.example.com`, and use:

```caddyfile
chat.example.com {
	encode zstd gzip
	@vokko path /api/* /gateway
	reverse_proxy @vokko 127.0.0.1:8710
	# plus root * /srv/vokko-web / try_files {path} /index.html / file_server if you host the web client yourself
}
```

Caddy upgrades the `/gateway` websocket and appends `X-Forwarded-For` without extra settings. With nginx, add the usual `Upgrade`/`Connection` headers for `/gateway`, set `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`, and raise `client_max_body_size` above the upload limit.

Serve the web client from the same origin as the API where you can: same-origin requests need no CORS at all. A web client on another origin must be listed in `VOKKO_CORS_ORIGINS`; without it the allowlist is only `http://localhost[:port]`, `http://127.0.0.1[:port]` and the Tauri origins, and the browser blocks everything else. CORS does not apply to the websocket gateway (it is authenticated by the token in Identify).

## Health check

`GET /healthz` needs no authentication and is not rate limited. It runs a `SELECT 1` against the database (2 second limit) and answers `200 {"status":"ok","version":"<server version>","db":"ok"}`, or `503 {"status":"unavailable","version":"...","db":"error"}` when the database does not answer. Point an uptime monitor or a compose healthcheck at it, e.g. `curl -fsS http://127.0.0.1:8710/healthz`. Through the reverse proxy it is only reachable if the proxy forwards `/healthz` (the sample Caddyfile above forwards `/api/*` and `/gateway` only, so add `/healthz` to the matcher if you want it public).

## Upload limit

`VOKKO_MAX_UPLOAD_MB` (default 25) caps one file; a message holds up to 10 files, and each user may have 100 MiB of not-yet-sent uploads (those are deleted after an hour). Change it in `deploy/.env` and `docker compose up -d`. A reverse proxy in front must allow at least that much (nginx: `client_max_body_size`; Caddy has no limit by default). The bundled client currently enforces its own limit in the composer, so raising the server limit does not raise it in the UI until the client is changed.

## Not production-ready yet

- The bundled container healthcheck still only proves the port accepts connections; `GET /healthz` (see above) is the real check, but `deploy/` does not use it yet.
- Voice V1 has no server mute/deafen, moves or DM calls yet; camera and screen share are not available (later milestones in `docs/design/voice.md`).
- Per-address limits treat an IPv6 /64 as one client (a single host usually holds a whole /64). Devices on one IPv6 LAN, or clients behind a NAT64 gateway (`64:ff9b::/96`), therefore share the login limit and the 16 unidentified gateway sockets, as devices behind one IPv4 NAT do.
- Single instance only: the gateway hub, replay buffers, presence and rate limiters live in process memory. No horizontal scaling; a restart drops every websocket (clients resume or reconnect).
- There is no built-in backup, retention or admin tooling (uploads can live in an S3-compatible bucket, `VOKKO_STORAGE=s3`).
- Registration is open by default; set `VOKKO_REGISTRATION=closed` once your accounts exist. There is no invite-only mode or captcha.
- `seed` creates accounts with a published password; development only.
- The server speaks plain HTTP; TLS comes from the proxy. No audit logs, metrics endpoint or log rotation beyond Docker's own.
- Link previews fetch URLs from the server's network (private and loopback addresses are blocked); turn them off with `VOKKO_UNFURL=off` if you do not want outbound requests.
- Pre-1.0: wire contract and schema may change between commits; always back up before upgrading.
