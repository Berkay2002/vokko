# vokko-loadtest

Load generator for `vokko-server`: registers N users, builds guilds, opens N gateway connections (Hello → Identify → READY,
heartbeats on the server's interval) and runs REST + gateway scenarios while sampling CPU/RSS of the server and Postgres from
`/proc`. The write-up of the first run is `docs/audits/load-2026-10.md`; raw numbers are in `results/2026-10/`.

Throwaway databases and local servers only: every user gets the fixed password `loadtest-pass-1`, and `VOKKO_TRUST_PROXY=on`
lets any client pick its own address, so never set it on a server reachable from outside.

```sh
export DATABASE_URL=postgres://vokko:vokko@127.0.0.1:5432/vokko_load     # a fresh database
VOKKO_TRUST_PROXY=on VOKKO_UNFURL=off cargo run --release -p vokko-server &
cargo run --release -p vokko-loadtest -- --connections 200 --server-pid $(pgrep -x vokko-server) --sample-postgres --out run.json
```

`--help` lists every option. Scenarios (`--scenarios`, default all, always preceded by setup + connect):

| name | what it does | measures |
| --- | --- | --- |
| `connect` | every user opens a gateway connection | `identify_ready`, `ws_connect`, READY size, presence fan-out received |
| `send` | a share of each guild posts into random channels; the content carries the send time | `rest:send_message`, `delivery:message` (send → MESSAGE_CREATE at every member), delivery ratio |
| `typing` | synchronized `POST /channels/{id}/typing` bursts, one per typer per second | `rest:typing`, delivery ratio |
| `presence` | op 3 updates (3 per session + a clearing one) with the send time in `custom_status` | `delivery:presence`, delivery ratio |
| `dm` | a share of users opens a DM with the next guild member and posts `dm <send time>` at `--send-rate` | `rest:open_dm`, `rest:send_dm`, `delivery:dm`, delivery ratio |
| `reactions` | reactors post one message, then add and remove 👍 on it once per second (the add is stamped by message id) | `rest:reaction_add`, `delivery:reaction`, delivery ratio |
| `voice` | voice users join the guild's voice channel (op 4), stay 2 s, leave, repeat; needs LiveKit configured (`run.sh` points it at a dead port: tokens are signed locally) | `voice:join_server_update`, `delivery:voice_state`, delivery ratio |
| `history` | readers page a channel backwards, 100 per page | `rest:history_page` |
| `reconnect` | a share of the connections is cut without a close frame, stays away, then Resumes while messages keep flowing | `resume`, `seq_out_of_order`, `seq_skips`, delivery ratio |

`--pg-url` resets `pg_stat_statements` before every scenario and stores its top statements per scenario in the report (the
cluster needs `shared_preload_libraries = 'pg_stat_statements'`). `run.sh` does a whole run on a fresh database and `compare.py`
turns reports into a Markdown table; the commands are in `docs/load-test.md`.

Respecting the server's limits (docs/api.md "Limits and abuse controls"): sends are capped at 5/s per user, typing at 1/s,
history at ~6/s, op 3 at 4 per session, Identify once per session (storms use Resume). Every 429 and every gateway 4008 is
counted as `limit_hits`, listed per scenario and called out at the end of the run: those numbers measure the limiter, not
the server. The per-address limits (`/auth/*` burst 10 then 1 per 2 s, 16 unidentified sockets per address) cannot be
satisfied by one machine, so by default each simulated client sends its own `X-Forwarded-For` address; that needs the server
to run with `VOKKO_TRUST_PROXY=on` (the documented setting for running behind a proxy). `--no-spoof` shows what the limits do
otherwise (registration waits out the 429s).

Delivery latency is measured inside one process (monotonic clock, send time stamped into the message), so it includes the
load generator's own scheduling delay. On a machine where the generator shares cores with the server, read it as an upper bound.
