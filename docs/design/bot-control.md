# Who controls media in a call (design)

Status: built (server), 2026-10-17, branch `worktree-botctl-server` (commits 28720c4, c60dc87, 5bc5719); owner answers in §7. The
desktop half (§4) is built separately. It covers Watch Together, the Stremio bot and the Spotify bot. §1 is the state before
the build; §2 and §3 describe what was built. Open follow-up in §8.

Goal: in a big call, one person can no longer pause, seek, skip, stop or replace what everyone is watching or hearing. Small
groups keep today's "anyone in the call controls" with no setup.

## 1. Findings (what exists today)

- **One check for everything: being in the call.** `require_in_voice` (`crates/server/src/voice/watch.rs:81`) checks that the
  caller is connected to that channel's voice and would still be admitted (VIEW_CHANNEL + CONNECT and not timed out in a guild,
  recipient and not blocked in a DM call), refuses stage channels (400 wrong channel type), else 403 50013. Watch Together's
  `start`, `control` and `stop` (`watch.rs:106`, `:127`, `:181`) and Stremio's `start`, `control`, `stop` and `viewer_token`
  (`voice/stremio.rs` `start`, `control`, `stop`, `viewer_token`) call it and nothing else. The Spotify design copies it
  (spotify-bot.md §4.2 "Rules"). Nobody has more rights than anyone else in the call.
- `require_in_voice` already gets the caller's channel permissions from `admit_guild` / `admit_dm`
  (`voice/state.rs:425`, `:440`, both return `(Option<i64>, u64)`) and throws them away (`watch.rs:91`).
- **`started_by` is display only.** Watch keeps it across video changes (`watch.rs:112-115`), Stremio too (`stremio.rs`
  `start`, "Changing the item keeps the queue and who started the session"). The tiles show "Started by X"
  (`apps/desktop/src/watch/WatchTile.tsx:217`, `stremio/StremioTile.tsx:117`). Nothing reads it for access.
- **Queues have a total cap, no per-user cap.** Watch 20 (`WATCH_TOGETHER_QUEUE_MAX`, `crates/protocol/src/api.rs:1425`,
  check `watch.rs:167`), Stremio 10 (`STREMIO_QUEUE_MAX`, `api.rs:1484`, check in `stremio.rs` `control`), Spotify 200
  (design). Watch's queue is `Vec<String>` with no adder; Stremio's items carry `added_by` (`StremioQueueItem`) and anyone
  can `queue_remove` any index.
- **Clients drive Watch's auto-advance.** Every client in the call runs the iframe player (the tile renders in strip and pip
  too) and sends `PATCH {skip: true, video_id}` when it ends or fails to play (`WatchTile.tsx:97-100`, `:264`); the
  `video_id` guard makes all but the first a no-op (`watch.rs:145-149`). Clients also fill in the title, only while it is
  unset (`WatchTile.tsx:116`). Stremio's and Spotify's bots report the end themselves (`stremio.rs` `bot_event`/`advance`).
- **Starter leaving changes nothing**; the session ends when the last person leaves (`voice/state.rs` `release_channel`,
  which runs on every leave and calls `stremio::user_left`). `VoiceEntry.connected_at` is set on join, not on token refresh.
- **Permissions** are Discord's bit values, 0..53 minus 47 (`api.rs:223-280`, `ALL`, `NAMED`, `DEFAULT_EVERYONE` with a
  27-bit test at `api.rs:4668`). Role writes reject bits outside `ALL` (`routes/moderation.rs:742-748`), app permissions
  mask with `ALL` (`apps.rs:362`). The @everyone role's id is the guild id (`routes/guilds.rs:86`). The desktop mirrors
  the bits in `apps/desktop/src/api/permissions.ts` (`PermBit`, `ALL_PERMISSIONS` loops 0..=53) and lists them in the role
  editor (`shell/settings/permissions.ts`, "Voice Channel Permissions" group).
- The desktop copy says "Anyone in the call can pause, skip or queue the next one" (`watch/WatchModal.tsx:48`).

## 2. Decisions

### 2.1 A new permission: Control Media

- `CONTROL_MEDIA = 1 << 60`, name `CONTROL_MEDIA`, UI label "Control Media" in the Voice Channel Permissions group, help
  text "Members can pause, seek, skip, stop and reorder Watch Together, Stremio and Spotify in calls they are in."
