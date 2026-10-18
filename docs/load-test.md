# Server load test

How to run the repeatable load test against `vokko-server` (tool: `tools/loadtest`, scenarios in its README), and what the
October 2026 A/B run found. The first audit with the same tool is `docs/audits/load-2026-10.md`.

## What a run does

`tools/loadtest/run.sh` recreates a database, starts the given server binary on `127.0.0.1:$PORT` from a temp directory (so no
`.env.dev` is picked up), waits for `/healthz`, runs `vokko-loadtest`, then stops the server and prints its distinct errors.
`vokko-loadtest` registers N users, puts them in guilds of 100 (3 text channels and a voice channel each), opens one gateway
connection per user and runs: connect, send, typing, presence, dm, reactions, voice, history, reconnect. The report JSON has,
per scenario, p50/p95/p99 of every REST call and gateway fan-out (send time → event at every receiver), delivery ratios, server
and Postgres CPU/RSS from `/proc`, and the top `pg_stat_statements` entries (reset before each scenario).

Voice joins need a LiveKit config: `run.sh` points the server at `ws://127.0.0.1:1479`, where nothing listens. Tokens are signed
locally, so op 4 → VOICE_SERVER_UPDATE / VOICE_STATE_UPDATE works; the `LiveKit RemoveParticipant` / `ListRooms` warnings the
script prints afterwards are expected.

## Setup (once)

A Postgres cluster with `pg_stat_statements` preloaded. On a shared box, use a private cluster rather than restarting the shared
one (Postgres 18 from apt; any port works, these are the defaults `run.sh` expects):

```sh
PG=/usr/lib/postgresql/18/bin
mkdir -p ~/loadtest-pg && $PG/initdb -D ~/loadtest-pg/data -U vokko --auth=trust
cat >> ~/loadtest-pg/data/postgresql.conf <<'EOF'
port = 1475
listen_addresses = '127.0.0.1'
unix_socket_directories = '/home/<you>/loadtest-pg'
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
max_connections = 200
EOF
$PG/pg_ctl -D ~/loadtest-pg/data -l ~/loadtest-pg/pg.log start
cargo build --release -p vokko-server -p vokko-loadtest
```

Stop it afterwards with `$PG/pg_ctl -D ~/loadtest-pg/data stop`. Without `--pg-url` (or with a cluster that lacks the preload)
the report simply has no query table.

## Commands

One run (database `vokko_test_load`, server on 1474, 200 clients, 20 s per scenario):

```sh
PG_DATA=~/loadtest-pg/data tools/loadtest/run.sh target/release/vokko-server 200 run-200.json --duration 20 --label "main 200"
```

`PG_URL` (default `postgres://vokko@127.0.0.1:1475/postgres`), `DB`, `PORT` and `LOADTEST` override the defaults; `PG_DATA`
(or `PG_PID`) restricts Postgres sampling to that cluster's processes. Anything after the output path goes to `vokko-loadtest`
(`--help` lists it all; `--everyone-share 0.2` makes a fifth of the messages mention @everyone).

Before/after: build both binaries, then alternate them at each size so both see the same machine load:

```sh
for n in 20 50 200; do for b in base fix; do
  PG_DATA=~/loadtest-pg/data tools/loadtest/run.sh ./vokko-server.$b $n $b-$n.json --duration 20 --label "$b $n"
done; done
python3 tools/loadtest/compare.py base-20.json fix-20.json base-50.json fix-50.json base-200.json fix-200.json
```

`compare.py` prints a Markdown table (latencies per scenario, server CPU ms / PG ms / queries per send and per typing request,
RSS peak, worst delivery ratio and error count). The top statements per scenario are in each report under `scenarios[].queries`.

## Results, October 2026

Machine: the shared 4-vCPU / 15 GB VPS, with Postgres 18.6, server, and generator on the same cores, while other jobs kept the
load average between 10 and 27. Absolute numbers are therefore noisy; read the per-request CPU, query count and RSS rows, which
are steadier than the latencies. Base is main at c77b318b; fix is this branch. Raw reports: `tools/loadtest/results/2026-10-ab/`.
Every run delivered every event (ratio 1.000) with 0 errors and 0 limit hits.

