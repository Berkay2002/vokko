# Vokko games SDK

A web game can run inside a Vokko call as an Activity. Vokko loads it in a sandboxed iframe on the call grid, and
the game talks to the app through `vokko-games.js`. Design background: `docs/design/games-host.md`.

## Getting listed

A member with Manage Server adds the game under Server Settings > Activities: a name, an `https://` URL (not the
Vokko server's own address), an optional emoji icon, a player range and an aspect ratio (`16:9`, `4:3`, `1:1` or
`fill`).

The frame gets `sandbox="allow-scripts allow-same-origin allow-pointer-lock"`, `allow=""` and no referrer. That
means no popups, no top navigation, no form submission (send data with the SDK; `<form>` submit events never fire),
no modals, and no camera, microphone, clipboard, fullscreen or autoplay. Audio needs a click inside the frame.

## Protocol (v1)

1. The game posts `{vokko: "hello", v: 1}` to `window.parent` (target `"*"`).
2. The host checks the sender and origin and answers `{vokko: "init", v: 1}` with a `MessagePort`. That is the only
   window message; after it everything goes over the port, and later window messages are ignored.

Host to game, on the port:

| Message | When |
|---|---|
| `{type: "init", game_id, me, players, leader}` | once, first |
| `{type: "players", players, leader}` | someone joined or left the call |
| `{type: "message", from, data}` | another player sent `data` |
| `{type: "error", code}` | `rate_limited`, `too_large`, `invalid` or `not_running` |
| `{type: "close"}` | the tile is about to unload; stop sounds |

Game to host: `{type: "ready"}` (first frame drawn), `{type: "send", data, to?}`, `{type: "close"}` (closes the
tile for this user; the session keeps running for the others).

A player is `{app_id, name, avatar}`. `app_id` is a 22-character id that is stable for one user in one game and
different in every other game; it is not the Vokko user id. `avatar` is a 128 px PNG `Blob` or `null`. `leader` is
the starter's app id while they are in the call, else the smallest app id present; every client computes the same
one, so use it when the game needs one authority. `players` is everyone in the call, not only those who have the
game open.

## SDK

Load it as a classic script (not `type="module"`; built-in games run in an opaque-origin frame where module
scripts need CORS headers). Copy `apps/desktop/public/games/vokko-games.js` next to your game; it has no
dependencies.

```js
const vokko = await VokkoGames.connect(); // rejects after 5 s without a host: show "Open this inside Vokko"
vokko.me; vokko.players; vokko.leader; vokko.gameId;
const off = vokko.on("message", (data, from) => {}); // also "players" (players, leader), "error" (code), "close" ()
vokko.send(data);        // everyone else in the call
vokko.send(data, appId); // one player
vokko.ready();
vokko.close();
```

## Limits

- `data` is JSON, at most 4096 bytes serialized. Larger messages are rejected with `too_large`.
- About 20 messages a second per player (bursts to 40) and 30 a second per call (bursts to 60). Over that you get
  `rate_limited`. Batch high-rate input, for example pointer moves every 100 ms.
- The sender does not receive its own messages. Apply your own moves locally.
- Relayed data comes from other players and is untrusted. Check its shape, and render text with `textContent`,
  never `innerHTML`.
- The server keeps no game state. If your game needs some, keep it in the clients (see below).

## Late join: `sync?` and a snapshot

People open the game tile at different times and can close and reopen it, and `players` does not tell you who has
the game open. So let the joiner ask:

1. On connect, before `ready()`, send `{t: "sync?", a: 1}` to everyone and show "Joining...". Retry every 2 s
   (`a: 2`, `a: 3`). With no answer after the third try, start fresh as if alone.
2. Every open copy keeps the full public state. The leader answers every `sync?` with `send(snapshot, asker)`;
   the others answer only from `a: 2` on, in case the leader's copy is closed. Split the snapshot into chunks under
   4 KB, each with the round number, an index `i` and a `total`.
3. The joiner takes the chunks of the first copy that answers and ignores the others.
4. While waiting, it buffers live messages, then applies them after the snapshot. Give incremental messages a
   sequence number so it can skip the ones the snapshot already holds.

`public/games/sketch/sketch-core.js` implements this pattern and has tests in `apps/desktop/src/games/sketch.test.ts`.

## Example

```html
<!doctype html>
<meta charset="utf-8" />
<button id="b" disabled>Clicks: 0</button>
<script src="vokko-games.js"></script>
<script>
  (async () => {
    const b = document.getElementById("b");
    let clicks = 0;
    const show = () => (b.textContent = `Clicks: ${clicks}`);
    const vokko = await VokkoGames.connect().catch(() => null);
    if (!vokko) return void (b.textContent = "Open this inside Vokko");
    vokko.on("message", (data) => { if (typeof data?.clicks === "number") { clicks = data.clicks; show(); } });
    b.onclick = () => { clicks += 1; show(); vokko.send({ clicks }); };
    b.disabled = false;
    vokko.ready();
  })();
</script>
```
