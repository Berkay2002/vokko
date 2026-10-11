// Bundle report for the perf harness: what the first paint downloads, and what each entry chunk is made of.
//   npx vite build --sourcemap && node scripts/bundle-report.mjs [--json] [--dist <dir>]
// "Initial" = the entry chunk plus everything it imports statically (modulepreload in dist/index.html) plus the entry CSS.
// Per-module sizes come from the source maps (minified bytes attributed to each source file).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const distArg = process.argv.indexOf('--dist');
const dist = path.resolve(distArg > 0 ? process.argv[distArg + 1] : 'dist');
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.(?:js|css))"/g)].map(m => m[1]);
const all = fs.readdirSync(path.join(dist, 'assets')).filter(f => /\.(js|css)$/.test(f)).map(f => `assets/${f}`);

const size = rel => {
  const buf = fs.readFileSync(path.join(dist, rel));
  return { raw: buf.length, gzip: zlib.gzipSync(buf, { level: 9 }).length };
};
const sum = list => list.reduce((acc, rel) => { const s = size(rel); return { raw: acc.raw + s.raw, gzip: acc.gzip + s.gzip }; }, { raw: 0, gzip: 0 });

const initialJs = refs.filter(r => r.endsWith('.js'));
const initialCss = refs.filter(r => r.endsWith('.css'));
const lazy = all.filter(r => !refs.includes(r));

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** Minified bytes per package / source folder of one chunk, from its source map. */
function attribute(rel) {
  const file = path.join(dist, rel);
  if (!fs.existsSync(`${file}.map`)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const map = JSON.parse(fs.readFileSync(`${file}.map`, 'utf8'));
  const bySource = new Map();
  let source = 0;
  map.mappings.split(';').forEach((line, li) => {
    const segs = [];
    let col = 0;
    for (const seg of line.split(',')) {
      if (!seg) continue;
      const vals = [];
      let v = 0, shift = 0;
      for (const ch of seg) {
        let d = B64.indexOf(ch);
        const more = d & 32;
        d &= 31;
        v += d << shift;
        if (more) shift += 5;
        else { vals.push(v & 1 ? -(v >>> 1) : v >>> 1); v = 0; shift = 0; }
      }
      col += vals[0];
      if (vals.length > 1) source += vals[1];
      segs.push([col, vals.length > 1 ? source : -1]);
    }
    const len = (lines[li] ?? '').length;
    segs.forEach(([c, s], i) => {
      const end = i + 1 < segs.length ? segs[i + 1][0] : len;
      const key = s < 0 ? '(runtime)' : map.sources[s];
      bySource.set(key, (bySource.get(key) ?? 0) + end - c);
    });
  });
  const groups = new Map();
  for (const [k, v] of bySource) {
    const pkg = k.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
    const g = pkg ? `npm:${pkg[1]}` : k.replace(/^.*?\/src\//, 'src/').replace(/\/[^/]+$/, '/');
    groups.set(g, (groups.get(g) ?? 0) + v);
  }
  return [...groups].sort((a, b) => b[1] - a[1]);
}

const report = {
  initial: { js: sum(initialJs), css: sum(initialCss), files: refs },
  lazy: lazy.map(rel => ({ file: rel, ...size(rel) })).sort((a, b) => b.raw - a.raw),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report));
} else {
  const kb = n => `${(n / 1024).toFixed(1)} kB`;
  console.log(`initial JS  ${kb(report.initial.js.raw)} (gzip ${kb(report.initial.js.gzip)})`);
  console.log(`initial CSS ${kb(report.initial.css.raw)} (gzip ${kb(report.initial.css.gzip)})`);
  for (const rel of initialJs) {
    console.log(`\n${rel}`);
    for (const [k, v] of attribute(rel).slice(0, 30)) console.log(`${kb(v).padStart(10)}  ${k}`);
  }
  console.log('\nlazy chunks');
  for (const c of report.lazy) console.log(`${kb(c.raw).padStart(10)}  ${c.file}`);
}
