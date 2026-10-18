# Backups

A Vokko server's state is two things: the Postgres database (users, messages, everything structured) and the server's
data dir, `VOKKO_DATA_DIR` (uploads under `attachments/`; with `VOKKO_STORAGE=s3` they live in the bucket instead, back that
up with the bucket's own versioning). `incoming/` only holds half-finished uploads and is skipped. Link-preview images
(`embed_media`) are proxied, never stored, so there is nothing else to save.

| Script | Does |
|---|---|
| `tools/backup.sh` | `pg_dump --format=custom` plus a tar of the data dir, verified, rotated (7 daily + 4 weekly), optional rsync off the machine |
| `tools/restore.sh <dir> --yes` | Replaces the database and the uploads with one backup |
| `tools/backup-test.sh` | End-to-end check against a throwaway database `vokko_test_backup` (seed, back up, drop, restore, compare row counts and files) |

## What a run does

1. `pg_dump` inside the compose `postgres` container (`docker compose exec -T postgres`, so the client matches the server's
   major version). It reads one snapshot: the dump is consistent while the server keeps running.
2. Tars the `vokko_vokko-data` volume through a throwaway `postgres:16` container (already on the machine). The dump comes
   first, so a file uploaded in between is at worst an orphan, never a row pointing at a missing file.
3. Verifies: `pg_restore --list` must list table data, and the archive must read to the end. A failed step exits non-zero
   and leaves nothing behind (each run writes to `.tmp-*` and is renamed only when verified).
4. Writes `$VOKKO_BACKUP_DIR/daily/<YYYYMMDD-HHMMSS>/{db.dump,data.tar.gz}`. When no weekly is younger than 7 days the run is
   also hard-linked into `weekly/`. Keeps the newest `VOKKO_BACKUP_DAILY` (7) and `VOKKO_BACKUP_WEEKLY` (4).
5. With `VOKKO_BACKUP_OFFSITE` set, `rsync -aH --delete` mirrors the whole backup dir there.

Environment: `VOKKO_BACKUP_DIR` (required), `VOKKO_BACKUP_COMPOSE_DIR` (default `deploy/` next to the script),
`VOKKO_BACKUP_DATA_VOLUME` (default `vokko_vokko-data`, the compose project name plus `_vokko-data`), `VOKKO_BACKUP_DAILY`,
`VOKKO_BACKUP_WEEKLY`, `VOKKO_BACKUP_OFFSITE`. Without Docker, set `VOKKO_BACKUP_DATABASE_URL` and `VOKKO_BACKUP_DATA_DIR`
and the local `pg_dump`/`pg_restore` (same major version as the server or newer) are used instead; that is the mode
`backup-test.sh` runs in.

## Nightly on macOS (launchd)

Example for a macOS host running the stack from a checkout of this repo (`<repo checkout>`) with the backup directory on a different disk than
the one holding the Docker volumes. Install once (the plist is a template in the repo, nothing installs it for you):

```sh
mkdir -p <backup dir> && chmod 700 <backup dir>
cp <repo checkout>/deploy/launchd/<backup plist> ~/Library/LaunchAgents/
$EDITOR ~/Library/LaunchAgents/<backup plist>   # REPLACE_ME: your user name, paths and the off-machine target
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<backup plist>
launchctl kickstart gui/$(id -u)/<backup label>        # first run now
tail ~/Library/Logs/vokko-backup.log
```

The example plist in `deploy/launchd/` (label `org.vokko.vokko-backup`; copy and edit it) runs
`tools/backup.sh` every day at 04:00 (a run missed while the Mac slept starts on wake) and logs to
`~/Library/Logs/vokko-backup.log`. The checkout must be on a commit that has `tools/backup.sh`. If the log shows
`Operation not permitted` on an external volume, give `/bin/bash` access to removable volumes (System Settings > Privacy &
Security > Files and Folders, or Full Disk Access).

On Linux use a systemd timer or cron entry that runs `tools/backup.sh` with the same environment.

A day's backup of the current server is well under 200 MB (database ~70 MB on disk, uploads ~60 MB, before compression),
so 11 kept sets fit easily.

## Off the machine

A second local disk survives the first one dying, not a fire, theft or a bad `rm`. Keep a second copy elsewhere:

- **The VPS** (simplest): set `VOKKO_BACKUP_OFFSITE` to `<ssh host>:backups/vokko`. The backup user needs a key login to
  that host without a passphrase (launchd has no ssh agent); use a dedicated key for it.
- **Object storage** (Backblaze B2, Cloudflare R2, S3): `rclone sync <backup dir> remote:vokko-backups`
  from a second launchd job or by mounting the remote and pointing `VOKKO_BACKUP_OFFSITE` at it. Use an `rclone crypt`
  remote: dumps contain password hashes, emails and every message.
- **Time Machine** to a disk that leaves the house also covers the backup directory if its volume is not excluded.

## Restore

```sh
cd <repo checkout>
tools/restore.sh <backup dir>/daily/<stamp> --yes
```

It checks both files first, stops `server`, drops and recreates the `vokko` database (so tables from a newer migration don't
survive next to the old ones), `pg_restore --single-transaction --exit-on-error`, replaces the volume's contents (owner
kept, uid 10001), and starts `server` again. Restore with the server image the backup came from or newer: a newer server
runs its migrations on start, an older one doesn't know the newer tables.

Test a restore before you rely on it: `tools/backup-test.sh` with `VOKKO_TEST_ADMIN_URL=postgres://user:pass@host/postgres`
(a user with CREATEDB) does the whole loop against `vokko_test_backup` and drops it again.
