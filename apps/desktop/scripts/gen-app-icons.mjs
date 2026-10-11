// Rasterizes assets/app-icons/*.svg into src-tauri/icons/app/ (committed; the Tauri crate embeds them).
//   npm run app-icons          (needs a Playwright chromium: PLAYWRIGHT_BROWSERS_PATH or `npx playwright install chromium`)
// Per variant: <id>-256.png window/taskbar icon (full bleed), <id>-dock.png macOS Dock icon (512 canvas with the
// transparent inset macOS app icons have, art 824/1024), <id>-64.png tray icon.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "assets", "app-icons");
const to = join(root, "src-tauri", "icons", "app");
mkdirSync(to, { recursive: true });

const OUTPUTS = [
  { suffix: "256", canvas: 256, art: 256 },
  { suffix: "dock", canvas: 512, art: Math.round((512 * 824) / 1024) },
  { suffix: "64", canvas: 64, art: 64 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
try {
  for (const file of readdirSync(from).filter(name => name.endsWith(".svg")).sort()) {
    const id = file.slice(0, -4);
    const url = `data:image/svg+xml;base64,${readFileSync(join(from, file)).toString("base64")}`;
    for (const { suffix, canvas, art } of OUTPUTS) {
      await page.setViewportSize({ width: canvas, height: canvas });
      await page.setContent(
        `<body style="margin:0;background:transparent"><div style="width:${canvas}px;height:${canvas}px;display:grid;place-items:center"><img src="${url}" width="${art}" height="${art}"></div></body>`,
      );
      await page.screenshot({ path: join(to, `${id}-${suffix}.png`), omitBackground: true, clip: { x: 0, y: 0, width: canvas, height: canvas } });
    }
    console.log(`app-icons: ${id}`);
  }
} finally {
  await browser.close();
}
