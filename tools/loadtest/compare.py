#!/usr/bin/env python3
"""Markdown table of vokko-loadtest JSON reports, one column per file: compare.py before-20.json after-20.json ..."""
import json
import sys

# (scenario, histogram, label)
LATENCIES = [
    ("connect", "identify_ready", "identify → READY"),
    ("send", "rest:send_message", "send REST"),
    ("send", "delivery:message", "send → MESSAGE_CREATE at every member"),
    ("typing", "rest:typing", "typing REST (synchronized burst)"),
    ("presence", "delivery:presence", "op 3 → PRESENCE_UPDATE"),
    ("dm", "rest:send_dm", "DM send REST"),
    ("dm", "delivery:dm", "DM send → MESSAGE_CREATE"),
    ("reactions", "rest:reaction_add", "reaction add REST"),
    ("reactions", "delivery:reaction", "reaction add → MESSAGE_REACTION_ADD"),
    ("voice", "voice:join_server_update", "op 4 join → VOICE_SERVER_UPDATE"),
    ("voice", "delivery:voice_state", "op 4 join → VOICE_STATE_UPDATE at members"),
    ("history", "rest:history_page", "history page (100)"),
    ("reconnect", "resume", "resume, dial → RESUMED"),
]


def scenario(report, name):
    return next((s for s in report["scenarios"] if s["name"] == name), None)


def latency(report, name, hist):
    s = scenario(report, name)
    h = s and s.get("histograms", {}).get(hist)
    if not h or not h["count"]:
        return "-"
    return " / ".join(f"{h[k] / 1000:.3g}" for k in ("p50", "p95", "p99"))


def per_message(report, name, hist):
    """Server CPU ms, Postgres execution ms and statements per request of `hist` in one scenario window."""
    s = scenario(report, name)
    if not s:
        return "-"
    sent = s.get("histograms", {}).get(hist, {}).get("count", 0)
    cpu = (s["resources"].get("server") or {}).get("cpu_avg", 0)
    if not sent:
        return "-"
    server_ms = cpu / 100 * s["seconds"] * 1000 / sent
    pg_ms = sum(q["total_ms"] for q in s.get("queries", [])) / sent
    calls = sum(q["calls"] for q in s.get("queries", [])) / sent
    return f"{server_ms:.2f} / {pg_ms:.2f} / {calls:.0f}"


def ratios(report):
    worst = min((v for s in report["scenarios"] for k, v in s["derived"].items() if k.startswith("delivered_ratio")), default=1)
    errors = sum(n for s in report["scenarios"] for n in s["errors"].values())
    return f"{worst:.3f} / {errors}"


def main(paths):
    reports = [json.load(open(path)) for path in paths]
    print("| metric (ms p50 / p95 / p99) | " + " | ".join(r["meta"].get("label") or p for r, p in zip(reports, paths)) + " |")
    print("| --- |" + " --- |" * len(reports))
    for name, hist, label in LATENCIES:
        print(f"| {label} | " + " | ".join(latency(r, name, hist) for r in reports) + " |")
    for name, counter, label in [("send", "rest:send_message", "send"), ("typing", "rest:typing", "typing")]:
        print(f"| {label}: server CPU ms / PG ms / queries per request | " + " | ".join(per_message(r, name, counter) for r in reports) + " |")
    rss = lambda r: f"{max((s['resources'].get('server') or {}).get('rss_max_mib', 0) for s in r['scenarios']):.0f}"
    print("| server RSS peak (MiB) | " + " | ".join(rss(r) for r in reports) + " |")
    print("| worst delivery ratio / errors | " + " | ".join(ratios(r) for r in reports) + " |")


if __name__ == "__main__":
    main(sys.argv[1:])