- Discord has no such bit (it has no music bots of its own, and its Activities handle control inside each app), so this is
  a Vokko-only bit. It goes high (60), not in the free 47 or the next Discord slot 54, so Discord's future bits never
  collide. It fits the `BIGINT` columns and the desktop's `bigint`.
- **It is on @everyone by default.** That *is* the "everyone controls" setting, and it is per server (the @everyone role)
  and per channel (a channel overwrite denying it to @everyone, granting it to a role) with no new setting, table or UI:
  the role editor and channel permissions screens already do this. A server owner who wants DJ mode removes it from
  @everyone and gives it to a "DJ" role or to moderators. Reason for the default: Vokko servers are small friend groups and
  today's behaviour is "everyone", so nothing changes for anyone until an admin opts in.
- Administrators and the owner get it through `ALL`, as with every bit.
- **DM and group DM calls have no permissions: everyone in the call controls**, as today (a group DM has at most 10 people).

### 2.2 Who controls a session

A **controller** of a session is someone in the call (the `require_in_voice` rule, unchanged) who is either:
1. in a DM call, or
2. holds CONTROL_MEDIA in that channel (role + overwrites, timeout already refused by the admit check), or
3. the session's **host**.

The host is a new field: `host_id`. It starts as `started_by` (who started the session) and moves when the host leaves the
call: to the person in the call (`VoiceEntry` of that channel) with the earliest `connected_at` (the existing field, set on
join and not on token refresh; ties go to the lower user id). If nobody is left, the session ends as today.
`started_by` keeps its meaning ("Started by X"). Changing the item (PUT) keeps the host.

**Starting** is open to everyone in the call when nothing is playing (they become host). **Replacing** a running item
(PUT on a running session) is a controller action.

### 2.3 What everyone else in the call can do

| Action | Controller | Everyone else in the call |
|---|---|---|
| Start a session when none runs | yes | yes (becomes host) |
| Replace the current item (PUT) | yes | 403 50013 |
| Play / pause / seek, previous, loop, shuffle (Spotify) | yes | 403 50013 |
| Stremio audio track / burned subtitle | yes | 403 50013 (they change it for everyone) |
| Skip | skips now | skips now if they added the current item (owner confirmed), else counts as a vote (§2.4) |
| Stop (DELETE) | yes | 403 50013 (a vote that skips the last item ends it) |
| Add to the end of the queue | up to the queue max | up to the per-user quota (§2.5) |
| Play next / move / clear / shuffle the queue (Spotify) | yes | 403 50013 |
| Remove a queue entry | any | only their own |
| Set the Watch title | always | only while it is unset (the clients' auto-fill); over a set title it is a silent no-op (200, unchanged), so auto-fill never errors |
| Viewer / listener token, local volume | yes | yes |

No vote-to-stop: skipping the last item already ends the session, so "vote to skip" covers it.

### 2.4 Vote to skip

- Whoever added the current item skips it at once, without a vote (owner confirmed). For a fresh PUT that is the person who
  sent it; for an item taken from the queue it is that entry's adder; for a Spotify track brought back by previous it is whoever
  added it the first time (the history keeps the adder).
- `PATCH {skip: true}` from any other non-controller adds their vote for the current item; `{skip: false}` withdraws it. A
  controller's `skip: true` skips at once (today's behaviour). Watch keeps its `video_id` guard: a vote naming a video that is
  no longer current is a no-op (200, current state).
- **Who counts:** listeners = people connected to the channel's voice who are not deafened (self or server). Bots never count
  (the Stremio and Spotify bots are in the media room, not in voice state). A voter who leaves or deafens loses their vote.
  Deafened people are left out on purpose: they cannot vote, so counting them would let an AFK, deafened majority block every
  skip. The flip side, one listener among deafened people can skip alone, is accepted: a deafened viewer who wants a say undeafens.
- **Threshold:** `skip_needed = max(1, ceil(listeners / 2))`, so 2 people → 1, 3 → 2, 4 → 2, 10 → 5. Half, rounded up, is
  what common music bots use; a controller can always skip.
- **Expiry:** votes belong to the current item. They are cleared whenever the item changes (skip, end, PUT, previous, loop
  replay). No timer: an item ends anyway, and a timer would need a sweep for little gain.
- **Recount** on every vote and whenever the people in the call change: a join, a leave and a self or server deafen or
  undeafen all run `control::refresh` (spawned from `broadcast` and `release_channel`). When votes ≥ needed, the item is
  skipped as a controller skip would (Watch: next video or end; Stremio and Spotify: `advance`).
