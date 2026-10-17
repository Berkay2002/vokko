#!/usr/bin/env node
// Local measurement harness for the Stremio bot (docs/design/stremio-bot.md section 12, "smooth" work). It starts its own
// livekit-server on high ports, a local https "CDN" (https-range.py), an event sink standing in for vokko-server, the bot
// (built with `--features test-harness`) and a headless Chrome that views the room with the app's own viewer code
// (apps/desktop/src/stremio/viewer.ts, served by a Vite dev server that must already run on VITE, default 1450).
// It never touches the live media LiveKit (7880), the live bot (8720) or any container.
//
//   PLAYWRIGHT_BROWSERS_PATH=... node harness.mjs --media DIR --bot PATH [--codec vp8|h264] [--encoder auto|software|videotoolbox]
//     [--bitrate 6000] [--play 60] [--seeks 5] [--delay-ms 40] [--mbit 100] [--label NAME] [--out FILE]
//
// DIR holds film.mkv, cert.pem and key.pem (gen-media.sh). Numbers come from the viewer's getStats and requestVideoFrameCallback,
// the bot's own `video send` / `first video frame` log lines, the https server's request log and `ps` cpu times.

import { spawn, execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const media = arg("media");
const botPath = arg("bot");
if (!media || !botPath) throw new Error("--media DIR and --bot PATH are required");
const cfg = {
  codec: arg("codec", "vp8"),
  encoder: arg("encoder", "auto"),
  bitrate: Number(arg("bitrate", "6000")),
  play: Number(arg("play", "60")),
  seeks: Number(arg("seeks", "5")),
  delay: arg("delay-ms", "40"),
  mbit: arg("mbit", "100"),
  label: arg("label", "run"),
  vite: arg("vite", "http://127.0.0.1:1450"),
  out: arg("out", ""),
};
const PORTS = { lk: 17880, lkTcp: 17881, lkUdp: 17882, cdn: 18443, bot: 18720, events: 18710 };
const KEY = "devkey";
const SECRET = "harness-secret-harness-secret-0123456789";
const BOT_SECRET = "harness-bot-secret-0123456789";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64 = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

function token(room, identity, video) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: KEY, sub: identity, name: identity, nbf: now, exp: now + 3600, video: { room, roomJoin: true, ...video } });
  return `${head}.${body}.${createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

const children = [];
function start(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const take = chunk => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) lines.push({ t: Date.now(), line });
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.on("exit", code => lines.push({ t: Date.now(), line: `[exit ${code}]` }));
  children.push(child);
  return { name, child, lines };
}
const stopAll = () => children.forEach(c => c.exitCode === null && c.kill("SIGTERM"));
process.on("exit", stopAll);
process.on("SIGINT", () => process.exit(130));

const dir = mkdtempSync(path.join(tmpdir(), "stremio-harness-"));
writeFileSync(
  path.join(dir, "livekit.yaml"),
  `port: ${PORTS.lk}\nbind_addresses: ["127.0.0.1"]\nrtc:\n  tcp_port: ${PORTS.lkTcp}\n  udp_port: ${PORTS.lkUdp}\n  use_external_ip: false\n  node_ip: 127.0.0.1\nkeys:\n  ${KEY}: ${SECRET}\nlogging:\n  level: warn\n`,
);
const lk = start("livekit", "livekit-server", ["--config", path.join(dir, "livekit.yaml")]);
const cdn = start("cdn", "python3", [path.join(here, "https-range.py"), media, path.join(media, "cert.pem"), path.join(media, "key.pem"), String(PORTS.cdn), cfg.delay, cfg.mbit]);

const events = [];
const sink = createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    try {
      events.push({ t: Date.now(), ...JSON.parse(body) });
    } catch {}
    res.writeHead(204).end();
  });
}).listen(PORTS.events, "127.0.0.1");

const psTime = pid => {
  try {
    const raw = execFileSync("ps", ["-o", "time=", "-p", String(pid)]).toString().trim();
    return raw.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
  } catch {
    return null;
  }
};
const childrenOf = pid => {
  try {
    return execFileSync("pgrep", ["-P", String(pid)]).toString().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};

const require = createRequire(path.join(here, "../../../../apps/desktop/package.json"));
const { chromium } = require("@playwright/test");

const HTML = `<!doctype html><body style="margin:0;background:#000"><video id="v" autoplay muted playsinline style="width:1920px;height:800px"></video>
<script type="module">
import { createViewer } from "/src/stremio/viewer.ts";
window.frames = [];
const el = document.getElementById("v");
const tick = (now) => { window.frames.push(performance.timeOrigin + now); el.requestVideoFrameCallback(tick); };
window.join = async (url, token, bot) => {
  window.viewer = createViewer(url, {
    status: s => console.log("status", s),
    video: h => { if (h) { h.attach(el); el.requestVideoFrameCallback(tick); } },
    audioBlocked: () => {},
  });
  await window.viewer.connect(url, token, bot);
};
</script>`;

const put = async (room, botToken, position, playing = true) => {
  const res = await fetch(`http://127.0.0.1:${PORTS.bot}/sessions/1`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${BOT_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      livekit_url: `ws://127.0.0.1:${PORTS.lk}`,
      token: botToken,
      media_url: `https://localhost:${PORTS.cdn}/film.mkv`,
      position_ms: position,
      playing,
      max_height: 1080,
      bitrate: cfg.bitrate,
    }),
  });
  if (!res.ok) throw new Error(`PUT ${res.status} ${await res.text()}`);
};

