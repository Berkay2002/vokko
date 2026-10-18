// Game screen-share bench (Windows, docs/perf.md "Game screen share"). From apps/desktop:
//
//   node scripts/share-bench/run.mjs --lk <livekit-server.exe> --exe <vokko-desktop.exe> [--runs 720p30,1080p60,1440p60]
//        [--codec vp9|h264|...] [--simulcast 0] [--munge 0] [--iter 400] [--seconds 10] [--warm 12] [--sync] [--label after]
//        [--role loop --profile 640032] [--pub chrome] [--wvargs "<extra browser args>"] [--port-base 1491]
//
// Starts livekit-server (ports --port-base + 1..3) and Vite (--port-base), a "game" (load.html: a full-window WebGL shader,
// GPU-bound at ~80-90 fps with --iter 400 on a desktop GPU, in a kiosk Chrome window on the display at --load-x), the publisher
// in the real WebView2 runtime (any WebView2 host: a release vokko-desktop.exe on its own data folders, navigated to
// share.html, which publishes with the app's own buildScreenShare plan and H.264 profile order), and a viewer in Playwright
// Chromium. Per run: the game's frame times alone and while shared, the sender's encoder stats per layer, the viewer's fps,
// CPU of the publisher's process tree and GPU 3D / VideoEncode use per adapter. --codec forces a codec ("before" = vp9),
// --munge 0 turns the H.264 profile order off, --role loop skips LiveKit for a two-PeerConnection loopback with one H.264
// --profile. --sync shares the whole screen with system audio and reports the viewer's audio-minus-video offset of
// load.html's tick (beep + flash). Results: perf-results/share-<label>.json.
import { chromium } from 'playwright';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const flag = name => process.argv.includes(`--${name}`);
const step = what => console.error(`[bench ${new Date().toISOString().slice(11, 19)}] ${what}`);
const lk = arg('lk', 'livekit-server');
const exe = path.resolve(arg('exe', '../../target/release/vokko-desktop.exe'));
const runs = arg('runs', '720p30,1080p60,1440p60').split(',');
const codec = arg('codec', '');
const simulcast = arg('simulcast', '');
const iter = arg('iter', '400');
const sync = flag('sync');
const loadX = Number(arg('load-x', '5120'));
const loadW = Number(arg('load-w', '3440'));
const loadH = Number(arg('load-h', '1440'));
const seconds = Number(arg('seconds', '10'));
const label = arg('label', 'run');
const edge = arg('game-browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe');

const P = Number(arg('port-base', '1491')); // Vite, LiveKit, its TCP and UDP, publisher CDP, game CDP
const sleep = ms => new Promise(r => setTimeout(r, ms));
const work = path.resolve('perf-results', `share-${label}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const KEY = 'benchkey';
const SECRET = 'bench-secret-bench-secret-bench-secret-0123';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(identity) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: KEY, sub: identity, nbf: now - 10, exp: now + 3600, video: { room: 'bench', roomJoin: true, canPublish: true, canSubscribe: true } })}`;
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}

const children = [];
function start(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: 'ignore', ...opts });
  children.push(child);
  return child;
}
function stopAll() {
  for (const c of children) if (c.exitCode === null) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
}
process.on('exit', stopAll);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));
setTimeout(() => (console.error('bench timed out'), process.exit(2)), Number(arg('max', '600')) * 1000).unref();

