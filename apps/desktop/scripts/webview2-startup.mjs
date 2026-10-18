// Cold start of the desktop app in WebView2 (Windows): launches a mock-mode release build (`npx tauri build --no-bundle` without
// VITE_VOKKO_API) with its own WebView2 and config folders, drives it over CDP, and reports per run: ms from process launch and
// from navigation start to the first painted chat messages (`vokko:first-messages`) and to READY (`vokko:ready`), the JS heap
// after a GC and the private bytes of the app and its WebView2 processes. Never touches an installed Vokko or its data.
//
//   node scripts/webview2-startup.mjs [--exe ../../target/release/vokko-desktop.exe] [--runs 5] [--ready-delay 0] [--cache on|off]
//
// --cache off clears the startup cache owner before each exit, so every start goes through the Splash and READY (the old path);
// a start without the cache opens Home, and the script clicks the first server as soon as its icon exists (like perf.bench's
// cold start). --ready-delay holds the mock READY back (ms), like a slow network. Results go to perf-results/wv2-<label>.json.
// Against a real server (a build with VITE_VOKKO_API=<api>): --api <api> --login user:password signs in over REST instead of the
// mock's `?as=`. Mock ids change on every start, so only a real server shows the cached channel staying put after READY.
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const exe = path.resolve(arg('exe', '../../target/release/vokko-desktop.exe'));
const runs = Number(arg('runs', '5'));
const readyDelay = arg('ready-delay', '0');
const cache = arg('cache', 'on') === 'on';
const port = Number(arg('port', '1472'));
const api = arg('api', '');
const login = arg('login', 'sam:vokko-dev');
const label = arg('label', `${cache ? 'cache' : 'nocache'}-delay${readyDelay}`);
const data = path.resolve('perf-results', `wv2-data-${label}`);
rmSync(data, { recursive: true, force: true });
mkdirSync(data, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function launch() {
  const env = {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: path.join(data, 'webview2'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    VOKKO_CONFIG_DIR: path.join(data, 'config'),
    VOKKO_MULTI_INSTANCE: '1',
  };
  const t0 = Date.now();
  const child = spawn(exe, [], { env, stdio: 'ignore' });
  return { child, t0 };
}

async function connect() {
  for (let i = 0; i < 200; i++) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      for (let j = 0; j < 100; j++) {
        const page = browser.contexts().flatMap(c => c.pages()).find(p => /^https?:\/\/tauri\.localhost/.test(p.url()));
        if (page) return { browser, page };
        await sleep(50);
      }
    } catch {
      await sleep(50);
    }
  }
  throw new Error('no WebView2 page over CDP');
}

function kill(child) {
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}

