#!/usr/bin/env python3
"""A local stand-in for the CDN in the measurement harness: https, byte ranges, one log line per request.

  https-range.py DIR CERT KEY [port=18443] [delay_ms=0] [mbit=0]

delay_ms is the round trip time to the "CDN" (a warm TorBox answers in about 30-80 ms): slept twice before the TLS handshake of a
new connection (TCP and TLS each take a round trip) and once before every response. mbit caps the speed of each connection (0 = unlimited), so a seek that reads 20 MB costs what it would over a real link. Needs a bot built with `--features test-harness` and VOKKO_STREMIO_TEST_LOCAL_MEDIA=1; see harness.mjs.
"""
import os, re, ssl, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT, CERT, KEY = sys.argv[1], sys.argv[2], sys.argv[3]
PORT = int(sys.argv[4]) if len(sys.argv) > 4 else 18443
DELAY = float(sys.argv[5]) / 1000 if len(sys.argv) > 5 else 0.0
RATE = float(sys.argv[6]) * 125_000 if len(sys.argv) > 6 else 0.0  # bytes per second


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        time.sleep(2 * DELAY)
        try:
            self.request.do_handshake()
        except (ssl.SSLError, OSError):
            pass
        super().setup()

    def do_GET(self):
        self.serve(True)

    def do_HEAD(self):
        self.serve(False)

    def serve(self, body):
        path = os.path.join(ROOT, os.path.basename(self.path.split("?")[0]))
        if not os.path.isfile(path):
            self.send_error(404)
            return
        time.sleep(DELAY)
        size = os.path.getsize(path)
        start, end, status = 0, size - 1, 200
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if m:
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            status = 206
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", "video/x-matroska" if path.endswith(".mkv") else "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        sent = 0
        if body:
            with open(path, "rb") as f:
                f.seek(start)
                try:
                    while sent < length:
                        chunk = f.read(min(1 << 16, length - sent))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        sent += len(chunk)
                        if RATE:
                            time.sleep(len(chunk) / RATE)
                except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                    pass
        print(f"{time.time():.3f} {self.command} {os.path.basename(path)} range={start}-{end} sent={sent}", flush=True)

    def log_message(self, *args):
        pass


context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(CERT, KEY)
server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
print(f"listening on https://localhost:{PORT}", flush=True)
server.serve_forever()
