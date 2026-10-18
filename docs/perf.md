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

## Round 3 (2026-10-18): voice page, DM call stage and perk art out of the startup bundle

- `ui/lazyModule.ts`: a module loaded on first use (`use()` returns null until it arrives) and warmed at idle after the first paint
  with the settings screens (`preloadLazyModules()` in main.tsx). A failed fetch is retried on the next mount.
- The voice channel page (with the Stremio, Spotify, Watch Together and game tiles and panels) loads through
  `voice/LazyVoiceChannelPage.tsx`, which shows the page's empty stage until it is in. The DM call stage moved to `calls/CallPanel.tsx`;
  `CallUi.tsx` mounts it the same way, with the bare `.dm-call` section as the placeholder.
- Perk art (avatar decorations, nameplate scenes, profile frames and scenes, ~118 kB) loads the same way. It overlays the avatar, row or
  card, so nothing moves when it appears; a nameplate shows its gradient at once.
- `AppShell`, `Modals`, `VoiceChannelUsers` and `VoiceChannelRow` import `StremioViewerHost`, `WatchModal` and `StremioIcon` by path:
  the feature indexes import CSS, so a barrel import kept the panels in the entry.

home server M4, load average 10-44 during the runs; before = main a640f747, after = this branch; 5 interleaved runs each, medians.

| Metric | Before | After |
|---|---|---|
| Initial JS | 1,518 kB (469 kB gzip) | 1,309 kB (414 kB gzip) |
| Initial CSS | 567 kB (97 kB gzip) | 538 kB (91 kB gzip) |
| Cold start to first channel messages | 290 ms | 290 ms |
| Cold start, 4x CPU and 20 Mbit/s | 1,285 ms (FCP 696 ms) | 1,223 ms (FCP 676 ms) |
| Boot with `?seed=big` | 186 ms | 168 ms |
| Cold open of #firehose / warm switch | 128 / 65 ms | 133 / 68 ms |

Unthrottled timings are within run-to-run noise on a local mock backend; the smaller entry matters on slow networks and CPUs.
Left in the entry and under 20 kB each: `VoiceConnectionPanel` (8 kB, shows on join), `StageView` (5 kB, shares a file with the
sidebar's live pill) and the event wizard (12 kB).

## Round 4 (2026-10-18): restart cache, cold start in WebView2

`cache/startupCache.ts` keeps one snapshot per user in IndexedDB (`vokko-startup-cache`). It holds a trimmed READY: every guild, but
channels and members only for the open server, plus DMs, read states and the server layout. It also holds the open channel with its
newest 50 messages, and only when that page reaches the end. No attachment blobs are stored; URLs only.
- The snapshot is capped at 2 MB serialized (a bigger one deletes the record).
- It is saved 3 s after READY, after a channel switch or after new messages there, and at once when the window is hidden.
- Sign-out or a rejected token deletes it. A different token never reads it: the owner tag is a hash of the token.
- At start (before React mounts, given up after 400 ms), a matching snapshot fills the store and the app opens on that channel. The
  app is stale until READY: the composer is replaced by "Connecting… You can send messages once Vokko is back online." The real READY
  then replaces the cached state, and the message store refetches the open channel.

`apps/desktop/scripts/webview2-startup.mjs` drives a release build (`npx tauri build --no-bundle`) over CDP with its own WebView2 and
config folders. It reports the time from process launch and from navigation start to the first painted messages
(`vokko:first-messages`) and to READY (`vokko:ready`), the JS heap after a GC, and the private bytes of the app and its WebView2
processes. "Before" is the same build with the cache owner removed before each exit, which is the old path: Splash, then READY, then
Home, then click the server.

Setup: PC (an 8-core desktop CPU, Windows 11, WebView2), with a real `vokko-server` (seeded) on the VPS reached through an SSH tunnel, so
READY and the message fetch pay a real round trip. Medians of 4 runs without the cache (the first run was dropped: the owner removal
had not been written yet) and 5 with it.

| Metric | Before (no cache) | After (cache) |
|---|---|---|
| Launch to first channel messages | 917 ms | 600 ms |
| Navigation start to first channel messages | 607 ms | 313 ms |
| Navigation start to READY | 342 ms | 422 ms |
| First contentful paint | 184 ms | 264 ms |
| JS heap after GC | 10.4 MB | 10.6 MB |
| Private bytes: WebView2 processes (8) / app | 404 MB / 7.2 MB | 339 MB / 7.1 MB |

- The messages now paint before READY. The time saved is the network: READY, then the guild click, then the message fetch.
- READY comes about 80 ms later because the IndexedDB read and the first render run before the gateway connects.
- FCP moves for the same reason: the first paint is now the full channel, not the Splash.
- The old path also renders Home on the way to the server, so it ends with about 65 MB more WebView2 memory.
- On a slower link the gain grows with the round trip, because the cached path does not wait for the network at all.

## Channel open, frame by frame (perf-3)

`npx playwright test -c e2e/perf.config.ts channel-open` (`e2e/channel-open.perf.bench.ts`): after every painted frame from the click
on a channel link, it checks whether the newest message sits at the bottom of the list. It reports frames and ms to the first correct
frame, frames that showed rows in the wrong place, and whether the bottom held for the next 30 frames. Channels with 6 messages, 40
(one page) and `#firehose`; cold = first open, warm = median of 9 reopens.

The revert in 7146388e (back to `initialTopMostItemIndex`) was not a list bug: the system-messages spec right-clicked the third
rendered row, which sits above the viewport, so Playwright scrolled the list up. On main a late height change pulled it back down. With
`initialScrollTop` the layout was already settled, so the scroll stuck. The spec now right-clicks a row that is on screen. A new test in
messages.spec checks that the list stays at the bottom after a dialog opens and closes.

What changed in `MessageList`: it opens with `initialScrollTop` again, `skipAnimationFrameInResizeObserver` (rows are measured in the
ResizeObserver callback, not a frame later; the "ResizeObserver loop" errors it logs are benign and the crash reporter ignores them), and
the scroller mounts with `.settling` (hidden) until the newest row ends inside the viewport (checked after layout and once per frame,
at most 10 frames). That hides the one frame of rows placed from estimated heights.

| home server M4, loaded machine; main / branch / main run back to back | main | branch |
|---|---|---|
| 6 messages, reopen | 5 frames, 69-71 ms | 2 frames, 24 ms |
| 40 messages, reopen | 5 frames, 72 ms | 3-4 frames, 34-44 ms |
| #firehose, reopen | 5 frames, 70-72 ms | 3-4 frames, 39-42 ms |
| First open (all three) | 7-8 frames, 100-136 ms | 4-6 frames, 65-83 ms |
| Frames with rows in the wrong place | 0 | 0 |
| #firehose: newest row stays put for 30 frames after opening | 4-5 of 9 reopens | 9 of 9 |
