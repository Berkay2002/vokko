// Vite plugin: bundles each built-in game's source (games/<name>/main.ts or main.tsx) into /games/<name>/game.js.
//
// Built-in games run in an opaque-origin frame, where module scripts would need CORS headers, so each game is one classic
// IIFE script next to its static files in public/games/<name>/ (docs/games-sdk.md). Games without a source folder
// (Sketch) are plain files in public/ and are not touched. Kept as a plain .mjs so tsconfig does not need node typings.

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'games');

function entries() {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT, { withFileTypes: true })
    .filter(dir => dir.isDirectory() && !dir.name.startsWith('_'))
    .map(dir => ({ name: dir.name, entry: ['main.ts', 'main.tsx'].map(f => join(ROOT, dir.name, f)).find(existsSync) }))
    .filter(game => game.entry);
}

async function bundle(entry, minify) {
  const out = await build({
    configFile: false,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': JSON.stringify(minify ? 'production' : 'development') },
    build: { write: false, minify, sourcemap: minify ? false : 'inline', lib: { entry, formats: ['iife'], name: 'VokkoGame', fileName: () => 'game.js' } },
  });
  const chunk = [out].flat().flatMap(o => o.output).find(o => o.type === 'chunk');
  return chunk.code;
}

export default function gamesBundles() {
  return {
    name: 'vokko-games-bundles',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const match = /\/games\/([^/]+)\/game\.js$/.exec((req.url ?? '').split('?')[0]);
        const game = match && entries().find(g => g.name === match[1]);
        if (!game) return next();
        try {
          res.setHeader('Content-Type', 'text/javascript');
          res.end(await bundle(game.entry, false));
        } catch (err) {
          next(err);
        }
      });
    },
    async generateBundle() {
      for (const game of entries()) this.emitFile({ type: 'asset', fileName: `games/${game.name}/game.js`, source: await bundle(game.entry, true) });
    },
  };
}
