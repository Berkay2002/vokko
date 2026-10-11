// Screenshots of the app shell in mock mode (1440x900), one PNG per state.
//   npm run dev -- --port 1421        (in another terminal)
//   node scripts/shots.mjs [outDir] [baseUrl]
// Needs Playwright with a Chromium: PLAYWRIGHT_CHROMIUM picks an executable, otherwise the newest
// chromium_headless_shell under %LOCALAPPDATA%\ms-playwright (or ~/.cache/ms-playwright) is used.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const out = resolve(process.argv[2] ?? "artifacts/shell");
const base = process.argv[3] ?? "http://127.0.0.1:1421";
mkdirSync(out, { recursive: true });

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const roots = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "ms-playwright"), join(homedir(), ".cache", "ms-playwright"), join(homedir(), "Library", "Caches", "ms-playwright")].filter(Boolean);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const dirs = readdirSync(root).filter(d => d.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const dir of dirs) {
      for (const sub of ["chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-headless-shell-linux/chrome-headless-shell", "chrome-headless-shell-mac-arm64/chrome-headless-shell"]) {
        const candidate = join(root, dir, sub);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

const browser = await chromium.launch({ executablePath: findChromium() });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// Onyx is the account theme of the reference captures; THEME=dark|ash|onyx|light overrides.
const theme = process.env.THEME ?? "onyx";
await context.addInitScript(t => localStorage.setItem("vokko.prefs", JSON.stringify({ theme: t })), theme);
const page = await context.newPage();
const problems = [];
page.on("pageerror", e => problems.push(`pageerror: ${e.message}`));
page.on("console", m => m.type() === "error" && problems.push(`console: ${m.text()}`));

const shot = async name => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log("wrote", name);
};
// The mock backend lives in memory, so a reload would invalidate the session: navigate client-side instead.
const nav = path => page.evaluate(p => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")); }, path);
const store = () => page.evaluate(() => {
  const s = window.__vokko.appStore.getState();
  const guild = Object.values(s.guilds)[0];
  const channels = Object.values(s.channels);
  return {
    dm: s.privateChannels.map(id => s.channels[id]).find(c => c.type === 1)?.id,
    guild: guild?.id,
    text: channels.find(c => c.guild_id === guild?.id && c.type === 0 && c.name === "general")?.id,
  };
});

// login screen (fresh, unauthenticated)
await page.goto(`${base}/login`);
await page.waitForSelector(".auth-card");
await shot("01-login");

// signed in as sam through the mock shortcut
await page.goto(`${base}/channels/@me?as=sam`);
await page.waitForSelector(".dm-row");
await shot("02-home-friends-online");

await page.click('.friends-tab:has-text("All")');
await shot("03-friends-all");
await page.click('.friends-tab:has-text("Pending")');
await shot("04-friends-pending");
await page.click(".add-friend-tab");
await page.fill('.add-friend-input input', "nova");
await page.click('.add-friend-input button[type="submit"]');
await page.waitForSelector(".add-friend-result");
await shot("05-friends-add");
await page.click('.friends-tab:has-text("Online")');

const ids = await store();
await nav(`/channels/@me/${ids.dm}`);
await page.waitForSelector(".channel-header");
await shot("06-dm-channel");

await nav(`/channels/${ids.guild}/${ids.text}`);
await page.waitForSelector(".member-row");
await shot("07-guild-channel-members");

await page.click(".guild-header");
await shot("08-server-dropdown");
await page.keyboard.press("Escape");

await page.click(".user-panel-account");
await shot("09-status-menu");
await page.keyboard.press("Escape");

await page.hover(".rail-guild");
await shot("10-rail-hover-tooltip");

await page.click(".rail-add");
await shot("11-create-server-modal");
await page.click(".choice-row");
await shot("11b-create-server-purpose");
await page.click(".choice-row");
await shot("11c-create-server-customize");
await page.keyboard.press("Escape");

await page.click(".guild-header-name-button");
await page.click('.guild-menu-item:has-text("Create Channel")');
await shot("11d-create-channel-modal");
await page.keyboard.press("Escape");

await page.click(".member-row");
await shot("12-profile-card");
await page.keyboard.press("Escape");

await page.click(".channel-row.voice", { button: "right" }).catch(() => undefined);
await page.keyboard.press("Escape");
await page.click(".channel-row:not(.voice)", { button: "right" });
await shot("13-channel-context-menu");
await page.keyboard.press("Escape");

await page.keyboard.press("Control+k");
await page.waitForSelector(".quick-input");
await shot("14-quick-switcher");
await page.keyboard.press("Escape");

await page.click('.user-panel-button[aria-label="User Settings"]');
await page.waitForSelector(".settings-overlay");
await shot("15-user-settings-account");
await page.click('.settings-item:has-text("Profiles")');
await shot("16-user-settings-profiles");
await page.keyboard.press("Escape");

await nav("/channels/@me");
await page.waitForSelector(".dm-row");
await page.hover(".dm-row-wrap:nth-child(2) .dm-row");
await shot("17-dm-row-hover");

// ---- milestone C ----
await nav(`/channels/@me/${ids.dm}`);
await page.waitForSelector(".dm-profile");
await page.waitForTimeout(800);
await shot("18-dm-profile-panel");
await page.click(".dm-profile-footer button");
await page.waitForSelector(".full-profile");
await shot("19-full-profile-modal");
await page.keyboard.press("Escape");

await page.click('button[aria-label="Inbox"]');
await page.waitForSelector(".inbox-popout");
await shot("20-inbox");
await page.keyboard.press("Escape");

await page.click(".user-panel-chevron >> nth=0");
await page.waitForSelector(".context-menu");
await shot("21-mic-menu");
await page.keyboard.press("Escape");

await nav(`/channels/${ids.guild}/${ids.text}`);
await page.waitForSelector(".member-row");
await page.click(".guild-header");
await page.click('.guild-menu-item:has-text("Server Settings")');
await page.waitForSelector(".settings-overlay");
await shot("22-server-settings-overview");
await page.click('.settings-item:has-text("Roles")');
await shot("23-server-settings-roles");
await page.keyboard.press("Escape");

await page.click(".rail-guild", { button: "right" });
await shot("24-rail-context-menu");
await page.keyboard.press("Escape");

await page.click(".member-row", { button: "right" });
await shot("25-member-context-menu");
await page.keyboard.press("Escape");

await page.keyboard.press("Control+k");
await page.fill(".quick-input", "#gen");
await shot("26-quick-switcher-channels");
await page.keyboard.press("Escape");

await page.click('.user-panel-button[aria-label="User Settings"]');
await page.waitForSelector(".settings-overlay");
for (const [id, label] of [["27-settings-appearance", "Appearance"], ["28-settings-voice", "Voice & Video"], ["29-settings-keybinds", "Keybinds"], ["30-settings-notifications", "Notifications"]]) {
  await page.click(`.settings-item:has-text("${label}")`);
  await shot(id);
}
await page.keyboard.press("Escape");

if (problems.length) console.log("browser problems:\n" + problems.join("\n"));
await browser.close();
