#!/usr/bin/env bash
# End-to-end check of backup.sh + restore.sh against a throwaway database (never the live one):
# seed the server schema plus data, back up, drop, restore, compare row counts and files.
#
#   VOKKO_TEST_ADMIN_URL=postgres://user:pass@localhost/postgres tools/backup-test.sh
#
# The user in the URL needs CREATEDB. Creates and drops the database vokko_test_backup.
set -euo pipefail

admin=${VOKKO_TEST_ADMIN_URL:?set VOKKO_TEST_ADMIN_URL to a maintenance-db URL (…/postgres)}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
url="${admin%/*}/vokko_test_backup"
export PGOPTIONS='-c client_min_messages=warning'
trap 'dropdb --maintenance-db="$admin" --if-exists vokko_test_backup; rm -rf "$work"' EXIT

counts() {
    psql "$url" -Atc "select string_agg(format('select %L, count(*) from %I', tablename, tablename), ' union all ' order by tablename)
                      from pg_tables where schemaname = 'public'" | psql "$url" -At
}

dropdb --maintenance-db="$admin" --if-exists vokko_test_backup
createdb --maintenance-db="$admin" vokko_test_backup
for m in "$here"/../crates/server/migrations/*.sql; do psql "$url" -q -v ON_ERROR_STOP=1 -f "$m"; done
psql "$url" -q -v ON_ERROR_STOP=1 -c "create table backup_probe (id bigint primary key, body bytea);
    insert into backup_probe select g, sha256(g::text::bytea) from generate_series(1, 5000) g;
    insert into users (id, username, email, password_hash) select g, 'u' || g, g || '@test', 'x' from generate_series(1, 50) g;
    insert into guilds (id, name, owner_id) select g, 'guild ' || g, g from generate_series(1, 10) g;"
mkdir -p "$work/data/attachments/1" "$work/data/incoming"
head -c 100000 /dev/urandom >"$work/data/attachments/1/a.bin"
echo partial >"$work/data/incoming/skip-me"

before=$(counts)
export VOKKO_BACKUP_DATABASE_URL=$url VOKKO_BACKUP_DATA_DIR=$work/data VOKKO_BACKUP_DIR=$work/backups VOKKO_BACKUP_DAILY=2
for _ in 1 2 3; do "$here/backup.sh" && sleep 1; done
[ "$(ls "$work/backups/daily" | wc -l)" -eq 2 ] || { echo "FAIL: rotation kept $(ls "$work/backups/daily")" >&2; exit 1; }
[ "$(ls "$work/backups/weekly" | wc -l)" -eq 1 ] || { echo "FAIL: weekly has $(ls "$work/backups/weekly")" >&2; exit 1; }

sum=$(cksum <"$work/data/attachments/1/a.bin")
psql "$url" -q -c "drop table backup_probe; truncate users cascade"
rm -rf "$work/data"/*
"$here/restore.sh" "$(find "$work/backups/daily" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)" --yes

after=$(counts)
[ "$before" = "$after" ] || { diff <(echo "$before") <(echo "$after") >&2; echo "FAIL: row counts differ" >&2; exit 1; }
[ "$(cksum <"$work/data/attachments/1/a.bin")" = "$sum" ] || { echo "FAIL: attachment differs" >&2; exit 1; }
[ ! -e "$work/data/incoming" ] || { echo "FAIL: incoming/ was backed up" >&2; exit 1; }
echo "PASS: $(echo "$after" | wc -l) tables, $(echo "$after" | awk -F'|' '{s += $2} END {print s}') rows and the uploads restored"
