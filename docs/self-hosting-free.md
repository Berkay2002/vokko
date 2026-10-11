# Self-hosting Vokko on free tiers

For people who want their own Vokko but have no home server or VPS budget. Two recipes, with the limits that matter. Free tiers change often: the numbers below were checked in October 2026, so read each provider's current pricing page before you rely on them. Everything else (configuration table, backups, reverse proxy) is in [self-hosting.md](self-hosting.md).

What Vokko needs from a host, whatever the recipe:

- **An always-on process.** `vokko-server` holds every client's gateway websocket, presence, replay buffers and voice state in memory. Clients reconnect and resume after a restart, but a host that stops the process when it has no HTTP traffic (Render free, Koyeb/Railway trial sleep, Cloud Run scale-to-zero, Fly machines with auto-stop) breaks it: an open websocket does not always count as traffic, so the host sleeps the server while people are connected, every client drops, and the next request waits for a cold start. Background jobs (pending-upload cleanup, reminders, voice reconciliation) also stop while it sleeps. Sleeping hosts are fine for trying Vokko, not for a server people use.
- **PostgreSQL** (CI and the compose file use 16), reachable with a normal session (prepared statements).
- **Somewhere for uploads**: a disk that survives restarts, or an S3-compatible bucket (`VOKKO_STORAGE=s3`).
- **HTTPS** in front of the server for anything beyond a LAN (the bundled Caddy does it).
- **Voice** is optional and needs LiveKit (self-hosted, or LiveKit Cloud's free plan).

## Recipe A (recommended): one Oracle Cloud Always Free ARM VM

The whole existing stack (`deploy/docker-compose.yml`: server + Postgres + local disk, optional web client + Caddy) on one free VM. Nothing pauses on its own and there is only one machine to back up.

**What you get (Oracle "Always Free Resources" page):** Ampere A1 (ARM) compute up to 4 OCPUs and 24 GB RAM in total, 200 GB of block storage, 10 TB of outbound traffic per month. A 1-2 OCPU / 6-12 GB VM is plenty for a community server; the rest of the allowance can stay unused.

**Trade-offs:**

- A1 capacity is often "out of host capacity" in popular regions when you create the VM. Retrying later, or picking another availability domain, usually works; upgrading the account to pay-as-you-go (you are still not charged inside the free limits) makes it much easier and also exempts the VM from idle reclamation.
- **Idle reclamation:** on free (not pay-as-you-go) accounts Oracle may stop VMs that look idle over 7 days (95th-percentile CPU, network and, for A1, memory all below a small threshold, 15-20 % depending on the doc version). A quiet Vokko server can look idle. Upgrading to pay-as-you-go avoids it; otherwise check your mail for Oracle's warning and keep backups off the VM.
- Free accounts are tied to a home region chosen at sign-up; you cannot move it later.
- Building the image on the VM needs about 2 GB RAM and several minutes on ARM; the Dockerfile builds natively for arm64.

**Steps:**

1. Create an Oracle Cloud account (card needed for identity checks), then a VM: shape `VM.Standard.A1.Flex`, image Ubuntu 24.04 (or Oracle Linux), 2 OCPU / 12 GB, 50-100 GB boot volume. Add your SSH key.
2. Networking: in the VCN's security list (or a network security group) allow inbound TCP 80 and 443. Ubuntu images on OCI also ship iptables rules that drop them: `sudo iptables -I INPUT 6 -p tcp -m multiport --dports 80,443 -j ACCEPT && sudo netfilter-persistent save`.
3. Point a DNS name (`chat.example.com`) at the VM's public IP. A free domain from your registrar or a free subdomain service works; Caddy needs a real name for Let's Encrypt.
4. Install Docker Engine and the compose plugin (docs.docker.com, "Install Docker Engine on Ubuntu").
5. Clone the repo and follow the [quick start](self-hosting.md#quick-start) with the web profile:

   ```sh
   cd deploy && cp .env.example .env
   # .env: POSTGRES_PASSWORD=$(openssl rand -hex 24)
   #       VOKKO_PUBLIC_URL=https://chat.example.com  VOKKO_SITE_ADDRESS=chat.example.com  VOKKO_TRUST_PROXY=on
   docker compose --profile web up -d --build
   ```

6. Register your accounts, then set `VOKKO_REGISTRATION=closed` if the server is private.
7. Voice: see [LiveKit Cloud free](#voice-livekit-cloud-free) below, or run LiveKit on the same VM ([self-hosting.md, Voice](self-hosting.md#voice-livekit); the A1 VM has the bandwidth for it, open its UDP ports in the security list too).

**Environment:** exactly the compose defaults plus the four `.env` lines above. Uploads stay on the `vokko-data` volume. You can move them to R2 later (`VOKKO_STORAGE=s3`, see recipe B), but switching does not move existing files: until you copy them, every older attachment answers 404. Object keys are `<prefix><attachment id>`, the same names as the local files, so one copy does it: `rclone copy <path of the vokko-data volume>/attachments r2:<bucket>/attachments/` (with the default `VOKKO_S3_PREFIX=attachments/`), then restart the server with the S3 settings.

**If the free tier pauses:** if Oracle stops the VM for idleness, everything is down until you start it again in the console (data on the boot volume survives a stop). If the account is terminated, the VM and its disks are gone, which is why backups must live elsewhere.

**Backups:** the `pg_dump` + `tar` commands from [self-hosting.md, Backups](self-hosting.md#backups), run from cron on the VM, then copied off it, e.g. to an R2/B2 bucket with `rclone copy` (both have 10 GB free) or to your own machine with `scp`. Oracle's free tier also includes 5 boot/block volume backups; they are in the same account, so they do not protect against losing the account.

## Recipe B: no database VM (Neon or Supabase + an always-on container host + R2)

For when you cannot get (or do not want) a VM with a disk: managed Postgres, a bucket for files, and any host that runs one container **continuously**.

**Pieces:**

| Piece | Free option | Limits that matter (October 2026) |
| --- | --- | --- |
| Postgres | **Neon** Free | 0.5 GB storage per project, 100 CU-hours of compute per month (smallest compute 0.25 CU), compute scales to zero after 5 minutes idle, 5 GB transfer per month. **Not enough for an always-on server**, see below. |
| Postgres | **Supabase** Free | 500 MB database, 2 active projects, **project pauses after a week without activity** and stays down until you restore it from the dashboard; no backups included. |
| Files | **Cloudflare R2** | 10 GB storage, 1 million writes and 10 million reads per month, no egress fees. Backblaze B2 (10 GB) and Supabase Storage (1 GB) work too. |
| Server | An always-on container host | Must keep one process running without traffic, allow inbound websockets and give ~256 MB RAM. Free options come and go; whatever you pick, check it does not sleep idle services (see the top of this page). The Oracle VM from recipe A also works here, running only the server container. |
| Voice | LiveKit Cloud free | See below. |

**Database notes:**

- Use the **direct (unpooled) connection string**. Transaction-mode poolers (Neon's `-pooler` host, Supabase's transaction pooler on port 6543, PgBouncer in `transaction` mode) hand each statement to a different backend, which breaks the prepared statements sqlx caches per connection. Vokko keeps its own small pool, so a pooler buys nothing anyway.
  - Neon: in the dashboard "Connect" dialog turn **off** "Connection pooling"; the host has no `-pooler` suffix.
  - Supabase: the "Direct connection" string (`db.<project>.supabase.co:5432`) is IPv6-only on the free plan. If your host has IPv6, use it. If not, use the **Session pooler** string (`aws-0-<region>.pooler.supabase.com:5432`, user `postgres.<project>`): session mode keeps one backend per client connection, so prepared statements work. Never the transaction pooler on port 6543.
- Use `sslmode=verify-full`. `require` encrypts but does **not** check the certificate (and `verify-ca` skips the hostname check), so anyone on the path between your host and the database could impersonate it.
  - Neon: its certificates chain to public roots, which the server bundles: `...?sslmode=verify-full` is all it needs.
  - Supabase: signs with its own CA, which is not in the public roots. Download the certificate from the project's Database settings ("SSL Configuration", `prod-ca-2021.crt`), mount it into the container and add `&sslrootcert=/path/to/prod-ca-2021.crt` to the URL. It is meant for both the direct and the pooler connections; we have only tested `verify-full` against a direct-style server, so if the session pooler's hostname does not match its certificate, use `verify-ca` with the same file (chain checked, hostname not) rather than `require`.
- Keep the pool small: `VOKKO_DB_MAX_CONNECTIONS=5` is plenty for a small community and stays well inside free connection limits (Supabase's free compute allows 60 direct connections, shared with its own services).
- **Neon never gets to sleep:** a running vokko-server queries the database at least every minute (the thread auto-archive sweep every 60 s, reminders every 15 s, plus upload cleanup and voice reconciliation), so Neon's 5-minute idle suspend never triggers. At the smallest compute (0.25 CU) that is about 0.25 x 730 = 180 CU-hours a month against 100 free: the allowance runs out after roughly two and a half weeks, and Neon then suspends the database until the next month (the server's `/healthz` answers 503 and clients see errors). Neon Free is fine for trying Vokko or for a server you only start now and then; for an always-on server use Supabase, recipe A, or a paid Neon plan.
- **Supabase pause:** a server people use is activity, so the weekly pause only hits abandoned servers; Supabase emails before pausing. When paused, the server cannot connect (start fails with `database connection failed`, a running server answers 503 on `/healthz`) until you restore the project in the dashboard.
- **Size:** 0.5 GB (Neon) or 500 MB (Supabase) is the whole database: messages, search and audit rows. Files are not in it (they are in the bucket). Watch it in the provider's dashboard; when full, writes fail.

**Steps:**

1. Create the database (a Supabase project; Neon only for a trial, see above) and copy the direct or session-pooler connection string.
2. Create a bucket in R2 (Cloudflare dashboard > R2 > Create bucket, keep it private), then an R2 API token with "Object Read & Write" on that bucket. Note the account's S3 endpoint `https://<account id>.r2.cloudflarestorage.com`, the Access Key ID and the Secret Access Key.
3. Deploy the server image (`docker build -t vokko-server .` and push it to a registry your host can pull from, e.g. GHCR) with these environment variables:

   ```sh
   DATABASE_URL=postgres://<user>:<password>@<host>:5432/<db>?sslmode=verify-full&sslrootcert=/certs/prod-ca-2021.crt   # Supabase; Neon: no sslrootcert
   VOKKO_DB_MAX_CONNECTIONS=5
   VOKKO_PUBLIC_URL=https://chat.example.com      # what clients type
   VOKKO_BIND=0.0.0.0:8710                         # or the port your host expects
   VOKKO_TRUST_PROXY=on                            # only if every request arrives through the host's proxy
   VOKKO_STORAGE=s3
   VOKKO_S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
   VOKKO_S3_BUCKET=vokko
   VOKKO_S3_REGION=auto
   VOKKO_S3_ACCESS_KEY_ID=...
   VOKKO_S3_SECRET_ACCESS_KEY=...
   # VOKKO_S3_SERVE=presigned                      # optional, see below
   ```

   Migrations run on start, so the first boot sets up the schema. No volume is needed: with `VOKKO_STORAGE=s3` the server writes nothing to disk.
4. Serve the web client (`deploy/web.Dockerfile`, or any static host such as Cloudflare Pages with `VITE_VOKKO_API` set at build time). On another origin than the API, list it in `VOKKO_CORS_ORIGINS`.

**Bucket keys:** give the key read, write and delete on the one bucket only (the R2 token above does). On AWS S3 also grant list (`s3:ListBucket`): without it AWS answers 403 instead of 404 for a missing object, so forwarding a message whose file is gone fails with 500 instead of dropping that file. R2, B2 and MinIO answer 404 either way. Endpoints: R2 `https://<account id>.r2.cloudflarestorage.com`, B2 `https://s3.<region>.backblazeb2.com`, Supabase Storage `https://<project>.supabase.co/storage/v1/s3`, AWS `https://s3.<region>.amazonaws.com` (the regional one: the server does not follow S3's redirects).

**Serving files:** by default (`VOKKO_S3_SERVE=proxy`) downloads stream through vokko-server, which keeps the bucket private and the attachment URLs unchanged, at the cost of the server's bandwidth. With `presigned`, the server checks the attachment key exactly as before and redirects to a presigned bucket URL valid for `VOKKO_S3_PRESIGN_TTL_SECS` (default 300 s); file bytes then go straight from the bucket to the client, which helps on hosts with small egress allowances. Trade-offs of `presigned`:

- Every view signs a fresh URL and the redirect is not cacheable, so browsers do not cache attachments (proxy mode sends `max-age=86400`) and every view is a bucket read (an R2 Class B operation). The bucket's response also lacks the server's `X-Content-Type-Options: nosniff`.
- The URL shows the access key ID (not the secret) to every client: scope the key to this one bucket.
- Clients with a strict Content Security Policy cannot follow the redirect to another origin. The desktop app's CSP only allows images from its configured server, so use `proxy` if you serve desktop clients.

**What breaks when a free tier pauses:**

| Paused piece | Effect |
| --- | --- |
| Database (Neon allowance used up, Supabase paused) | Server start fails; a running server answers 503 on `/healthz` and most API calls fail. Websockets stay open but nothing new arrives. Fixes itself (Neon, next month) or after you restore the project (Supabase). |
| Bucket (R2 beyond the free allowance) | R2 needs a payment method on file and bills usage past the free allowance rather than blocking it; set a billing notification. If the bucket is unreachable or the key revoked, uploads and downloads fail while messages keep working. |
| Container host sleeping | Everyone disconnected, see the top of this page. |

**Backups:** the database is the part to protect.

- Neon: point-in-time restore on Free covers only a short window (hours); Supabase Free has no backups. Run `pg_dump` yourself, e.g. a scheduled GitHub Actions workflow in a private repo: `pg_dump -Fc "$DATABASE_URL" > vokko-$(date +%F).dump` and upload the file to the bucket (or keep it as a workflow artifact). Use a `pg_dump` at least as new as the server (Neon and Supabase run Postgres 15-17).
- Files: copy the bucket elsewhere now and then, e.g. `rclone sync r2:vokko b2:vokko-backup`. R2 itself is durable, but a deleted bucket or a leaked key is not something durability helps with.
- Restore: `pg_restore --no-owner -d "$DATABASE_URL" vokko-YYYY-MM-DD.dump` into an empty database, point the server at it, and keep the same bucket (rows reference objects by attachment id).

## Voice: LiveKit Cloud free

LiveKit Cloud's free "Build" plan (October 2026): 5,000 WebRTC participant-minutes per month shared across your free projects, at most 100 concurrent participants, hard cap (calls fail when it runs out; it does not bill you). 5,000 participant-minutes is about 83 person-hours a month, e.g. four people talking an hour a night for three weeks. Enough for a small group; a busy server will run out.

1. Create a project at cloud.livekit.io, then an API key under Settings > Keys.
2. Set `VOKKO_LIVEKIT_URL=wss://<project>.livekit.cloud`, `VOKKO_LIVEKIT_API_KEY`, `VOKKO_LIVEKIT_API_SECRET`.
3. Add a webhook (Settings > Webhooks) signed with the same key, pointing at `https://chat.example.com/internal/livekit/webhook`. With a self-hosted LiveKit that path stays off the reverse proxy; LiveKit Cloud has to reach it over the internet, so forward exactly that path (Caddy: add `/internal/livekit/webhook` to the `@vokko` matcher; requests without a valid signature get 401). The webhook is required: vokko-server drops a voice join that LiveKit does not confirm with `participant_joined` within 15 seconds.

When the allowance runs out, joining a voice channel fails until the month resets; text chat is unaffected.

## Choosing

- Can you get an Oracle A1 VM? Use recipe A: one machine, real disk, no compute-hour budget, backups are two commands.
- No VM: recipe B with Supabase (no compute-hour cap; 500 MB, and the weekly pause only hits abandoned servers), R2 for files, and an always-on host for the one container.
- Neon Free only for trying Vokko: an always-on server uses up its compute allowance in about two and a half weeks.
