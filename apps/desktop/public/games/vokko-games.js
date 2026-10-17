// @ts-check
/*
 * Vokko games SDK, protocol v1 (docs/games-sdk.md). No dependencies, no build step.
 *
 *   <script src="vokko-games.js"></script>          // a classic script: defines window.VokkoGames
 *   const vokko = await VokkoGames.connect();        // rejects after 5 s outside Vokko
 *   vokko.on("message", (data, from) => ...); vokko.send({ hello: 1 }); vokko.ready();
 *
 * A classic script, not an ES module, on purpose: built-in games run in an opaque-origin frame (sandbox without
 * allow-same-origin), where the browser fetches module scripts with CORS and blocks them unless the server sends
 * Access-Control-Allow-Origin. Classic scripts load from any server as is.
 *
 * Handshake: the game posts {vokko:"hello", v:1} to its parent; the host answers {vokko:"init", v:1} with a MessagePort.
 * After that only the port is used; later window messages are ignored.
 */

/** @typedef {{ app_id: string, name: string, avatar: Blob | null }} VokkoPlayer */
/** @typedef {unknown} VokkoJson  JSON-serializable data; relayed data is untrusted, check its shape before use. */
/** @typedef {"rate_limited" | "too_large" | "invalid" | "not_running"} VokkoErrorCode */
/**
 * @typedef {{
 *   players: (players: VokkoPlayer[], leader: string) => void,
 *   message: (data: VokkoJson, from: string) => void,
 *   error: (code: VokkoErrorCode) => void,
 *   close: () => void,
 * }} VokkoEvents
 */
/** @typedef {Awaited<ReturnType<typeof VokkoGames.connect>>} VokkoSession */

var VokkoGames = (() => {
  const TIMEOUT_MS = 5000;

  class Session {
    /** @param {MessagePort} port @param {any} init */
    constructor(port, init) {
      this.port = port;
      /** @type {string} */ this.gameId = String(init.game_id); // opaque per game session, not the catalog id
      /** @type {VokkoPlayer} */ this.me = init.me;
      /** @type {VokkoPlayer[]} */ this.players = init.players;
      /** @type {string} */ this.leader = init.leader;
      /** @type {{ [K in keyof VokkoEvents]: Set<VokkoEvents[K]> }} */
      this.handlers = { players: new Set(), message: new Set(), error: new Set(), close: new Set() };
      port.onmessage = (event) => this.#receive(event.data);
      // An Escape the game did not handle hands focus back to Vokko (the host cannot see keys inside the frame).
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !event.defaultPrevented) port.postMessage({ type: "escape" });
      });
    }

    /**
     * Subscribe to an event; returns a function that unsubscribes.
     * @template {keyof VokkoEvents} K
     * @param {K} event @param {VokkoEvents[K]} fn
     * @returns {() => void}
     */
    on(event, fn) {
      const set = /** @type {Set<VokkoEvents[K]>} */ (this.handlers[event]);
      set.add(fn);
      return () => set.delete(fn);
    }

    /**
     * Relay `data` (JSON, at most 4096 bytes serialized) to everyone else in the call, or to one player's app_id.
     * @param {VokkoJson} data @param {string} [to]
     */
    send(data, to) {
      this.port.postMessage(to === undefined ? { type: "send", data } : { type: "send", data, to });
    }

    /** Tell the host the game has drawn its first frame. */
    ready() {
      this.port.postMessage({ type: "ready" });
    }

    /** Close the game tile for this user only; the session keeps running for the others. */
    close() {
      this.port.postMessage({ type: "close" });
    }

    /** @param {any} msg */
    #receive(msg) {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "players" && Array.isArray(msg.players)) {
        this.players = msg.players;
        this.leader = msg.leader;
        for (const fn of this.handlers.players) fn(this.players, this.leader);
      } else if (msg.type === "message" && typeof msg.from === "string") {
        for (const fn of this.handlers.message) fn(msg.data, msg.from);
      } else if (msg.type === "error" && typeof msg.code === "string") {
        for (const fn of this.handlers.error) fn(msg.code);
      } else if (msg.type === "close") {
        for (const fn of this.handlers.close) fn();
      }
      // Unknown types are ignored so the protocol can grow.
    }
  }

  /**
   * Connect to the Vokko host. Resolves once the host has sent `init`; rejects after 5 s without one.
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<Session>}
   */
  function connect(options = {}) {
    return new Promise((resolve, reject) => {
      /** @type {MessagePort | null} */
      let port = null;
      const timer = setTimeout(() => {
        window.removeEventListener("message", onWindowMessage);
        port?.close();
        reject(new Error("Open this inside Vokko"));
      }, options.timeoutMs ?? TIMEOUT_MS);

      /** @param {MessageEvent} event */
      function onWindowMessage(event) {
        const d = event.data;
        if (event.source !== window.parent || !d || d.vokko !== "init" || d.v !== 1 || !event.ports[0]) return;
        window.removeEventListener("message", onWindowMessage); // one port per load; later window messages are ignored
        const p = (port = event.ports[0]);
        p.onmessage = (e) => {
          if (!e.data || e.data.type !== "init") return;
          clearTimeout(timer);
          resolve(new Session(p, e.data));
        };
      }

      window.addEventListener("message", onWindowMessage);
      if (window.parent !== window) window.parent.postMessage({ vokko: "hello", v: 1 }, "*");
    });
  }

  return { connect, version: 1 };
})();
// Also reachable when a bundler or test runner evaluates this file as a module.
globalThis.VokkoGames = VokkoGames;
