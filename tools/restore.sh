#!/usr/bin/env bash
# Restore a backup made by tools/backup.sh: REPLACES the database and the uploads. Docs: docs/backups.md.
#
#   tools/restore.sh <backup dir>/daily/20261018-040000 --yes
#
# Uses the same environment as backup.sh (VOKKO_BACKUP_COMPOSE_DIR, VOKKO_BACKUP_DATA_VOLUME, or
# VOKKO_BACKUP_DATABASE_URL + VOKKO_BACKUP_DATA_DIR). With compose it stops the server, restores, and starts it again.
set -euo pipefail

src=${1:?usage: restore.sh <backup dir> --yes}
[ "${2:-}" = "--yes" ] || { echo "restore: this drops the current database and uploads; rerun with --yes" >&2; exit 2; }
[ -f "$src/db.dump" ] && [ -f "$src/data.tar.gz" ] || { echo "restore: $src needs db.dump and data.tar.gz" >&2; exit 1; }

COMPOSE_DIR=${VOKKO_BACKUP_COMPOSE_DIR:-$(cd "$(dirname "$0")/../deploy" && pwd)}
VOLUME=${VOKKO_BACKUP_DATA_VOLUME:-vokko_vokko-data}
URL=${VOKKO_BACKUP_DATABASE_URL:-}

pg() {
    if [ -n "$URL" ]; then "$@"; else docker compose --project-directory "$COMPOSE_DIR" exec -T postgres "$@"; fi
}

# Check the dump before touching anything.
pg pg_restore --list <"$src/db.dump" >/dev/null
tar -tzf "$src/data.tar.gz" >/dev/null

if [ -n "$URL" ]; then
    db=${URL##*/}
    db=${db%%\?*}
    conn=(--maintenance-db="${URL%/*}/postgres")
    target=(--dbname="$URL")
else
    docker compose --project-directory "$COMPOSE_DIR" stop server
    db=vokko
    conn=(--username=vokko)
    target=(--username=vokko --dbname=vokko)
fi

# A fresh database, so tables added by newer migrations don't survive next to the restored ones.
# --force needs rights over every session (a non-superuser can't end autovacuum's); plain DROP DATABASE stops autovacuum itself.
pg dropdb "${conn[@]}" --if-exists --force "$db" 2>/dev/null || pg dropdb "${conn[@]}" --if-exists "$db"
pg createdb "${conn[@]}" "$db"
pg pg_restore --no-owner --exit-on-error --single-transaction "${target[@]}" <"$src/db.dump"

if [ -n "$URL" ]; then
    dir=${VOKKO_BACKUP_DATA_DIR:?set VOKKO_BACKUP_DATA_DIR with VOKKO_BACKUP_DATABASE_URL}
    mkdir -p "$dir"
    find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    tar -C "$dir" -xzf "$src/data.tar.gz"
else
    # Running as root inside the container keeps the archived owner (the server's uid 10001).
    docker run --rm -i -v "$VOLUME:/data" postgres:16 sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -C /data -xzf -' \
        <"$src/data.tar.gz"
    docker compose --project-directory "$COMPOSE_DIR" start server
fi
echo "restore: $src restored into $db"