const quantile = (xs, q) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : null);
const round = (x, d = 1) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);

async function main() {
  await sleep(1500);
  const room = `stremio-1-${Math.random().toString(16).slice(2, 8)}`;
  const botToken = token(room, "bot:stremio:1", { canPublish: true, canSubscribe: false, canPublishData: false, canPublishSources: ["screen_share", "screen_share_audio"] });
  const viewerToken = token(room, "viewer:1:aaaa", { canPublish: false, canSubscribe: true, canPublishData: false });
  const bot = start("bot", botPath, [], {
    VOKKO_STREMIO_BOT_SECRET: BOT_SECRET,
    VOKKO_STREMIO_BOT_LISTEN: `127.0.0.1:${PORTS.bot}`,
    VOKKO_STREMIO_SERVER_URL: `http://127.0.0.1:${PORTS.events}`,
    VOKKO_STREMIO_CODEC: cfg.codec,
    VOKKO_STREMIO_ENCODER: cfg.encoder,
    VOKKO_STREMIO_TEST_LOCAL_MEDIA: "1",
    SSL_CERT_FILE: path.join(media, "cert.pem"),
    NO_COLOR: "1",
  });
  await sleep(1000);

  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--autoplay-policy=no-user-gesture-required", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests"],
  });
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 900 } })).newPage();
  page.on("console", m => m.type() === "error" && console.error("[page]", m.text().slice(0, 200)));
  await page.route(`${cfg.vite}/__harness`, route => route.fulfill({ contentType: "text/html", body: HTML }));
  await page.goto(`${cfg.vite}/__harness`);
  await page.waitForFunction(() => typeof window.join === "function", null, { timeout: 60000 });

  const start0 = 60000;
  await put(room, botToken, start0);
  await page.evaluate(([url, tok]) => window.join(url, tok, "bot:stremio:1"), [`ws://127.0.0.1:${PORTS.lk}`, viewerToken]);
  const frameCount = () => page.evaluate(() => window.frames.length);
  for (let i = 0; i < 300 && (await frameCount()) < 30; i++) await sleep(100);
  if ((await frameCount()) < 30) throw new Error("no picture reached the viewer\n" + bot.lines.slice(-8).map(l => l.line).join("\n"));

  const botPid = bot.child.pid;
  const result = { config: cfg };

  // Steady playback.
  await sleep(5000);
  const cpu0 = { bot: psTime(botPid), ffmpeg: childrenOf(botPid).map(psTime), t: Date.now() };
  const samples = [];
  const t0 = Date.now();
  while (Date.now() - t0 < cfg.play * 1000) {
    samples.push({ t: Date.now(), stats: await page.evaluate(() => window.viewer.stats()) });
    await sleep(1000);
  }
  const cpu1 = { bot: psTime(botPid), ffmpeg: childrenOf(botPid).map(psTime), t: Date.now() };
  const frames = await page.evaluate(() => window.frames.slice());
  const inWindow = frames.filter(t => t >= t0 && t <= cpu1.t);
  const gaps = inWindow.slice(1).map((t, i) => t - inWindow[i]);
  const a = samples[0].stats;
  const z = samples.at(-1).stats;
  const secs = (z && a ? (samples.at(-1).t - samples[0].t) : 1) / 1000;
  const wall = (cpu1.t - cpu0.t) / 1000;
  const sends = bot.lines.filter(l => l.t >= t0 && l.line.includes("video send"));
  const field = (line, name) => (line.match(new RegExp(`${name}=("[^"]*"|\\S+)`)) ?? [])[1];
  const high = sends.filter(l => field(l.line, "rid") === 'Some("f")' || field(l.line, "height") === "800" || field(l.line, "height") === "1080");
  result.play = {
    presented_fps: round(inWindow.length / ((cpu1.t - t0) / 1000)),
    decoded_fps: a && z ? round((z.framesDecoded - a.framesDecoded) / secs) : null,
    frames_dropped: a && z ? z.framesDropped - a.framesDropped : null,
    freezes: a && z ? z.freezeCount - a.freezeCount : null,
    freeze_ms: a && z ? round(z.freezeMs - a.freezeMs, 0) : null,
    jitter_buffer_ms: z ? round(z.jitterBufferMs) : null,
    interval_p50_ms: round(quantile(gaps, 0.5)),
    interval_p95_ms: round(quantile(gaps, 0.95)),
    interval_max_ms: round(Math.max(0, ...gaps)),
    stalls_over_2_beats: gaps.filter(g => g > 85).length,
    recv_kbps: a && z ? round(((z.bytesReceived - a.bytesReceived) * 8) / 1000 / secs, 0) : null,
    size: z ? `${z.width}x${z.height}` : null,
    codec: z?.codec,
    bot_cpu_pct: round(((cpu1.bot - cpu0.bot) / wall) * 100, 0),
    ffmpeg_cpu_pct: round(((cpu1.ffmpeg.reduce((s, x) => s + (x ?? 0), 0) - cpu0.ffmpeg.reduce((s, x) => s + (x ?? 0), 0)) / wall) * 100, 0),
    send_lines: sends.length,
    send_rids: [...new Set(bot.lines.filter(l => l.line.includes("video send")).map(l => field(l.line, "rid")))],
    send_sample: (high.at(-1) ?? sends.at(-1))?.line.replace(/^\S+\s+/, ""),
  };

  // Seeks while playing.
  const targets = [20000, 150000, 45000, 120000, 80000, 30000, 170000].slice(0, cfg.seeks);
  result.seeks = [];
  for (const target of targets) {
    await sleep(9000);
    const logFrom = bot.lines.length;
    const cdnFrom = cdn.lines.length;
    const eventFrom = events.length;
    const tPut = Date.now();
    await put(room, botToken, target);
    let first = null;
    for (let i = 0; i < 200 && first === null; i++) {
      await sleep(50);
      const f = await page.evaluate(() => window.frames.slice(-400));
      for (let j = 1; j < f.length; j++) if (f[j] > tPut + 20 && f[j] - f[j - 1] > 200) { first = f[j]; break; }
    }
    const frameLine = bot.lines.slice(logFrom).find(l => l.line.includes("first video frame"));
    const started = events.slice(eventFrom).find(e => e.kind === "started" || e.event === "started" || JSON.stringify(e).includes("started"));
    const requests = cdn.lines.slice(cdnFrom).filter(l => l.t >= tPut && (first === null || l.t <= first + 100));
    result.seeks.push({
      to_s: target / 1000,
      viewer_first_frame_ms: first === null ? null : first - tPut,
      bot_first_frame_ms: frameLine ? Number(field(frameLine.line, "first_frame_ms")) : null,
      started_event_ms: started ? started.t - tPut : null,
      cdn_requests: requests.length,
      cdn_mb: round(requests.reduce((s, l) => s + Number((l.line.match(/sent=(\d+)/) ?? [])[1] ?? 0), 0) / 1e6),
    });
  }
  const ms = result.seeks.map(s => s.viewer_first_frame_ms).filter(x => x !== null);
  result.seek_summary = { median_ms: quantile(ms, 0.5), max_ms: Math.max(0, ...ms), n: ms.length };

  await browser.close();
  return result;
}

try {
  const result = await main();
  const text = JSON.stringify(result, null, 2);
  console.log(text);
  if (cfg.out) writeFileSync(cfg.out, text);
  process.exitCode = 0;
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  sink.close();
  stopAll();
  await sleep(500);
  process.exit();
}
