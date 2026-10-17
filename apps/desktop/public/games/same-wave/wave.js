// @ts-check
// Same Wave page: the dial between two words, the clue, moving the dial together, the reveal. Rules in wave-core.js.
(() => {
  const { el, h, select, players, boot } = PartyUI;
  const { PAIRS, C } = WaveCore;
  const SVG = "http://www.w3.org/2000/svg";
  const CX = 150, CY = 150, R = 135;
  let key = "";
  let dragging = false;
  let localDial = 50;
  let lastSent = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let sendTimer;

  /** @param {number} v 0-100, left to right over the top @param {number} [r] */
  const at = (v, r = R) => {
    const a = Math.PI * (1 - Math.min(100, Math.max(0, v)) / 100);
    return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
  };
  /** @param {string} tag @param {Record<string, string | number>} attrs */
  const svg = (tag, attrs) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };
  /** A wedge of the dial between two values. @param {number} a @param {number} b @param {string} cls */
  const wedge = (a, b, cls) => {
    const [x1, y1] = at(a);
    const [x2, y2] = at(b);
    return svg("path", { d: `M${CX},${CY} L${x1},${y1} A${R},${R} 0 0 1 ${x2},${y2} Z`, class: cls });
  };

  /** The target bands: 2 / 3 / 4 / 3 / 2 points. @param {number} t */
  function bands(t) {
    const [b4, b3, b2] = C.BANDS;
    const g = svg("g", { class: "bands" });
    g.append(wedge(t - b2 - 0.5, t + b2 + 0.5, "b2"), wedge(t - b3 - 0.5, t + b3 + 0.5, "b3"), wedge(t - b4 - 0.5, t + b4 + 0.5, "b4"));
    for (const [v, label] of [[t, "4"], [t - (b4 + b3) / 2 - 0.5, "3"], [t + (b4 + b3) / 2 + 0.5, "3"], [t - (b3 + b2) / 2 - 0.5, "2"], [t + (b3 + b2) / 2 + 0.5, "2"]]) {
      const [x, y] = at(/** @type {number} */ (v), R - 14);
      const text = svg("text", { x, y, class: "band-label" });
      text.textContent = String(label);
      g.append(text);
    }
    return g;
  }

  /** @param {PartyApp} app */
  function dial(app) {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const target = st.phase === "reveal" ? st.target : app.host.view.mine?.target;
    const canMove = st.phase === "guess" && st.giver !== app.me;
    const box = svg("svg", { viewBox: "0 0 300 160", class: `dial${canMove ? " movable" : ""}`, role: "slider", "aria-label": "Dial", "aria-valuemin": 0, "aria-valuemax": 100, tabindex: canMove ? 0 : -1 });
    box.append(wedge(0, 100, "face"));
    if (typeof target === "number" && target >= 0) box.append(bands(target));
    const needle = svg("line", { x1: CX, y1: CY, x2: CX, y2: CY - R, class: "needle", id: "needle" });
    box.append(needle, svg("circle", { cx: CX, cy: CY, r: 8, class: "hub" }));
    if (canMove) {
      /** @param {PointerEvent} e */
      const move = (e) => {
        const r = box.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 300 - CX;
        const y = CY - ((e.clientY - r.top) / r.height) * 160;
        const a = Math.atan2(Math.max(0, y), x);
        setLocal(app, Math.round(100 - (a / Math.PI) * 100));
      };
      box.addEventListener("pointerdown", (e) => {
        dragging = true;
        box.setPointerCapture(e.pointerId);
        move(e);
      });
      box.addEventListener("pointermove", (e) => dragging && move(e));
      const stop = () => {
        dragging = false;
        sendDial(app);
      };
      box.addEventListener("pointerup", stop);
      box.addEventListener("pointercancel", stop);
      box.addEventListener("keydown", (e) => {
        const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
        if (!step) return;
        e.preventDefault();
        setLocal(app, localDial + step * (e.shiftKey ? 5 : 1));
        sendDial(app);
      });
    }
    return box;
  }

  /** @param {PartyApp} app @param {number} v */
  function setLocal(app, v) {
    localDial = Math.max(0, Math.min(100, v));
    showNeedle(localDial);
    // At most one dial intent every 100 ms while dragging; the host coalesces its broadcasts too.
    if (!sendTimer) sendTimer = setTimeout(() => sendDial(app), Math.max(0, lastSent + 100 - Date.now()));
  }

  /** @param {PartyApp} app */
  function sendDial(app) {
    clearTimeout(sendTimer);
    sendTimer = undefined;
    lastSent = Date.now();
    app.act({ k: "dial", v: localDial });
  }

  /** @param {number} v */
  function showNeedle(v) {
    const needle = document.getElementById("needle");
    if (!needle) return;
    const [x, y] = at(v, R - 6);
    needle.setAttribute("x2", String(x));
    needle.setAttribute("y2", String(y));
    document.querySelector(".dial")?.setAttribute("aria-valuenow", String(v));
  }

  /** @param {PartyApp} app */
  function lobby(app) {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const host = app.isHost();
    el("status").textContent = host ? "Pick the length and start" : `${app.nameOf(app.host.ctx.leader)} starts the game`;
    const rounds = /** @type {[number, string][]} */ (C.ROUNDS.map((n) => [n, `${n} rounds`]));
    const n = app.host.ctx.players.length;
    return h("div", { className: "card" }, h("h2", { textContent: "How to play" }),
      h("p", { textContent: "Play as one team. Each round one of you secretly sees a spot on a dial between two opposite words and gives a short clue for it. The rest of you move the dial together to where you think the clue points, then lock it in. The closer, the more points (up to 4)." }),
      host
        ? h("div", { className: "row" }, select(rounds, st.rounds, (r) => app.act({ k: "cfg", rounds: r }), "Rounds"),
            h("button", { className: "primary", textContent: "Start", disabled: n < 2, onclick: () => app.act({ k: "start" }) }),
            n < 2 ? h("span", { className: "muted", textContent: "Waiting for another player" }) : "")
        : h("p", { className: "big", textContent: `${st.rounds} rounds` }),
      st.r ? h("p", { className: "muted", textContent: `Last game: ${st.total} points` }) : "");
  }

  /** @param {PartyApp} app */
  function round(app) {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const pair = PAIRS[st.card] ?? ["?", "?"];
    const giver = st.giver === app.me;
    const ends = h("div", { className: "ends" }, h("span", { className: "end left", textContent: `← ${pair[0]}` }), h("span", { className: "end right", textContent: `${pair[1]} →` }));
    /** @type {(Node | string)[]} */
    const below = [];
    if (st.phase === "clue" && giver) {
      const input = h("input", { type: "text", maxLength: C.MAX_CLUE, placeholder: "Your clue", "aria-label": "Your clue", autocomplete: "off" });
      const give = () => input.value.trim() && app.act({ k: "clue", text: input.value });
      input.addEventListener("keydown", (e) => e.key === "Enter" && give()); // no <form>: the sandbox has no allow-forms
      below.push(h("p", { textContent: "Give a clue that points to the target on this scale." }), h("div", { className: "row clue-row" }, input, h("button", { className: "primary", textContent: "Give clue", onclick: give })));
      setTimeout(() => input.focus(), 0);
    } else if (st.phase === "clue") {
      below.push(h("p", { className: "muted", textContent: `${app.nameOf(st.giver)} is thinking of a clue...` }));
    } else {
      below.push(h("p", { className: "clue big", textContent: `"${st.clue}"` }));
      if (st.phase === "guess" && !giver) below.push(h("div", { className: "row" }, h("span", { className: "muted", textContent: "Drag the dial together, then" }), h("button", { className: "primary", textContent: "Lock in", onclick: () => app.act({ k: "lock" }) })));
      if (st.phase === "guess" && giver) below.push(h("p", { className: "muted", textContent: "Your team is moving the dial. No hints!" }));
      if (st.phase === "reveal") {
        below.push(h("p", { className: "big", textContent: st.pts ? `+${st.pts} points` : "Missed it, no points" }));
        if (app.isHost()) below.push(h("button", { className: "primary", textContent: st.r >= st.rounds ? "See the score" : "Next round", onclick: () => app.act({ k: "next" }) }));
      }
    }
    return h("div", { className: "card round" }, h("p", { className: "muted", textContent: `Round ${st.r} of ${st.rounds} · clue by ${app.nameOf(st.giver)}` }), ends, dial(app), ...below);
  }

  /** @param {PartyApp} app */
  function end(app) {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const max = st.rounds * 4;
    const ratio = max ? st.total / max : 0;
    return h("div", { className: "card" }, h("h2", { textContent: "Game over" }), h("p", { className: "big", textContent: `Your team scored ${st.total} of ${max}` }),
      h("p", { textContent: ratio >= 0.75 ? "Totally on the same wave." : ratio >= 0.5 ? "Pretty well in tune." : ratio >= 0.25 ? "Some static on the line." : "Different frequencies today." }),
      app.isHost() ? h("button", { className: "primary", textContent: "Play again", onclick: () => app.act({ k: "again" }) }) : h("p", { className: "muted", textContent: "Waiting for the host" }));
  }

  boot(() => WaveCore.game(), (app) => {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const mine = app.host.view.mine;
    const k = JSON.stringify([st.phase, st.r, st.giver, st.card, st.clue, st.rounds, mine, app.isHost(), app.host.ctx.players.length, st.phase === "lobby" && st.total]);
    if (k !== key) {
      key = k;
      dragging = false;
      if (st.phase === "lobby") el("stage").replaceChildren(lobby(app));
      else if (st.phase === "end") el("stage").replaceChildren(end(app));
      else {
        el("stage").replaceChildren(round(app));
        localDial = st.dial;
      }
    }
    if (!dragging && st.phase !== "lobby" && st.phase !== "end") {
      localDial = st.dial;
      showNeedle(st.dial);
    }
    const giver = st.giver === app.me;
    if (st.phase === "clue") el("status").textContent = giver ? "You give the clue" : "Waiting for the clue";
    else if (st.phase === "guess") el("status").textContent = giver ? "Your team is guessing" : "Move the dial";
    else if (st.phase === "reveal") el("status").textContent = st.lockedBy ? `${app.nameOf(st.lockedBy)} locked it in` : "Time's up";
    else if (st.phase === "end") el("status").textContent = "Game over";
    el("team-score").textContent = st.phase === "lobby" ? "Team" : `Team score: ${st.total}`;
    players(app, {}, (id) => (id === st.giver && st.phase !== "lobby" && st.phase !== "end" ? "clue" : ""));
  });
})();
