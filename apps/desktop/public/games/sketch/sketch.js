// @ts-check
/*
 * Sketch UI: canvas, tools, guesses and scores. The game rules and the late-join sync live in sketch-core.js.
 * Relay data reaches the page only via textContent or the canvas.
 */
(async () => {
  const { C, toBoard } = SketchCore;
  const COLORS = ["#202124", "#e8453c", "#3b7ded", "#2fa84f", "#f29d38", "#ffffff"];
  const WIDTHS = [3, 8, 20];

  /** @param {string} id */
  const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const canvas = /** @type {HTMLCanvasElement} */ (el("canvas"));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const guessInput = /** @type {HTMLInputElement} */ (el("guess"));

  let color = 0;
  let width = 1;
  let strokeId = 0;
  let drawing = false;
  /** @type {number[]} */
  let pending = [];
  /** @type {{ id: number, x: number, y: number } | null} */
  let last = null;

  function clearBoard() {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, C.W, C.H);
    last = null;
  }

  /** @param {number} id @param {number} c @param {number} w @param {number[]} p */
  function drawPoints(id, c, w, p) {
    ctx.strokeStyle = COLORS[c];
    ctx.lineWidth = WIDTHS[w];
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (last && last.id === id) ctx.moveTo(last.x, last.y);
    else ctx.moveTo(p[0], p[1]);
    for (let i = 0; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.stroke();
    last = { id, x: p[p.length - 2], y: p[p.length - 1] };
  }

  /** @param {string} text @param {boolean} hit */
  function addLine(text, hit) {
    const li = document.createElement("li");
    li.textContent = text;
    if (hit) li.className = "hit";
    const list = el("guesses");
    list.append(li);
    while (list.children.length > 100) list.firstElementChild?.remove();
    list.scrollTop = list.scrollHeight;
  }

  clearBoard();
  /** @type {VokkoSession} */
  let vokko;
  try {
    vokko = await VokkoGames.connect();
  } catch (err) {
    el("status").textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  const me = vokko.me.app_id;
  /** @param {string} id */
  const nameOf = (id) => vokko.players.find((p) => p.app_id === id)?.name ?? "Someone";
  const ids = () => vokko.players.map((p) => p.app_id);

  const game = SketchCore.create({
    me,
    players: ids(),
    leader: vokko.leader,
    send: (data, to) => vokko.send(data, to),
    nameOf,
    onChange: render,
    onLine: addLine,
    onDraw: (s) => drawPoints(s.id, s.c, s.w, s.p),
    onClear: () => {
      clearBoard();
      pending = [];
    },
  });
  const st = game.state;

  function render() {
    const mine = st.drawer === me;
    el("joining").hidden = !st.syncing;
    if (st.syncing) el("status").textContent = "Joining round...";
    else if (!st.drawer) el("status").textContent = vokko.players.length < 2 ? "Waiting for another player" : "Starting...";
    else if (st.over) el("status").textContent = "Next round soon";
    else el("status").textContent = mine ? "Your turn: draw" : `${nameOf(st.drawer)} is drawing`;
    el("word").textContent = !st.drawer || st.over ? "" : mine ? st.word : "_ ".repeat(st.len).trim();
    el("tools").hidden = !mine || st.over;
    guessInput.disabled = st.syncing || mine || st.over || !st.drawer;
    const list = el("scores");
    list.replaceChildren();
    for (const id of ids().sort((a, b) => (st.scores[b] ?? 0) - (st.scores[a] ?? 0))) {
      const li = document.createElement("li");
      li.textContent = `${nameOf(id)}${id === me ? " (you)" : ""}: ${st.scores[id] ?? 0}`;
      list.append(li);
    }
  }

  function flush() {
    if (!pending.length) return;
    game.stroke(strokeId, color, width, pending);
    pending = [];
  }

  /** @param {PointerEvent} e */
  function point(e) {
    const p = toBoard(canvas.getBoundingClientRect(), e.clientX, e.clientY);
    pending.push(...p);
    drawPoints(strokeId, color, width, p);
    if (pending.length >= C.MAX_POINTS * 2) flush();
  }

  /** @param {HTMLElement} box @param {number} count @param {number} current @param {(i: number) => void} pick @param {(b: HTMLButtonElement, i: number) => void} look */
  function toolGroup(box, count, current, pick, look) {
    const buttons = Array.from({ length: count }, (_, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-pressed", String(i === current));
      look(b, i);
      b.addEventListener("click", () => {
        pick(i);
        buttons.forEach((x, j) => x.setAttribute("aria-pressed", String(i === j)));
      });
      box.append(b);
      return b;
    });
  }
  toolGroup(el("colors"), COLORS.length, color, (i) => (color = i), (b, i) => {
    b.className = "swatch";
    b.style.background = COLORS[i];
    b.setAttribute("aria-label", i === COLORS.length - 1 ? "Eraser" : `Color ${i + 1}`);
  });
  toolGroup(el("widths"), WIDTHS.length, width, (i) => (width = i), (b, i) => (b.textContent = ["Thin", "Medium", "Thick"][i]));
  el("clear").addEventListener("click", () => {
    flush();
    game.clear();
  });

  canvas.addEventListener("pointerdown", (e) => {
    if (st.drawer !== me || st.over) return;
    flush();
    strokeId += 1;
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    point(e);
  });
  canvas.addEventListener("pointermove", (e) => drawing && point(e));
  const stop = () => {
    drawing = false;
    flush();
  };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);

  // No <form>: the sandbox has no allow-forms, so submit events never fire.
  function submitGuess() {
    const text = guessInput.value.trim();
    guessInput.value = "";
    if (text) game.guess(text);
  }
  guessInput.addEventListener("keydown", (e) => e.key === "Enter" && submitGuess());
  el("send").addEventListener("click", submitGuess);

  vokko.on("message", (data, from) => game.receive(data, from));
  vokko.on("players", (players, leader) => game.setPlayers(players.map((p) => p.app_id), leader));
  vokko.on("error", (code) => (el("status").textContent = code === "rate_limited" ? "Slow down a little" : `Error: ${code}`));
  const ticker = setInterval(() => {
    el("timer").textContent = st.drawer && !st.over && !st.syncing ? `${Math.max(0, Math.ceil((st.deadline - Date.now()) / 1000))}s` : "";
  }, 500);
  const flusher = setInterval(flush, 100); // strokes go out about 10 times a second
  vokko.on("close", () => {
    clearInterval(ticker);
    clearInterval(flusher);
    game.stop();
  });
  game.start();
  vokko.ready();
})();