- **Watch auto-advance keeps working without a controller:** when a video ends or cannot play, every client sends
  `skip + video_id`; from non-controllers those are votes, so it advances once half the listeners' players report it. A
  controller's report advances at once. `shortcut: a call where most listeners' players are stuck (e.g. blocked embeds) will not
  advance by itself; a controller skips. Upgrade only if this happens.`
- `shortcut: a Stremio/Spotify vote that races an item change counts for the new item; add an expected-item key like Watch's
  video_id if that bites.`

### 2.5 Per-user queue quota

Non-controllers may have at most this many entries of their own in the queue at once; controllers are bound only by the
queue max. Watch 3 (of 20), Stremio 2 (of 10), Spotify 10 (of 200). New constants `WATCH_TOGETHER_QUEUE_PER_USER`,
`STREMIO_QUEUE_PER_USER`, `SPOTIFY_QUEUE_PER_USER` in `crates/protocol/src/api.rs`. A Spotify album or playlist added by a
non-controller adds what fits in their quota, and the response's "left out" count (spotify-bot.md §4.2) says the rest; the same
cap applies to the rest of an album or playlist a non-controller starts on an idle session. The quota is checked only on add. A Spotify track that
loop `queue` appends again after it played (or that `previous` puts back) keeps its adder and counts as theirs, but is never
refused or dropped: their own playing track coming back can put a non-controller one or more above the quota, and they add again
once they are under it (the queue max still bounds everything). Watch
gains a parallel `queue_added_by` list (§3.2) so the server can count and the UI can show "added by".

### 2.6 What happens when people leave

- The host leaves: host moves (§2.2), their skip vote goes, their queued items stay (they were in the call when they added
  them; Stremio already drops them only on unlink, `stremio.rs` `drop_queued_by`).
- Any voter leaves: their vote goes, the threshold drops, which can trigger a skip.
- Last person leaves: the session ends (unchanged).

## 3. API changes

All three keep their routes. Errors reuse existing codes: 403 50013 (not a controller), 400 50035 (quota, field
`queue_add`), 400 40033 (no session), 429.

### 3.1 Shared server helper `crates/server/src/voice/control.rs`

- `in_voice(state, user_id, channel) -> InVoice {channel_id, user_id, is_dm, permissions}` holds the old `require_in_voice`
  body; `require_in_voice` stays as a wrapper returning the channel id, for its other callers (games and the rest).
- `controls(ctx, host_id) -> bool` = `is_dm || permissions & CONTROL_MEDIA != 0 || user_id == host_id`, and
  `require_control(ctx, &MediaControl)` turns a no into 403 50013.
- `Room` (the channel's voice entries, by `connected_at`), `new_session`, `new_item` (clears votes, sets `added_by`),
  `sync` (moves the host if absent, drops votes from non-listeners, recomputes `skip_needed`, says whether the vote passes),
  `skip_request` (controller or adder: skip; else toggle the vote and sync), `quota` (entries left, 400 50035 at zero).
  `skip_needed(n)` lives in `crates/protocol/src/api.rs`.
- `refresh(state, channel_id)` runs `sync` on each of the three sessions in that channel and announces or skips; it is spawned
  from `broadcast` (join, deafen) and from `release_channel` (leave). The existing `stremio::user_left` and
  `spotify::user_left` calls stay as they were.

### 3.2 State objects (additive fields; old clients ignore them)

Each of `WatchTogetherState`, `StremioState` and `SpotifyState` gains these fields, as one `MediaControl` struct flattened
into the state (`#[serde(flatten)]`, so the wire has them at the top level):

```
host_id: Snowflake          // who controls besides CONTROL_MEDIA holders; starts as started_by
skip_votes: [Snowflake]     // voters for the current item, in vote order
skip_needed: u32            // max(1, ceil(listeners / 2)) when the state was sent
added_by?: Snowflake        // who added the current item (PUT caller, or the queue entry's adder); may skip it.
                            // Omitted when there is no current item (an idle Spotify session)
```

`WatchTogetherState` also gains `queue_added_by: [Snowflake]` (same length and order as `queue`; `#[serde(default)]`).
No `can_control` field: events go to everyone, so each client works it out (§4).

### 3.3 Requests

- `WatchTogetherPatchRequest.skip`, `StremioPatchRequest.skip`, Spotify `{skip}`: `true` = skip (controller) or vote,
  `false` = withdraw vote (no-op for a controller). Spotify's `{skip: false}` was a 400 before and is now valid.
