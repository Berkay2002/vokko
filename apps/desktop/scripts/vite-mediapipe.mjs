// Vite plugin: serves and emits MediaPipe's WASM at /mediapipe/ for camera backgrounds.
//
// The segmenter runs locally. Its WASM comes from the npm package (@mediapipe/tasks-vision, a dependency of
// @livekit/track-processors) and is served from this app, never from a CDN: the app has to work offline and under the
// Tauri CSP. The model (selfie_segmenter.tflite) sits in public/mediapipe. Only the SIMD build is shipped: every WebView2
// and WKWebView we target has it. Kept as a plain .mjs so tsconfig does not need node typings (see the .d.mts next to it).

import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];

export default function mediapipeAssets() {
  // The package's "exports" hides package.json, so resolve its entry and walk up to the folder that holds wasm/.
  const wasmDir = () => {
    let dir = dirname(createRequire(import.meta.url).resolve('@mediapipe/tasks-vision'));
    while (!existsSync(join(dir, 'wasm')) && dirname(dir) !== dir) dir = dirname(dir);
    return join(dir, 'wasm');
  };
  const type = name => (name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  return {
    name: 'vokko-mediapipe-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.includes('/mediapipe/')) return next();
        const name = url.slice(url.lastIndexOf('/') + 1);
        if (!FILES.includes(name)) return next();
        const file = join(wasmDir(), name);
        if (!existsSync(file)) return next();
        res.setHeader('Content-Type', type(name));
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const name of FILES) this.emitFile({ type: 'asset', fileName: `mediapipe/${name}`, source: readFileSync(join(wasmDir(), name)) });
    },
  };
}
