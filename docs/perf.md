# Client performance

Target: Vokko should feel as fast as Discord with big servers and long histories. This page holds the harness and its numbers.

## Harness

From `apps/desktop`:

```sh
PERF_LABEL=after npx playwright test -c e2e/perf.config.ts      # writes perf-results/after.json (gitignored)
npx vite build --sourcemap && node scripts/bundle-report.mjs     # what the first paint downloads, per package
```

- `?seed=big` (mock backend, `src/api/mock/seedBig.ts`) adds **Big Server**: 200 channels in 10 categories, 5,000 members (a third
  online, five hoisted roles) and `#firehose` with 20,000 messages over 60 days (text, markdown, code blocks, replies, image
  attachments, rich embeds, reactions).
- The perf config serves a production build with React's profiling renderer (`vite build --mode perf`, `react-dom/client` aliased to
  `react-dom/profiling`) from `vite preview` on port 1445, so numbers are close to a release build and `<Profiler>` still reports.
- `<Measure id>` (`src/perf/Measure.tsx`) wraps the rail, the channel list, the message list and the member list in a React
  `<Profiler>`; in mock builds `window.__vokkoPerf.stats` counts commits and render time per area.
- Measurements (`e2e/perf.bench.ts`), headless Chromium 1440x900, mock latency 0:
  - **Channel switch**: click a channel link until the new list is rendered and two frames painted. Cold = first open of
    `#firehose`; warm = median of 5 switches back to it; to-empty = median of 5 switches to an empty channel. Member list open.
  - **Member list open**: click "Show Member List" until the first row is painted (median of 3).
  - **Member list scroll**: 20,000 px scroll gesture at 6,000 px/s; frames per second.
  - **Gateway churn**: 100 presence updates, 50 typing starts in the open channel and 50 messages in another channel; React
    commits and render time per area, and wall time until the page settles.
  - **Message scroll**: 30,000 px upward scroll gesture at 3,000 px/s through `#firehose` (older pages load on the way); FPS,
    95th percentile frame time, frames over 50 ms.
  - **Memory**: keep scrolling up until 5,000 messages are loaded, force GC, read `JSHeapUsedSize` and the DOM node count.
  - **Bundle**: `vite build`; initial = entry chunk + statically imported chunks + entry CSS (`scripts/bundle-report.mjs`).

## Results

Machine: an 8-core desktop CPU, Playwright headless Chromium (chromium_headless_shell-1248). Single runs; channel switch and member list are medians.
Before = `3dd6fd4` (harness only), after = this branch.

| Metric | Before | After |
|---|---|---|
| Channel switch, cold open of #firehose | 1,987 ms | 245 ms |
| Channel switch, warm (median) | 1,797 ms | 120 ms |
| Channel switch to an empty channel (median) | 1,574 ms | 55 ms |
| Member list open (median) | 4,179 ms | 53 ms |
| Member rows in the DOM | 5,000 | 27 |
| Member list scroll | 49.6 fps | 60 fps, 0 long frames |
| Gateway churn (200 events): wall time | 24,939 ms | 2,830 ms |
| … member list commits / render time | 150 / 33,788 ms | 200 / 121 ms |
| … channel list commits / render time | 50 / 913 ms | 50 / 43 ms |
| … rail commits / render time | 50 / 24 ms | 1 / 0.1 ms |
| … message list commits / render time | 200 / 202 ms | 150 / 24 ms |
| Message scroll | 21.3 fps, p95 frame 83 ms, 149 frames > 50 ms | 54.2 fps, p95 frame 17 ms, 2 frames > 50 ms |
| Heap after scrolling 5,000 messages | 108.1 MB | 34.2 MB |
| DOM nodes after scrolling 5,000 messages | 56,355 | 5,528 |
| Message rows in the DOM | 16 | 19 |
| Initial JS | 1,299 kB (390 kB gzip) | 950 kB (296 kB gzip), 14 lazy chunks |
| Initial CSS | 431 kB (68 kB gzip) | 430 kB (69 kB gzip) |

Notes on the baseline:
- The message list was already windowed (`react-virtuoso`, paged loads around the viewport); only ~16 rows are in the DOM.
- The member list rendered all 5,000 members, each row with two store subscriptions: every store change ran 10,000 selectors and
  every presence update re-sorted and re-rendered the whole list. That dominates channel switch, scroll and churn numbers.

What changed:
- **Member list** (`shell/MemberList.tsx`): one flat `react-virtuoso` list of section titles and rows (no new dependency), sorted
  with an `Intl.Collator` only when the member map changes; presence changes re-split the sorted list in O(n). Rows are memoized.
  Section titles scroll with the list as in Discord; they are not sticky.
- **Re-renders** (`AppShell`, `GuildSidebar`, `ServerRail`, `chat/shell.ts`, `ChatContext`): the shell no longer subscribes to the
  guild's channel list (only to the redirect target), the rail, channel list, message view and member list are memoized panes,
  channel rows get `selected` as a prop instead of each reading the location, rail items select an id instead of a channel array,
  and the chat context ignores `last_message_id` / `message_count` bumps on the open channel.
- **Message list**: already windowed; message rows now mount their hover toolbar on first hover or focus, which is most of the DOM
  node and heap drop.
- **Bundle**: syntax highlighting (lowlight + grammars), User / Server / Channel Settings, the QR encoder and the mock backend are
  separate chunks. Highlighting and settings are preloaded at idle after first paint, so code blocks rarely show uncoloured and
  settings open without a fallback. The mock backend chunk is only fetched in mock builds (before bootstrap). Emoji data
  (`data`, `joypixels`) and the LiveKit voice/video transport were already lazy chunks; there is no MediaPipe in the client yet. CSS is not split: the theme and shell styles are needed for the first paint.

## Round 2 (2026-10-18): startup bundle regrowth, cold start, channel open

The initial bundle had grown back to 2,166 kB (633 kB gzip) through three static imports:
- `stremio/viewerConnection.ts` imported `viewer.ts`, which pulls in all of livekit-client (508 kB) from the voice sidebar. It now
  imports it when a viewer Room opens.
- The rail context menu (`shell/menus.tsx`) imported `serverSettingsSections` from `ServerSettings.tsx`, which pulled every Server
  Settings page into the entry. The section list lives in `shell/settings/serverSections.ts`; `ServerSettings.tsx` imports
  Onboarding, Soundboard and Games settings by path, so the feature indexes no longer drag them in.
- The profile editor is a lazy modal like the settings screens (preloaded at idle with them).

A new step, **cold start**, opens `/channels/@me?as=sam` in a fresh context, clicks the first guild as soon as its icon exists
and stops when its messages are painted (median of 5, also with 4x CPU and 20 Mbit/s). `VOKKO_PERF_PORT` overrides the port.

The message list opens at the bottom with `initialScrollTop` instead of `initialTopMostItemIndex`: react-virtuoso waits four frames
before scrolling to an initial index and then paints one frame of the wrong rows. Jump-to-message still uses the index.

| Metric (home server M4, loaded machine) | Before | After |
|---|---|---|
| Initial JS | 2,166 kB (633 kB gzip) | 1,511 kB (466 kB gzip) |
| Cold start to first channel messages | 361 ms | 305 ms |
| Switch back to a visited channel (median) | 92 ms | 68 ms |
| Cold open of #firehose | 160 ms | 129 ms |
| Message scroll frames > 50 ms (30,000 px) | 4 | 1 |

A trace of a 250,000 px scroll through 2,450 messages shows no main-thread task over 50 ms.
