// Vite plugin: the e2e game (public/games/mock/) is for the dev server only, so no build ships it. A plain .mjs for the
// same reason as vite-mediapipe.mjs (no node typings in tsconfig).

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

export default function dropMockGame() {
  let outDir = 'dist';
  return {
    name: 'drop-mock-game',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      rmSync(resolve(outDir, 'games/mock'), { recursive: true, force: true });
    },
  };
}
