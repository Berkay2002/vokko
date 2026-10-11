# Self-hosting Vokko

Vokko's server is one Rust binary (`vokko-server`) plus PostgreSQL. Uploaded files live on local disk. Everything here assumes Docker with Compose v2; the files are in `deploy/`, `Dockerfile` and `deploy/web.Dockerfile`.

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
| `DATABASE_URL` | required | PostgreSQL URL. Compose builds it from `POSTGRES_PASSWORD`. |
| `VOKKO_BIND` | `127.0.0.1:8710` (image: `0.0.0.0:8710`) | Listen address. |
| `VOKKO_DATA_DIR` | image: `/data` | Where attachments are stored (`<dir>/attachments`). Mounted as the `vokko-data` volume. |
| `VOKKO_PUBLIC_URL` | `http://<bind>` | Origin used in absolute attachment URLs. Set it to what clients type. |
| `VOKKO_MAX_UPLOAD_MB` | `25` | Per-file upload limit in MiB (whole number, at least 1). |
| `VOKKO_UNFURL` | on | `off`/`0`/`false`/`no` disables link previews (no outbound requests at all). |
| `VOKKO_TRUST_PROXY` | off | `on`/`1`/`true`/`yes`: take the client address from the last `X-Forwarded-For` entry. Only behind a proxy that sets it (the bundled Caddy does), otherwise clients can spoof their address and dodge rate limits. |
| `RUST_LOG` | `vokko_server=info,warn` | Log filter. |

Compose-only variables (`deploy/.env.example`): `POSTGRES_PASSWORD`, `VOKKO_SERVER_LISTEN` (host publish address for the server, default `127.0.0.1:8710`), `VOKKO_SITE_ADDRESS`, `VOKKO_WEB_HTTP_PORT`, `VOKKO_WEB_HTTPS_PORT`.

The binary has two subcommands: `serve` (default) and `seed`. Both connect and migrate first.

## Backups

State is the `pgdata` volume (messages, users, everything structured) and the `vokko-data` volume (uploaded files). Back up both; the database rows reference files by id.

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

Serve the web client from the same origin as the API. The server's CORS allowlist is only `http://localhost[:port]`, `http://127.0.0.1[:port]` and the Tauri origins, so a web client on another origin will be blocked by the browser.

## Upload limit

`VOKKO_MAX_UPLOAD_MB` (default 25) caps one file; a message holds up to 10 files, and each user may have 100 MiB of not-yet-sent uploads (those are deleted after an hour). Change it in `deploy/.env` and `docker compose up -d`. A reverse proxy in front must allow at least that much (nginx: `client_max_body_size`; Caddy has no limit by default). The bundled client currently enforces its own limit in the composer, so raising the server limit does not raise it in the UI until the client is changed.

## Not production-ready yet

- No health endpoint; the container healthcheck only proves the port accepts connections.
- Single instance only: the gateway hub, replay buffers, presence and rate limiters live in process memory. No horizontal scaling; a restart drops every websocket (clients resume or reconnect).
- Uploads are on local disk (no S3 or object storage), and there is no built-in backup, retention or admin tooling.
- Registration is open to anyone who can reach the server, and there is no email verification or password reset. Keep it private (VPN/LAN, or an auth layer in the proxy) until that exists.
- `seed` creates accounts with a published password; development only.
- The server speaks plain HTTP; TLS comes from the proxy. No audit logs, metrics endpoint or log rotation beyond Docker's own.
- Link previews fetch URLs from the server's network (private and loopback addresses are blocked); turn them off with `VOKKO_UNFURL=off` if you do not want outbound requests.
- Pre-1.0: wire contract and schema may change between commits; always back up before upgrading.
