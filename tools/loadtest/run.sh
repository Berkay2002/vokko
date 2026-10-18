#!/usr/bin/env bash
# One measured run on a fresh database: start vokko-server, run vokko-loadtest against it, stop the server.
#   tools/loadtest/run.sh <server-binary> <clients> <out.json> [extra vokko-loadtest options]
# Environment (defaults in brackets):
#   PG_URL      admin URL of a cluster with pg_stat_statements preloaded [postgres://vokko@127.0.0.1:1475/postgres]
#   PG_PID      postmaster PID of that cluster, so only its processes are sampled [read from $PG_DATA/postmaster.pid]
#   DB          database to recreate for the run [vokko_test_load]
#   PORT        server port on 127.0.0.1 [1474]
#   LOADTEST    vokko-loadtest binary [target/release/vokko-loadtest]
set -euo pipefail
server=$1 clients=$2 out=$3
shift 3
PG_URL=${PG_URL:-postgres://vokko@127.0.0.1:1475/postgres}
DB=${DB:-vokko_test_load}
PORT=${PORT:-1474}
LOADTEST=${LOADTEST:-target/release/vokko-loadtest}
db_url=${PG_URL%/*}/$DB
if [ -z "${PG_PID:-}" ] && [ -n "${PG_DATA:-}" ]; then PG_PID=$(head -1 "$PG_DATA/postmaster.pid"); fi

psql "$PG_URL" -Xq -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
data=$(mktemp -d)
# A LiveKit backend nobody listens on: op 4 joins get signed tokens; the client never dials it.
# Run from the data dir so no .env.dev up the tree is picked up.
(cd "$data" && DATABASE_URL=$db_url VOKKO_BIND=127.0.0.1:$PORT VOKKO_DATA_DIR=$data VOKKO_TRUST_PROXY=on VOKKO_UNFURL=off \
  VOKKO_LIVEKIT_URL=ws://127.0.0.1:1479 VOKKO_LIVEKIT_API_KEY=loadtest VOKKO_LIVEKIT_API_SECRET=loadtest-secret-loadtest-secret \
  RUST_LOG=warn exec "$server" >"$data/server.log" 2>&1) &
pid=$!
trap 'kill $pid 2>/dev/null; wait $pid 2>/dev/null || true; rm -rf "$data"; exit 0' EXIT
for _ in $(seq 100); do curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 0.2; done
"$LOADTEST" --url "http://127.0.0.1:$PORT" --connections "$clients" --server-pid "$pid" --sample-postgres ${PG_PID:+--postgres-pid $PG_PID} \
  --pg-url "$db_url" --out "$out" "$@"
# server errors, without colours and timestamps so repeats collapse
sed -E 's/\x1b\[[0-9;]*m//g; s/^[^ ]+ //' "$data/server.log" | grep -iE "panic|error" | sort | uniq -c | sort -rn | head -5 || true
