// @ts-check
/*
 * Shared page code for the party games: connect, wire PartyHost to the SDK, the status line, timer and player list.
 * Relay data reaches the page only through textContent (h() never sets innerHTML).
 */

/**
 * @typedef {{
 *   host: ReturnType<typeof PartyHost.create>,
 *   me: string,
 *   vokko: VokkoSession,
 *   nameOf: (id: string) => string,
 *   isHost: () => boolean,
 *   act: (m: { k: string, [key: string]: any }) => void,
 * }} PartyApp
 */

var PartyUI = (() => {
  /** @param {string} id */
  const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

  /**
   * A DOM element. `props` are set as properties (className, textContent, type, disabled, onclick, ...).
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag @param {Partial<HTMLElementTagNameMap[K]> & Record<string, any>} [props] @param {(Node | string)[]} children
   * @returns {HTMLElementTagNameMap[K]}
   */
  function h(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith("data-") || k.startsWith("aria-")) e.setAttribute(k, String(v));
      else /** @type {any} */ (e)[k] = v;
    }
    e.append(...children);
    return e;
  }

  /** A <select> of [value, label] pairs. @param {[number, string][]} options @param {number} value @param {(v: number) => void} onPick @param {string} label */
  function select(options, value, onPick, label) {
    const s = h("select", { "aria-label": label, onchange: () => onPick(Number(s.value)) });
    for (const [v, text] of options) s.append(h("option", { value: String(v), textContent: text, selected: v === value }));
    return s;
  }

  /**
   * The player list: name, "(you)", "host", a score and an optional mark per player.
   * @param {PartyApp} app @param {Record<string, number>} scores @param {(id: string) => string} [mark]
   */
  function players(app, scores, mark) {
    const list = el("players");
    list.replaceChildren();
    const ids = app.host.ctx.players.slice().sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
    for (const id of ids) {
      const tags = [id === app.me ? "you" : "", id === app.host.ctx.leader ? "host" : ""].filter(Boolean).join(", ");
      list.append(h("li", {}, h("span", { className: "name", textContent: app.nameOf(id) + (tags ? ` (${tags})` : "") }),
        h("span", { className: "mark", textContent: mark?.(id) ?? "" }), h("span", { className: "score", textContent: String(scores[id] ?? 0) })));
    }
  }

  /**
   * Connect and run a game page. `render` is called on every state change; it should build the main area only when its
   * own layout key changes, so inputs keep focus.
   * @param {() => PartyGame} makeGame @param {(app: PartyApp) => void} render
   */
  async function boot(makeGame, render) {
    /** @type {VokkoSession} */
    let vokko;
    try {
      vokko = await VokkoGames.connect();
    } catch (err) {
      el("status").textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    const me = vokko.me.app_id;
    const ids = () => vokko.players.map((p) => p.app_id);
    /** @param {string} id */
    const nameOf = (id) => vokko.players.find((p) => p.app_id === id)?.name ?? "Someone";
    const host = PartyHost.create({ me, players: ids(), leader: vokko.leader, game: makeGame(), send: (d, to) => vokko.send(d, to), onChange: draw });
    /** @type {PartyApp} */
    const app = { host, me, vokko, nameOf, isHost: () => host.ctx.leader === me, act: (m) => host.act(m) };

    function draw() {
      const { st, syncing } = host.view;
      document.body.dataset.phase = st?.phase ?? (syncing ? "joining" : "waiting");
      if (!st) {
        el("status").textContent = syncing ? "Joining..." : `Waiting for ${nameOf(host.ctx.leader)} to open the game`;
        return;
      }
      el("note").textContent = st.note ?? "";
      try {
        render(app);
      } catch (err) {
        console.error(err); // a malformed state from the host: keep the last good screen
      }
    }

    vokko.on("message", (data, from) => host.receive(data, from));
    vokko.on("players", (list, leader) => host.setPlayers(list.map((p) => p.app_id), leader));
    vokko.on("error", (code) => (el("note").textContent = code === "rate_limited" ? "Slow down a little" : `Error: ${code}`));
    const ticker = setInterval(() => {
      const st = host.view.st;
      el("timer").textContent = st?.deadline ? `${PartyHost.secsLeft(st)}s` : "";
    }, 250);
    vokko.on("close", () => {
      clearInterval(ticker);
      host.stop();
    });
    host.start();
    vokko.ready();
  }

  return { el, h, select, players, boot };
})();
globalThis.PartyUI = PartyUI;