- `WatchTogetherPatchRequest.queue_remove: Option<usize>` is **not** added (nobody asked; Stremio and Spotify have removal).

### 3.4 Events

`WATCH_TOGETHER_UPDATE`, `STREMIO_UPDATE`, `SPOTIFY_UPDATE` carry the new fields and are also sent when votes, `skip_needed`
(on a join, leave or deafen) or the host change. Same audience and READY/GUILD_CREATE/`Call` lists as today. No new event.

### 3.5 Permission and migration

- `crates/protocol/src/api.rs`: `CONTROL_MEDIA = 1 << 60`; `ALL` becomes `((1 << 54) - 1 - (1 << 47)) | CONTROL_MEDIA`;
  `NAMED` gets the entry (length 54); `DEFAULT_EVERYONE` gains it (the 27-bit test becomes 28, with a comment that the extra
  bit is Vokko's). The bit-47 test stays.
- Migration `crates/server/migrations/<ts>_control_media.sql`:
  `UPDATE roles SET permissions = permissions | 1152921504606846976 WHERE id = guild_id;` (2^60, @everyone only). Other
  roles and overwrites are untouched; no audit log entry (it changes no effective permission today).
- `docs/api.md`: the three route rows (who may do what, quota, votes), the permission table, and the Watch description in
  `WatchModal.tsx` copy.

## 4. Desktop UI

- `apps/desktop/src/api/permissions.ts`: `PermBit.CONTROL_MEDIA = 60`, `ALL_PERMISSIONS` includes it, Q4.4 fallback
  @everyone set includes it. `shell/settings/permissions.ts`: "Control Media" row in Voice Channel Permissions.
- One hook `useCanControlMedia(channelId, hostId)` (new, in `voice/`): DM channel, or `can(Perm.CONTROL_MEDIA)` via the
  existing channel permission helper, or `hostId === me`. Used by the three tiles and panels.
- **A non-controller sees** the same tile with: play/pause, seek bar, +-10 s, previous, loop, shuffle, Stop and "Play now"
  hidden (not disabled: fewer dead controls); local volume and Up next stay. The Skip button becomes **"Vote to skip
  (1/3)"**, pressed state when they voted (click again withdraws), tooltip "Skips when half the listeners vote". In Up next,
  remove (x) shows only on their own entries; the add form shows "2 of 3 added" and is disabled at the quota. In the
  Stremio and Spotify panels, "Play now" becomes "Add to queue" while a session runs.
- **Everyone** sees a small line under the title when votes exist: "2 of 3 voted to skip" with the voters' avatars, and
  "Host: Alex" next to "Started by" when they differ. A controller's Skip button shows the count too ("Skip, 2 voted").
- An error from a race (403 after losing control) shows in the tile's existing notice line.
- Watch's ended/blocked `skip + video_id` path is unchanged; the server decides whether it is a vote.
- `WatchModal.tsx:48` copy: "Anyone in the call can queue videos. People with Control Media, and whoever started it, can
  pause and skip; everyone else can vote to skip."
- Mock backend (`src/api/mock/watch.ts`, `stremio.ts`, later Spotify) applies the same rules, so e2e and the dev app match.

## 5. Test plan

Server integration (`crates/server/tests/voice.rs` watch tests, `tests/stremio.rs`, `tests/dm_calls.rs`, Spotify's file):
- With CONTROL_MEDIA removed from @everyone: member B (in call, no bit, not host) gets 403 50013 on pause, seek, stop, PUT
  over a running session, queue_remove of A's entry; 200 on queue_add, own queue_remove, vote.
- B starts when nothing plays and becomes host (`host_id`), then pauses (200).
- A role with CONTROL_MEDIA, and a channel overwrite granting it, make B a controller; an overwrite denying it on @everyone in
  one channel makes that channel DJ mode while another stays open (the per-channel setting).
- Default guild (bit on @everyone): every current Watch/Stremio test passes unchanged.
- Votes: 3 listeners, 1 vote → no skip, `skip_votes` = [B], `skip_needed` 2; second vote skips and clears votes; withdraw
  works; a voter leaving drops the vote; a listener leaving makes 1 of 2 enough and skips; a deafened member does not count.
- Watch auto-advance: 3 non-controllers each send `skip + video_id`; the video advances once, at the second report.
- Adder skip: B queues a video, it becomes current, B's `skip: true` skips it with no vote; C's (not the adder) is a vote.
- Host leaves: `host_id` moves to the earliest joiner, announced; last person leaving still ends the session.
- Quota: B's 4th Watch entry → 400 50035 `queue_add`; a controller is not limited; Spotify album from B adds 10 and reports
  the rest left out.
- DM call: both recipients control, no 403s (existing `dm_calls.rs` test extended).
- Migration: an existing @everyone row gains bit 60; a role write with bit 60 is accepted; bit 61 still 400.
- Protocol unit tests: `ALL`/`NAMED`/`DEFAULT_EVERYONE` counts, `skip_needed` table (0→1, 1→1, 2→1, 3→2, 4→2, 5→3).

Desktop: vitest for `useCanControlMedia` (DM, perm, host), mock watch/stremio tests for the 403 and vote paths, one e2e in
`e2e/watch.config.ts` with two users: the non-controller votes and both see the count update.

## 6. Build plan (after the Stremio and Spotify branches merge)

Freeze §3 first (protocol types + docs/api.md in the server worker's first commit), then two workers by file ownership:

1. **Server** (`sonnet@high`): `crates/protocol/src/api.rs` (bit, constants, fields), migration,
   `crates/server/src/voice/control.rs` (new), `voice/watch.rs`, `voice/stremio.rs`, `voice/spotify.rs`,
   `voice/state.rs` (refresh hooks), `routes/moderation.rs` (nothing beyond `ALL`, verify), server tests,
   `docs/api.md`. About 400 lines.
2. **Desktop** (`sonnet@high`, starts once the protocol commit lands): `src/api/types.ts`, `api/permissions.ts`,
   `shell/settings/permissions.ts`, `voice/useCanControlMedia.ts` (new), `watch/WatchTile.tsx`, `watch/WatchModal.tsx`,
   `stremio/StremioTile.tsx`, `stremio/StremioPanel.tsx`, `spotify/*` tile and panel, `api/mock/watch.ts`, `stremio.ts`,
   Spotify mock, tests and the e2e.

A final review (`reviewer`) checks the access rule end to end: every mutating branch of the three `control` handlers goes
through `controls()` or the vote/quota path, none is missed.

## 7. Owner answers (2026-10-17, owner confirmed)

1. Default: everyone controls (CONTROL_MEDIA on @everyone for new and existing servers).
2. Whoever added the current item can skip it without a vote (§2.3, §2.4, `added_by` in §3.2).
3. No host hand-off and no per-session "everyone controls" toggle for now.
4. Vote threshold: half the listeners, rounded up.
5. Quotas per non-controller: Watch 3, Stremio 2, Spotify 10.

## 8. Open follow-ups

- Done (2026-10-18): loop `queue` and the Spotify quota. Re-queued tracks keep their adder and are never refused; the quota
  only gates adding (§2.5), tested in `tests/spotify.rs`.

- Done (2026-10-17): Watch Together has `queue_remove: {index, video_id}` (own entries for everyone, any for controllers, like
  Stremio; a no-op when the entry at `index` is no longer `video_id`), and the Up next panel shows a remove button to whoever may use it.
- Done (2026-10-18): the migration (`20261017130000_control_media.sql`) is tested in `tests/guilds.rs` on rows from before it
  (@everyone gains bit 60, no other bit or role changes), next to the default @everyone bit and the role-write check (bit 60
  accepted, 61 refused).

## 9. Bots acting for the member who asked (2026-10-18)

The owner's Claude bot (later a Codex bot) drives Spotify and Stremio from chat ("play X in our call", "skip"). A bot is never
in a call, so it acts **for the member who asked, with exactly that member's rights**: `X-Vokko-Acting-For: <message_id>` on
the media routes makes the request run as the message's author (`crates/server/src/acting.rs`, the `Actor` extractor the media
handlers take instead of `AuthUser`). Accepted only for a person's own fresh message (at most 10 minutes old by creation time)
addressed to this bot (mention, reply to the bot, or a 1:1 DM with it) in a channel both can see; a channel request must be in
that channel's guild (or be that DM). Every rule in this document then applies to the member: in the call, controller or not,
quota, votes. At most 30 acting requests per message (in memory). `MediaControl.via_bot_id` and the queue entries' `via_bot_id`
name the bot. The bot finds the member's call with `GET /guilds/{id}/voice-states/{user_id}`. Full rules: docs/api.md "Acting
for a member".
