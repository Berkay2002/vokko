#!/usr/bin/env bash
# Runs the opt-in storage and TLS tests (crates/server/tests/storage.rs) against throwaway containers:
# MinIO as the S3-compatible bucket and a Postgres 16 with ssl=on (Debian's self-signed snakeoil certificate).
# Needs Docker and TEST_DATABASE_URL (environment or .env.dev) like the rest of the server tests. Removes the containers on exit.
#   deploy/selfhost-check.sh                    # ports 59000 (MinIO) and 55433 (Postgres) on 127.0.0.1
set -euo pipefail
# Git Bash on Windows would otherwise rewrite the container paths below into Windows paths (only for docker: cargo needs them).
docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }

MINIO_PORT="${MINIO_PORT:-59000}"
PG_PORT="${PG_PORT:-55433}"
SUFFIX="$$"
MINIO="vokko-check-minio-$SUFFIX"
PG="vokko-check-pg-$SUFFIX"
cleanup() { docker rm -f "$MINIO" "$PG" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Throwaway credentials, fresh every run.
random_hex() { od -An -N12 -tx1 /dev/urandom | tr -d ' \n'; }
S3_USER="vokko$(random_hex)"
S3_SECRET="$(random_hex)"
PG_SECRET="$(random_hex)"

# MinIO no longer publishes images on Docker Hub; Chainguard's build is public. Override with MINIO_IMAGE.
docker run -d --name "$MINIO" -p "127.0.0.1:$MINIO_PORT:9000" \
  -e MINIO_ROOT_USER="$S3_USER" -e MINIO_ROOT_PASSWORD="$S3_SECRET" \
  "${MINIO_IMAGE:-cgr.dev/chainguard/minio:latest}" server /data >/dev/null
docker run -d --name "$PG" -p "127.0.0.1:$PG_PORT:5432" -e POSTGRES_PASSWORD="$PG_SECRET" postgres:16 \
  -c ssl=on -c ssl_cert_file=/etc/ssl/certs/ssl-cert-snakeoil.pem -c ssl_key_file=/etc/ssl/private/ssl-cert-snakeoil.key >/dev/null

for _ in $(seq 60); do
  if docker exec "$PG" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$MINIO_PORT/minio/health/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# The bucket; curl (7.75+) signs the request itself.
curl -fsS -X PUT --aws-sigv4 "aws:amz:us-east-1:s3" --user "$S3_USER:$S3_SECRET" "http://127.0.0.1:$MINIO_PORT/vokko-test" >/dev/null

export VOKKO_TEST_S3_ENDPOINT="http://127.0.0.1:$MINIO_PORT"
export VOKKO_TEST_S3_BUCKET=vokko-test
export VOKKO_TEST_S3_ACCESS_KEY_ID="$S3_USER"
export VOKKO_TEST_S3_SECRET_ACCESS_KEY="$S3_SECRET"
export VOKKO_TEST_TLS_DATABASE_URL="postgres://postgres:$PG_SECRET@127.0.0.1:$PG_PORT/postgres"
cargo test -p vokko-server --test storage -- --nocapture "$@"
