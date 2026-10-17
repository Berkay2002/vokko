#!/usr/bin/env python3
"""A stand-in for vokko-server for bot smoke tests (docs/design/stremio-bot.md section 9, manual smoke test).

  stub-server.py listen [port]                  accept the bot's events (POST /internal/stremio/bot) and print them
  stub-server.py put CHANNEL URL [key=value...] PUT /sessions/CHANNEL on the bot (mints the LiveKit token itself)
  stub-server.py delete CHANNEL                 DELETE /sessions/CHANNEL

put options: position_ms=0 playing=true max_height=720 bitrate=2000 livekit_url=ws://127.0.0.1:7880
Environment: VOKKO_STREMIO_BOT_SECRET (required), BOT=http://127.0.0.1:8720, LK_KEY=devkey, LK_SECRET=secret
"""
import base64, hashlib, hmac, json, os, sys, time, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

BOT = os.environ.get("BOT", "http://127.0.0.1:8720")
SECRET = os.environ.get("VOKKO_STREMIO_BOT_SECRET", "")


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def token(room: str, identity: str) -> str:
    """A LiveKit access token that may publish screen share tracks only (same shape as the server's bot token)."""
    key, secret = os.environ.get("LK_KEY", "devkey"), os.environ.get("LK_SECRET", "secret")
    now = int(time.time())
    claims = {
        "iss": key, "sub": identity, "name": "Stremio", "nbf": now, "exp": now + 3600,
        "video": {"room": room, "roomJoin": True, "canPublish": True, "canSubscribe": False, "canPublishData": False,
                  "canPublishSources": ["screen_share", "screen_share_audio"]},
    }
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = b64(json.dumps(claims).encode())
    sig = hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{b64(sig)}"


def call(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BOT + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {SECRET}")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            print(method, path, "->", r.status)
    except urllib.error.HTTPError as e:
        print(method, path, "->", e.code, e.read().decode())


class Events(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        ok = self.headers.get("Authorization") == f"Bearer {SECRET}" and self.path == "/internal/stremio/bot"
        print(time.strftime("%H:%M:%S"), "event" if ok else f"REJECTED {self.path}", body, flush=True)
        self.send_response(204 if ok else 401)
        self.end_headers()

    def log_message(self, *args):
        pass


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "listen":
        port = int(sys.argv[2]) if len(sys.argv) > 2 else 8710
        HTTPServer(("127.0.0.1", port), Events).serve_forever()
    elif cmd == "put" and len(sys.argv) >= 4:
        channel, url = sys.argv[2], sys.argv[3]
        opts = dict(a.split("=", 1) for a in sys.argv[4:])
        body = {
            "livekit_url": opts.get("livekit_url", "ws://127.0.0.1:7880"),
            "token": token(f"stremio-{channel}", f"bot:stremio:{channel}"),
            "media_url": url, "headers": {},
            "position_ms": int(opts.get("position_ms", 0)),
            "playing": opts.get("playing", "true") == "true",
            "max_height": int(opts.get("max_height", 720)),
            "bitrate": int(opts.get("bitrate", 2000)),
        }
        call("PUT", f"/sessions/{channel}", body)
    elif cmd == "delete" and len(sys.argv) >= 3:
        call("DELETE", f"/sessions/{sys.argv[2]}")
    else:
        print(__doc__)
        sys.exit(2)


main()