writeFileSync(
  path.join(work, 'livekit.yaml'),
  `port: ${P + 1}\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: ${P + 2}\n  udp_port: ${P + 3}\n  use_external_ip: false\n  node_ip: 127.0.0.1\nkeys:\n  ${KEY}: ${SECRET}\nlogging:\n  level: warn\n`,
);
start(lk, ['--config', path.join(work, 'livekit.yaml')]);
start(process.execPath, [path.resolve('../../node_modules/vite/bin/vite.js'), '--port', String(P), '--strictPort', '--host', '127.0.0.1'], { cwd: process.cwd() });
const base = `http://127.0.0.1:${P}/scripts/share-bench`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/share.html`)).ok) break;
  } catch {}
  await sleep(200);
}

// The "game".
// The "game": a kiosk (fullscreen, no browser UI) window on its own profile, like a borderless fullscreen game.
start(edge, [
  `--user-data-dir=${path.join(work, 'game')}`,
  `--remote-debugging-port=${P + 5}`,
  '--no-first-run',
  `--window-position=${sync ? 0 : loadX},0`,
  `--window-size=${loadW},${loadH}`,
  '--kiosk',
  '--autoplay-policy=no-user-gesture-required',
  '--force_high_performance_gpu',
  `${base}/load.html?iter=${iter}${sync ? '&tick=1' : ''}`,
]);
const connect = async port => {
  for (let i = 0; i < 200; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      for (let j = 0; j < 100; j++) {
        const page = browser.contexts().flatMap(c => c.pages())[0];
        if (page) return { browser, page };
        await sleep(100);
      }
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`no browser on ${port}`);
};
const { browser: game, page: gamePage } = await connect(P + 5);
await gamePage.waitForFunction(() => window.__load);
const renderer = await gamePage.evaluate(() => window.__load.renderer);
const frameStats = async () => {
  const f = (await gamePage.evaluate(() => window.__load.take())).sort((a, b) => a - b);
  const at = p => f[Math.min(f.length - 1, Math.floor(p * f.length))];
  return { fps: Math.round(f.length / (f.reduce((s, x) => s + x, 0) / 1000)), median: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), p99: +at(0.99).toFixed(2), over33: f.filter(x => x > 33.4).length };
};

// The publisher: a WebView2 host on its own user data folder, driven over CDP.
const capture = arg('capture', sync ? 'Screen 1' : 'VokkoLoad');
// --pub chrome: the same page in desktop Chrome instead, for comparison.
const host = arg('pub', '') === 'chrome'
  ? start(arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'), [`--user-data-dir=${path.join(work, 'chrome')}`, `--remote-debugging-port=${P + 4}`, `--auto-select-desktop-capture-source=${capture}`, '--no-first-run', ...arg('wvargs', '').split(' ').filter(Boolean), 'about:blank'])
  : start(exe, [], {
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(work, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${P + 4} --auto-select-desktop-capture-source="${capture}" ${arg('wvargs', '')}`,
    VOKKO_CONFIG_DIR: path.join(work, 'config'),
    VOKKO_MULTI_INSTANCE: '1',
  },
});
step('game up, starting the publisher');
const { browser: wv, page: pubPage } = await connect(P + 4);

const viewer = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const sample = () =>
  JSON.parse(execFileSync('pwsh', ['-NoProfile', '-File', path.resolve('scripts/share-bench/sample.ps1'), '-Seconds', String(seconds), '-Roots', String(host.pid)], { encoding: 'utf8' }));

const results = { label, renderer, codec, simulcast, iter, runs: [] };
for (const run of runs) {
  const [, res, fps] = run.match(/^(\d+p|source)(\d+)$/) ?? [];
  await sleep(2000);
  await frameStats();
  await sleep(seconds * 1000);
  const alone = await frameStats();

  const q = new URLSearchParams({ role: arg('role', 'pub'), url: `ws://127.0.0.1:${P + 1}`, res, fps, audio: sync ? '1' : '0', token: token('pub') });
  if (arg('profile', '')) q.set('profile', arg('profile', ''));
  if (codec) q.set('codec', codec);
  if (arg('munge', '')) q.set('munge', arg('munge', ''));
  if (simulcast) q.set('simulcast', simulcast);
  step(`${run}: publishing`);
  await pubPage.goto(`${base}/share.html?${q}`);
  const pubInfo = await pubPage.evaluate(async () => {
    const b = await window.__bench;
    return b.error ? b : b.info;
  });
  if (pubInfo.error) throw new Error(`publisher: ${pubInfo.error}`);
  step(`${run}: published (${pubInfo.plan?.codec}), starting the viewer`);
  const viewPage = await viewer.newPage();
  await viewPage.goto(`${base}/share.html?${new URLSearchParams({ role: 'view', url: `ws://127.0.0.1:${P + 1}`, token: token(`view-${run}`) })}`);
  await viewPage.evaluate(async () => (await window.__bench).info);
  step(`${run}: viewer up, measuring`);
  await sleep(Number(arg("warm", "12")) * 1000);
  await pubPage.evaluate(async () => (await window.__bench).take());
  await viewPage.evaluate(async () => (await window.__bench).take());
  await frameStats();
  const usage = sample();
  const shared = await frameStats();
  const sender = await pubPage.evaluate(async () => (await window.__bench).take());
  const received = await viewPage.evaluate(async () => (await window.__bench).take());
  results.runs.push({ run, alone, shared, pubInfo, sender, received, usage });
  console.log(JSON.stringify({ run, capture: pubInfo.capture, hardware: pubInfo.support?.hardware, plan: pubInfo.plan?.codec, error: pubInfo.error, alone, shared, sender, received: received.stats, offsets: received.offsets, usage }));
  await viewPage.close();
  await pubPage.goto('about:blank');
}
writeFileSync(path.resolve('perf-results', `share-${label}.json`), JSON.stringify(results, null, 2));
await viewer.close();
await wv.close().catch(() => {});
await game.close();
stopAll();
process.exit(0);
