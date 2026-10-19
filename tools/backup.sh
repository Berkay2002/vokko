#!/usr/bin/env bash
# Back up a Vokko server: a pg_dump (custom format) plus the server data dir (uploads), verified and rotated.
# Docs: docs/backups.md. Runs on macOS bash 3.2.
#
#   VOKKO_BACKUP_DIR=/srv/backups/vokko tools/backup.sh
#
# Environment:
#   VOKKO_BACKUP_DIR           required: where backups go (daily/ and weekly/ under it)
#   VOKKO_BACKUP_COMPOSE_DIR   the deploy/ dir of the compose stack (default: deploy/ next to this script)
#   VOKKO_BACKUP_DATA_VOLUME   the server's data volume (default: vokko_vokko-data)
#   VOKKO_BACKUP_DATABASE_URL  set to skip docker: dump this database with the local pg_dump instead ...
#   VOKKO_BACKUP_DATA_DIR      ... and tar this directory instead of the volume
#   VOKKO_BACKUP_DAILY=7 VOKKO_BACKUP_WEEKLY=4   how many of each to keep
#   VOKKO_BACKUP_OFFSITE       optional rsync destination (host:path or a mounted path), mirrored after every run
#                              (refused when local has under half the offsite sets: a missing or wiped backup disk)
set -euo pipefail

: "${VOKKO_BACKUP_DIR:?set VOKKO_BACKUP_DIR to the backup destination}"
COMPOSE_DIR=${VOKKO_BACKUP_COMPOSE_DIR:-$(cd "$(dirname "$0")/../deploy" && pwd)}
VOLUME=${VOKKO_BACKUP_DATA_VOLUME:-vokko_vokko-data}
URL=${VOKKO_BACKUP_DATABASE_URL:-}
DAILY=${VOKKO_BACKUP_DAILY:-7}
WEEKLY=${VOKKO_BACKUP_WEEKLY:-4}

# Postgres client tools run inside the compose postgres container (same major version as the server), or locally with a URL.
pg() {
    if [ -n "$URL" ]; then "$@"; else docker compose --project-directory "$COMPOSE_DIR" exec -T postgres "$@"; fi
}
db_args() {
    if [ -n "$URL" ]; then echo "--dbname=$URL"; else echo "--username=vokko --dbname=vokko"; fi
}

stamp=$(date +%Y%m%d-%H%M%S)
mkdir -p "$VOKKO_BACKUP_DIR/daily" "$VOKKO_BACKUP_DIR/weekly"
tmp="$VOKKO_BACKUP_DIR/daily/.tmp-$stamp"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp"

# pg_dump reads one snapshot, so the dump is consistent while the server keeps running. Dump first, files second:
# a file uploaded in between is at worst an orphan, never a row pointing at a missing file.
# shellcheck disable=SC2046 # db_args splits into flags on purpose
pg pg_dump --format=custom --no-owner $(db_args) >"$tmp/db.dump"

if [ -n "$URL" ]; then
    tar -C "${VOKKO_BACKUP_DATA_DIR:?set VOKKO_BACKUP_DATA_DIR with VOKKO_BACKUP_DATABASE_URL}" --exclude=./incoming --exclude=./embed-media -czf "$tmp/data.tar.gz" .
else
    # The postgres:16 image is already on the machine and has GNU tar; incoming/ only holds half-finished uploads and
    # embed-media/ is the disposable link-preview cache.
    docker run --rm -v "$VOLUME:/data:ro" postgres:16 tar -C /data --exclude=./incoming --exclude=./embed-media -czf - . >"$tmp/data.tar.gz"
fi

# Verify: the dump's table of contents must list table data, and the archive must read to the end.
entries=$(pg pg_restore --list <"$tmp/db.dump" | grep -c "TABLE DATA" || true)
[ "$entries" -gt 0 ] || { echo "backup: $tmp/db.dump has no TABLE DATA entries" >&2; exit 1; }
tar -tzf "$tmp/data.tar.gz" >/dev/null

mv "$tmp" "$VOKKO_BACKUP_DIR/daily/$stamp"
trap - EXIT
echo "backup: $VOKKO_BACKUP_DIR/daily/$stamp ($entries tables, $(du -sh "$VOKKO_BACKUP_DIR/daily/$stamp" | cut -f1))"

# Weekly: promote this run when no weekly is younger than 7 days (survives skipped days, unlike "on Sundays").
if [ -z "$(find "$VOKKO_BACKUP_DIR/weekly" -mindepth 1 -maxdepth 1 -type d -mtime -7)" ]; then
    mkdir "$VOKKO_BACKUP_DIR/weekly/$stamp"
    for f in db.dump data.tar.gz; do
        ln "$VOKKO_BACKUP_DIR/daily/$stamp/$f" "$VOKKO_BACKUP_DIR/weekly/$stamp/$f" 2>/dev/null ||
            cp "$VOKKO_BACKUP_DIR/daily/$stamp/$f" "$VOKKO_BACKUP_DIR/weekly/$stamp/$f"
    done
    echo "backup: promoted to weekly/$stamp"
fi

# Rotate: names sort by time, keep the newest N of each.
prune() {
    find "$1" -mindepth 1 -maxdepth 1 -type d -name '2*' | sort -r | tail -n +"$(($2 + 1))" | while read -r old; do
        rm -rf "$old"
        echo "backup: pruned $old"
    done
}
prune "$VOKKO_BACKUP_DIR/daily" "$DAILY"
prune "$VOKKO_BACKUP_DIR/weekly" "$WEEKLY"

if [ -n "${VOKKO_BACKUP_OFFSITE:-}" ]; then
    # --delete mirrors the rotation, but would also mirror a loss: an unmounted or wiped backup dir leaves only this
    # run's set locally, and the sync would delete every older set offsite. Refuse when local has under half of offsite.
    sets() { find "$VOKKO_BACKUP_DIR/daily" "$VOKKO_BACKUP_DIR/weekly" -mindepth 1 -maxdepth 1 -type d -name '2*' | wc -l; }
    offsite_sets() {
        for d in daily weekly; do rsync --list-only "$VOKKO_BACKUP_OFFSITE/$d/" 2>/dev/null || true; done |
            awk '$1 ~ /^d/ && $NF ~ /^2/' | wc -l
    }
    here=$(sets)
    there=$(offsite_sets)
    if [ $((here * 2)) -lt "$there" ]; then
        echo "backup: NOT syncing to $VOKKO_BACKUP_OFFSITE: $here local sets but $there offsite (is $VOKKO_BACKUP_DIR the right, mounted disk?)." >&2
        echo "backup: if the loss is intended, sync by hand: rsync -aH --delete $VOKKO_BACKUP_DIR/ $VOKKO_BACKUP_OFFSITE/" >&2
        exit 1
    fi
    # -H keeps the daily/weekly hard links as one copy.
    rsync -aH --delete "$VOKKO_BACKUP_DIR/" "$VOKKO_BACKUP_OFFSITE/"
    echo "backup: synced to $VOKKO_BACKUP_OFFSITE"
fi
