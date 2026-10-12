# Third-party assets and credits

Everything below ships inside the app (no CDN at run time). Licences are the upstream ones; keep this list in step with
`apps/desktop/package.json` and `apps/desktop/public/`.

## Noise suppression

- **RNNoise** by Jean-Marc Valin / Xiph.Org Foundation: recurrent neural network noise suppression, BSD-3-Clause.
  <https://github.com/xiph/rnnoise>
- **@sapphi-red/web-noise-suppressor** 0.4.x (MIT): AudioWorklet and WASM build of RNNoise used by
  `apps/desktop/src/voice/rnnoise.ts`. <https://github.com/sapphi-red/web-noise-suppressor>

## Camera backgrounds (blur and replacement image)

- **@livekit/track-processors** 0.8.x (Apache-2.0): background blur / virtual background processor for LiveKit tracks.
- **MediaPipe Tasks Vision** (`@mediapipe/tasks-vision`, Apache-2.0): the WASM runtime, served from `/mediapipe/`
  (copied from node_modules by `apps/desktop/vite.config.ts`, SIMD build only).
- **MediaPipe Selfie Segmenter model** (`selfie_segmenter.tflite`, Apache-2.0, Google):
  `apps/desktop/public/mediapipe/selfie_segmenter.tflite`, 249,537 bytes,
  SHA-256 `191AC9529AE506EE0BEEFA6B2C945A172DAB9D07D1E802A290A4E4038226658B`.
  Source: <https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite>
- The built-in background images are generated gradients drawn by `apps/desktop/src/voice/video/backgrounds.ts`; no
  third-party artwork.

## Sounds

- All notification and voice sounds are synthesised at run time with Web Audio (`apps/desktop/src/notify/sounds.ts`);
  there are no audio files and no third-party sound assets.

## Default soundboard sounds

All default sounds are synthesized by Vokko's own code; there are no recorded clips and no third-party audio.

| Id | Name | How it is made | Code |
| --- | --- | --- | --- |
| 1 | Chime | two decaying sine notes (A5, E6) | `crates/server/src/soundboard/defaults.rs`, `apps/desktop/src/soundboard/synth.ts` |
| 2 | Pop | sine sweep 900 → 200 Hz with a quadratic decay | same |
| 3 | Ding | bell partials (1, 2.76, 5.4 × 660 Hz) with exponential decays | same |
| 4 | Boop | two soft-clipped sine tones (220 Hz, 330 Hz) | same |
| 5 | Fanfare | C-E-G-C arpeggio built from five harmonics | same |
| 6 | Whoosh | low-passed pseudo-random noise with a swept cutoff | same |

The server renders them to 16-bit mono WAV at 22.05 kHz (`GET /api/v1/soundboard-default-sounds/{id}/file`); the in-memory mock
renders the same recipes in the browser. License: same as the Vokko source.

## Profile perks and super reactions

Vokko's profile perk art is its own. Nothing here is taken, traced or adapted from Discord (no Discord images, SVGs, fonts, sounds or
CSS). Every item is generated at runtime from a few parameters in `apps/desktop/src/perks/catalog.ts` (colours, counts, timings),
drawn with inline SVG or CSS, so there are no image files to license.

| Set | Items | How it is drawn | Author / licence |
| --- | --- | --- | --- |
| Avatar decorations | Halo, Aurora, Ember, Frost, Neon, Starlight, Petals, Pixel Frame, Crystal (9) | SVG ring with a gradient, optional dash pattern, glow filter, spin/pulse animation and star/dot/diamond ornaments (`perks/AvatarDecoration.tsx`) | Vokko contributors, same licence as the repository |
| Profile effects | Sparkles, Snowfall, Embers, Rain, Bubbles, Fireflies, Confetti, Petal Drift (8) | CSS particles (dot, flake, spark, streak, ring) with rise/fall/drift/twinkle keyframes (`perks/ProfileEffect.tsx`, `styles/perks.css`) | Vokko contributors, same licence as the repository |
| Nameplates | Aurora, Ember, Tide, Meadow, Dusk, Circuit, Candy, Starfield (8) | CSS gradient with an optional dots/stripes/grid/waves pattern and light sweep (`perks/NameStyles.tsx`, `perks/name-styles.css`) | Vokko contributors, same licence as the repository |
| Display name fonts | Default, Serif, Mono, Rounded, Script, Display, Light, Condensed (8) | Font stacks of the bundled Noto Sans and the viewer's system/generic families; no font files are downloaded | Noto Sans: SIL Open Font License 1.1; system fonts belong to the viewer's OS |
| Display name effects | Solid, Gradient, Neon, Toon, Pop, Shimmer, Glitch, Embossed (8) | CSS colour, gradient text, text-shadow and keyframes (`perks/name-styles.css`) | Vokko contributors, same licence as the repository |
| Profile themes, server tag badges | 8 theme presets; tag badges use Lucide icons | Colour pairs; `lucide-react` glyphs | Lucide: ISC licence |
| Super reaction glow and particles | one style, coloured per emoji | Colours sampled from the emoji at runtime (`perks/emojiColors.ts`), CSS particles (`perks/super-reactions.css`) | Vokko contributors; emoji glyphs are the viewer's system emoji font |

Animated items respect reduced motion (the app setting and the OS setting); the super reaction particles also stop when "Play
animated emoji" is off.