| metric (p50 / p95 ms) | base 20 | fix 20 | base 50 | fix 50 | base 200 | fix 200 | base 200 @everyone | fix 200 @everyone |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| identify → READY | 108 / 111 | 168 / 171 | 163 / 183 | 163 / 178 | 516 / 581 | 384 / 419 | 407 / 501 | 458 / 531 |
| send REST | 26.8 / 59.6 | 16.2 / 45.7 | 18.3 / 48.5 | 18.3 / 51.4 | 21.2 / 67.1 | 17.2 / 45.7 | 26.1 / 61.4 | 18.3 / 35 |
| send → MESSAGE_CREATE at every member | 26.8 / 61.4 | 16.2 / 45.7 | 18.3 / 48.5 | 18.8 / 51.4 | 21.2 / 69.1 | 17.7 / 59.6 | 28.5 / 65.2 | 20 / 45.7 |
| typing REST (synchronized burst) | 10.1 / 28.5 | 8.99 / 19.4 | 17.7 / 32.1 | 15.3 / 23.2 | 98.6 / 154 | 85 / 121 | 87.6 / 189 | 71.2 / 125 |
| op 3 → PRESENCE_UPDATE | 4.98 / 22.5 | 6.12 / 17.2 | 5.44 / 23.2 | 6.31 / 53 | 5.94 / 18.3 | 7.99 / 41.8 | 6.89 / 34 | 5.77 / 11.4 |
| DM send → MESSAGE_CREATE | 14.4 / 40.6 | 18.8 / 51.4 | 18.8 / 54.6 | 20 / 232 | 69.1 / 206 | 90.2 / 163 | 75.5 / 121 | 73.3 / 98.6 |
| reaction add → MESSAGE_REACTION_ADD | 14 / 32.1 | 15.3 / 57.9 | 12.1 / 35 | 10.7 / 57.9 | 13.6 / 47.1 | 16.7 / 57.9 | 11.4 / 22.5 | 11.1 / 21.8 |
| op 4 join → VOICE_STATE_UPDATE at members | 10.1 / 25.5 | 19.4 / 67.9 | 9.54 / 19.4 | 11.4 / 32.1 | 16.7 / 38.3 | 10.1 / 22.5 | 13.6 / 27.6 | 10.1 / 16.2 |
| history page (100) | 20.6 / 22.3 | 14 / 14.6 | 20.6 / 24.4 | 20 / 22.6 | 67.1 / 98.6 | 45.7 / 102 | 63.3 / 98.6 | 82.5 / 121 |
| **resume, dial → RESUMED** | 51.4 / 51.8 | 9.26 / 11.8 | 59.6 / 63.8 | 17.2 / 23.2 | 219 / 286 | 67.1 / 105 | 136 / 189 | 57.9 / 82.2 |
| **send: server CPU ms / PG ms / queries** | 5.60 / 1.55 / 32 | 5.24 / 1.13 / 32 | 7.00 / 1.36 / 32 | 6.62 / 1.02 / 32 | 9.81 / 2.58 / 32 | 8.99 / 1.93 / 32 | 10.3 / 2.31 / 49 | 8.06 / 1.74 / 32 |
| typing: server CPU ms / PG ms / queries | 2.38 / 0.29 / 13 | 2.14 / 0.30 / 13 | 2.98 / 0.27 / 13 | 2.60 / 0.22 / 13 | 4.21 / 0.27 / 13 | 4.17 / 0.30 / 13 | 3.90 / 0.36 / 13 | 3.23 / 0.28 / 13 |
| **server RSS peak (MiB)** | 124 | 122 | 149 | 134 | 292 | 218 | 295 | 200 |

A second interleaved series (r3, not committed) showed the same pattern: resume 51 → 13, 63 → 24 ms; RSS at 200 291 → 219 MiB;
CPU per send 5-7 % lower. Single-scenario latency differences under ±30 % flip sign between series and are noise.

## Bottlenecks found

| finding | evidence | change |
| --- | --- | --- |
| Every gateway event was serialized once per receiving session, and each session's replay buffer (1000 entries) kept its own copy of the full JSON frame | RSS grew with clients × events; CPU per send rose with fan-out | **Fixed** (`hub.rs`): an event is serialized once into a shared `Arc<Event>`; each session stores the `Arc` with its own sequence number and builds the frame (`{"op":0,"d":…,"s":…,"t":…}`) when it writes. READY is no longer kept in the replay buffer. Messages without reactions or polls (the same for every viewer) take this path too (`store.rs`). RSS at 200 clients −25 to −32 %, resume 2-5× faster (likely because the replay and the session queues no longer hold per-session copies). |
| The gateway writer flushed the socket after every frame | one write syscall per event under fan-out | **Fixed** (`gateway.rs`): up to 64 queued frames are written, then flushed once. |
| Mentions and @everyone wrote one row per mentioned user, role and notified member (`read_states` mention counters) | @everyone: 49 queries per send instead of 32 | **Fixed** (`routes/messages.rs`): one `INSERT … SELECT UNNEST($n::bigint[])` per table; the `read_states` user ids are sorted so concurrent sends lock rows in the same order. 49 → 32 queries, CPU per send −22 %. |
| `channels.last_message_id` was set to the id of whichever concurrent send ran its UPDATE last, which need not be the newest message | race between overlapping sends into one channel | **Fixed**: `GREATEST(last_message_id, $2)`; test `concurrent_sends_keep_the_newest_last_message`. |
| The `UPDATE channels` row lock is the top statement by time in every send window (0.8-1 ms mean, ~40 % of PG time at 200 clients): every send into a channel waits for the previous sender's commit | `pg_stat_statements` | **Not fixed.** Taking the lock last instead of first (just before commit) was tried: no measurable change, because the wait is the other transaction's commit (WAL flush), and it needs a special case for threads and mention sends to avoid deadlocks. Reverted. The real fix is to stop writing the channel row on every message (derive `last_message_id` from `messages`, or update it outside the transaction), which changes the read path; left for a follow-up. |
| Permission checks read the members, member roles and timeouts in three queries per message/typing event | 13 queries per typing request | **Not fixed.** One `array_agg … GROUP BY` query was tried: 2 fewer queries, but more PG time per request (0.24 ms vs ~0.14 ms for the three), so it was reverted. |
| Connect: `build_ready` loads each guild with a separate query; `user_audience` runs twice per connect | READY p50 grows with guild count | Not fixed (connect is a one-off per session; not the bottleneck here). |

No missing index showed up: every hot statement is an index lookup (mean ≤ 0.25 ms apart from the channel UPDATE and the message
INSERT).