/** Private bytes (MB) of the app process and every WebView2 process below it. */
function privateMB(pid) {
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,PrivatePageCount; $all | ConvertTo-Json -Compress`;
  const all = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  const tree = new Set([pid]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of all) if (tree.has(p.ParentProcessId) && !tree.has(p.ProcessId)) (tree.add(p.ProcessId), (changed = true));
  }
  const mine = all.filter(p => tree.has(p.ProcessId));
  const mb = n => Math.round((n / 1024 / 1024) * 10) / 10;
  return {
    app: mb(mine.filter(p => p.ProcessId === pid).reduce((a, p) => a + Number(p.PrivatePageCount), 0)),
    webview2: mb(mine.filter(p => p.ProcessId !== pid).reduce((a, p) => a + Number(p.PrivatePageCount), 0)),
    webview2Processes: mine.length - 1,
  };
}

/** Without the owner the next start skips the cache. Later saves in this session (read states, presence) would write it back. */
async function dropCacheOwner(page) {
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key !== 'vokko.cache.owner') set.call(this, key, value);
    };
    localStorage.removeItem('vokko.cache.owner');
  });
}

/** Clicks the first server as soon as its icon exists, unless chat messages are already on screen (the cache). */
async function openGuildWhenNeeded(page) {
  await page.waitForFunction(
    () => {
      if (document.querySelector('.chat-msg')) return true;
      const guild = document.querySelector('nav[aria-label="Servers sidebar"] a[href^="/channels/"]:not([href^="/channels/@me"])');
      if (guild && !window.__clicked) {
        window.__clicked = true;
        guild.click();
      }
      return false;
    },
    null,
    { polling: 100, timeout: 60_000 },
  );
}

// First start: sign in as the mock user, set the READY delay, open the server so the cache has something to show.
{
  const { child } = launch();
  const { browser, page } = await connect();
  const origin = new URL(page.url()).origin;
  if (api) {
    const [name, password] = login.split(':');
    await page.evaluate(
      async ([base, name, password]) => {
        const res = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: name, password }) });
        localStorage.setItem('vokko.token', (await res.json()).token);
      },
      [api, name, password],
    );
    await page.goto(`${origin}/`);
  } else {
    await page.evaluate(delay => localStorage.setItem('vokko.mock.readyDelay', delay), readyDelay);
    await page.goto(`${origin}/channels/@me?as=sam`);
  }
  await openGuildWhenNeeded(page).catch(async error => {
    console.error(page.url(), await page.evaluate(() => [document.visibilityState, document.title, document.body.innerText.slice(0, 200)]));
    kill(child);
    throw error;
  });
  await sleep(4500); // the cache saves 3 s after a channel opens
  if (!cache) await dropCacheOwner(page);
  await sleep(8000); // WebView2 writes localStorage to disk lazily; a hard kill right away loses the token
  await browser.close().catch(() => {});
  kill(child);
  await sleep(1500);
}

const results = [];
for (let i = 0; i < runs; i++) {
  const { child, t0 } = launch();
  const { browser, page } = await connect();
  await openGuildWhenNeeded(page).catch(async error => {
    console.error(page.url(), await page.evaluate(() => [document.visibilityState, document.body.innerText.slice(0, 200)]));
    kill(child);
    throw error;
  });
  await page
    .waitForFunction(() => performance.getEntriesByName('vokko:first-messages').length > 0 && performance.getEntriesByName('vokko:ready').length > 0, null, { timeout: 30_000 })
    .catch(async error => {
      console.error(page.url(), await page.evaluate(() => [document.visibilityState, document.hasFocus(), performance.getEntriesByType('mark').map(m => m.name), !!document.querySelector('.chat-msg')]));
      kill(child);
      throw error;
    });
  const marks = await page.evaluate(() => ({
    origin: performance.timeOrigin,
    firstMessages: performance.getEntriesByName('vokko:first-messages')[0].startTime,
    ready: performance.getEntriesByName('vokko:ready')[0].startTime,
    fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
  }));
  // mock ids change per start, so after READY the cached channel is gone and the app is on Home: open the server again so every
  // run is measured in the same place (a no-op on a real server, where the channel stays open)
  await sleep(500);
  await page.evaluate(() => (window.__clicked = false));
  await openGuildWhenNeeded(page);
  await sleep(5000); // settle (idle preloads, the cache save)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const metric = name => metrics.find(m => m.name === name)?.value ?? 0;
  const memory = privateMB(child.pid);
  const run = {
    firstMessagesFromLaunchMs: Math.round(marks.origin + marks.firstMessages - t0),
    firstMessagesFromNavMs: Math.round(marks.firstMessages),
    readyFromNavMs: Math.round(marks.ready),
    fcpMs: marks.fcp && Math.round(marks.fcp),
    jsHeapMB: Math.round((metric('JSHeapUsedSize') / 1024 / 1024) * 10) / 10,
    domNodes: metric('Nodes'),
    ...memory,
  };
  results.push(run);
  console.log(JSON.stringify(run));
  if (!cache) {
    await dropCacheOwner(page);
    await sleep(8000); // lazy localStorage flush, as in the first start
  }
  await browser.close().catch(() => {});
  kill(child);
  await sleep(1500);
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const summary = Object.fromEntries(Object.keys(results[0]).map(k => [k, median(results.map(r => r[k]))]));
console.log('median', JSON.stringify(summary));
mkdirSync('perf-results', { recursive: true });
writeFileSync(path.join('perf-results', `wv2-${label}.json`), JSON.stringify({ exe, readyDelay, cache, runs: results, median: summary }, null, 2));
rmSync(data, { recursive: true, force: true });
