// @ts-check
/*
 * Telephone UI: lobby, the drawing pad, the text answers and the reveal. Rules and transport live in telephone-core.js.
 * Relay data reaches the page only via textContent, the canvas, or <img> sources that passed TelephoneCore.checkImage.
 */
(async () => {
  const { C } = TelephoneCore;
  const COLORS = ["#202124", "#e8453c", "#f29d38", "#f7d038", "#2fa84f", "#3b7ded", "#9b59d0", "#8d5a3b"];
  const SIZES = [4, 10, 22];
  const W = 480;
  const H = 360;

  /** @param {string} id */
  const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const canvas = /** @type {HTMLCanvasElement} */ (el("canvas"));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const text = /** @type {HTMLInputElement} */ (el("text"));
  const turnsSelect = /** @type {HTMLSelectElement} */ (el("turns"));
  const incoming = /** @type {HTMLImageElement} */ (el("incoming"));

  // ---- drawing pad ----
  /** @type {{ color: string, size: number, p: number[] }[]} */
  let strokes = [];
  let color = 0;
  let size = 1;
  let erasing = false;
  /** @type {{ color: string, size: number, p: number[] } | null} */
  let current = null;

  /** @param {{ color: string, size: number, p: number[] }} s @param {number} from */
  function paint(s, from) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (s.p.length === 2) {
      ctx.beginPath();
      ctx.arc(s.p[0], s.p[1], s.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(s.p[Math.max(0, from - 2)], s.p[Math.max(1, from - 1)]);
    for (let i = from; i < s.p.length; i += 2) ctx.lineTo(s.p[i], s.p[i + 1]);
    ctx.stroke();
  }
  function redraw() {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, W, H);
    for (const s of strokes) paint(s, 2);
  }
  /** @param {PointerEvent} e */
  function at(e) {
    const r = canvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * W);
    const y = Math.round(((e.clientY - r.top) / r.height) * H);
    return [Math.max(0, Math.min(W, x)), Math.max(0, Math.min(H, y))];
  }
  const canDraw = () => game.state.phase === "play" && game.state.task?.kind === "draw" && !game.state.submitted;
  canvas.addEventListener("pointerdown", (e) => {
    if (!canDraw()) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    current = { color: erasing ? "#ffffff" : COLORS[color], size: SIZES[size] * (erasing ? 1.6 : 1), p: at(e) };
    strokes.push(current);
    paint(current, 2);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!current) return;
    const from = current.p.length;
    current.p.push(...at(e));
    paint(current, from);
  });
  const lift = () => (current = null);
  canvas.addEventListener("pointerup", lift);
  canvas.addEventListener("pointercancel", lift);

  /** The drawing as a WebP data URL under the size cap; PNG where the browser cannot encode WebP; smaller if needed. */
  function exportDrawing() {
    for (const scale of [1, 0.75, 0.5, 0.35]) {
      let source = canvas;
      if (scale < 1) {
        source = document.createElement("canvas");
        source.width = Math.round(W * scale);
        source.height = Math.round(H * scale);
        const c = /** @type {CanvasRenderingContext2D} */ (source.getContext("2d"));
        c.drawImage(canvas, 0, 0, source.width, source.height);
      }
      for (const q of [0.8, 0.6, 0.4]) {
        const url = source.toDataURL("image/webp", q);
        if (!url.startsWith("data:image/webp")) break; // no WebP encoder (Safari)
        if (TelephoneCore.checkImage(url)) return url;
      }
      const png = source.toDataURL("image/png");
      if (TelephoneCore.checkImage(png)) return png;
    }
    return null;
  }

  /** @param {HTMLElement} box @param {number} count @param {(b: HTMLButtonElement, i: number) => void} look @param {(i: number) => void} pick */
  function toolGroup(box, count, look, pick) {
    const buttons = Array.from({ length: count }, (_, i) => {
      const b = document.createElement("button");
      b.type = "button";
      look(b, i);
      b.addEventListener("click", () => {
        pick(i);
        buttons.forEach((x, j) => x.setAttribute("aria-pressed", String(i === j)));
      });
      box.append(b);
      return b;
    });
    return buttons;
  }
  const eraser = el("eraser");
  const colorButtons = toolGroup(el("colors"), COLORS.length, (b, i) => {
    b.className = "swatch";
    b.style.background = COLORS[i];
    b.setAttribute("aria-label", `Colour ${i + 1}`);
    b.setAttribute("aria-pressed", String(i === color));
  }, (i) => {
    color = i;
    erasing = false;
    eraser.setAttribute("aria-pressed", "false");
  });
  toolGroup(el("sizes"), SIZES.length, (b, i) => {
    b.className = "size";
    b.setAttribute("aria-label", ["Thin", "Medium", "Thick"][i]);
    b.setAttribute("aria-pressed", String(i === size));
    const dot = document.createElement("i");
    dot.style.width = dot.style.height = `${Math.min(22, SIZES[i])}px`;
    b.append(dot);
  }, (i) => (size = i));
  eraser.addEventListener("click", () => {
    erasing = !erasing;
    eraser.setAttribute("aria-pressed", String(erasing));
    colorButtons.forEach((b, j) => b.setAttribute("aria-pressed", String(!erasing && j === color)));
  });
  el("undo").addEventListener("click", () => {
    strokes.pop();
    redraw();
  });
  el("clear").addEventListener("click", () => {
    strokes = [];
    redraw();
  });
  redraw();

  // ---- connect ----
  /** @type {VokkoSession} */
  let vokko;
  try {
    vokko = await VokkoGames.connect();
  } catch (err) {
    el("status").textContent = err instanceof Error ? err.message : String(err);
    return;
  }
  const me = vokko.me.app_id;
  /** @type {Record<string, string>} names of everyone seen in the call, kept after they leave */
  const names = {};
  const learn = () => vokko.players.forEach((p) => (names[p.app_id] = p.name));
  learn();
  /** @param {string} id */
  const nameOf = (id) => names[id] ?? game?.nameOf(id) ?? "Someone";
  /** @param {string} id */
  const label = (id) => (names[id] ?? game.nameOf(id)) + (id === me ? " (you)" : "");

  const game = TelephoneCore.create({
    me,
    players: vokko.players.map((p) => p.app_id),
    leader: vokko.leader,
    send: (data, to) => vokko.send(data, to),
    nameOf: (id) => names[id] ?? "Someone",
    prompts: TELEPHONE_PROMPTS,
    onChange: render,
  });
  const st = game.state;
  let taskKey = "";

  function submitDrawing() {
    if (!strokes.length) return;
    const url = exportDrawing();
    if (!url) {
      el("wait").hidden = false;
      el("wait").textContent = "That drawing is too detailed to send. Undo a few strokes.";
      return;
    }
    game.submitImage(url);
  }
  function submitText() {
    if (!game.submitText(text.value)) text.focus();
  }
  el("send-drawing").addEventListener("click", submitDrawing);
  el("send-text").addEventListener("click", submitText);
  text.addEventListener("keydown", (e) => e.key === "Enter" && submitText());
  el("suggest").addEventListener("click", () => {
    text.value = game.suggest();
    text.focus();
  });
  el("start").addEventListener("click", () => game.startGame());
  turnsSelect.addEventListener("change", () => game.setTurns(Number(turnsSelect.value)));
  el("prev").addEventListener("click", () => game.show(st.k - 1));
  el("next").addEventListener("click", () => game.show(st.k + 1));
  el("again").addEventListener("click", () => game.newGame());

  /** @param {HTMLElement} list @param {string[]} ids @param {(li: HTMLLIElement, id: string) => void} [extra] */
  function nameList(list, ids, extra) {
    list.replaceChildren();
    for (const id of ids) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = label(id);
      li.append(span);
      extra?.(li, id);
      list.append(li);
    }
  }

  function render() {
    learn();
    const lead = game.isLeader();
    const leaderName = nameOf(vokko.leader);
    for (const id of ["lobby", "play", "reveal"]) el(id).hidden = !st.synced || st.phase !== id;
    if (!st.synced) el("status").textContent = `Waiting for ${leaderName} to open Telephone...`;

    if (st.phase === "lobby") {
      const n = st.roster.length;
      el("status").textContent = n < C.MIN_PLAYERS ? `Waiting for players (${n} of at least ${C.MIN_PLAYERS})` : `${n} players ready`;
      el("note").hidden = !st.note;
      el("note").textContent = st.note;
      nameList(el("roster"), st.roster);
      el("host").hidden = !lead;
      if (lead) {
        const options = TelephoneCore.turnOptions(n);
        turnsSelect.replaceChildren(...options.map((t) => new Option(String(t), String(t), false, t === st.turns)));
        /** @type {HTMLButtonElement} */ (el("start")).disabled = n < C.MIN_PLAYERS;
      }
      el("lobby-hint").textContent = lead
        ? n > C.MAX_PLAYERS ? `Only the first ${C.MAX_PLAYERS} will play.` : `Everyone in the call who opens Telephone joins here.`
        : `${leaderName} starts the game.`;
    } else if (st.phase === "play") renderPlay(lead);
    else if (st.phase === "reveal") renderReveal(lead);
  }

  /** @param {boolean} lead */
  function renderPlay(lead) {
    const t = st.task;
    el("status").textContent = `Turn ${st.turn + 1} of ${st.turns}`;
    const key = t ? `${st.g}.${t.chain}.${t.turn}` : "";
    if (key !== taskKey) {
      taskKey = key;
      strokes = [];
      redraw();
      text.value = "";
      el("wait").textContent = "";
    }
    const active = !!t && !st.submitted;
    el("instruction").textContent = !t
      ? st.roster.includes(me) ? "Waiting for your turn..." : "A game is running. You can join the next one."
      : t.kind === "write" ? "Write something for the next player to draw."
      : t.kind === "draw" ? "Draw this:"
      : "What is this drawing?";
    el("prompt").textContent = t?.kind === "draw" ? t.text : "";
    el("prompt").hidden = t?.kind !== "draw";
    el("pad").hidden = !active || t.kind !== "draw";
    el("text-row").hidden = !active || t.kind === "draw";
    el("suggest").hidden = t?.kind !== "write";
    text.placeholder = t?.kind === "write" ? "a cat riding a bicycle" : "Your guess";
    const url = t?.img ? st.imgs.get(t.img) : undefined;
    el("incoming-wrap").hidden = !active || t.kind !== "describe";
    if (url && incoming.src !== url) incoming.src = url;
    incoming.hidden = !url;
    el("incoming-wait").hidden = !!url;
    el("wait").hidden = active && !el("wait").textContent;
    if (st.submitted) el("wait").textContent = "Sent. Waiting for the others...";
    nameList(el("waiting"), st.roster, (li, id) => {
      const waiting = st.waiting.includes(id);
      li.className = waiting ? "pending" : "done";
      li.title = waiting ? "Still working" : "Done";
      if (lead && waiting && id !== me) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = "Skip";
        b.setAttribute("aria-label", `Skip ${nameOf(id)}`);
        b.addEventListener("click", () => game.skip(id));
        li.append(b);
      }
    });
  }

  /** @param {boolean} lead */
  function renderReveal(lead) {
    const chain = st.chains[st.k];
    el("status").textContent = `Chain ${st.k + 1} of ${st.chains.length}`;
    el("chain-title").textContent = chain ? `${label(chain.owner)}'s chain` : "Loading...";
    const list = el("links");
    list.replaceChildren();
    for (const [i, l] of (chain?.links ?? []).entries()) {
      const li = document.createElement("li");
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = l.kind === "skip" ? `${label(l.by)} skipped`
        : l.kind === "d" ? `${label(l.by)} drew:`
        : i === 0 ? (l.auto ? `${label(l.by)} got a random prompt:` : `${label(l.by)} wrote:`)
        : `${label(l.by)} thought it was:`;
      li.append(who);
      if (l.kind === "w") {
        const q = document.createElement("q");
        q.textContent = l.text ?? "";
        li.append(q);
      } else if (l.kind === "d") {
        const url = l.img && st.imgs.get(l.img);
        if (url) {
          const img = document.createElement("img");
          img.src = url;
          img.alt = `Drawing by ${nameOf(l.by)}`;
          li.append(img);
        } else {
          const wait = document.createElement("span");
          wait.className = "muted";
          wait.textContent = "Loading the drawing...";
          li.append(wait);
        }
      }
      list.append(li);
    }
    el("reveal-host").hidden = !lead;
    /** @type {HTMLButtonElement} */ (el("prev")).disabled = st.k === 0;
    /** @type {HTMLButtonElement} */ (el("next")).disabled = st.k >= st.chains.length - 1;
    el("reveal-hint").textContent = lead ? "" : `${nameOf(vokko.leader)} is showing the chains.`;
  }

  vokko.on("message", (data, from) => game.receive(data, from));
  vokko.on("players", (players, leader) => {
    learn();
    game.setPlayers(players.map((p) => p.app_id), leader);
  });
  vokko.on("error", (code) => (el("status").textContent = code === "rate_limited" ? "The call is busy, retrying..." : `Error: ${code}`));
  // The timer, and sending whatever is there when it runs out.
  const ticker = setInterval(() => {
    const left = Math.ceil((st.deadline - Date.now()) / 1000);
    el("timer").textContent = st.phase === "play" && st.task && !st.submitted ? `${Math.max(0, left)}s` : "";
    if (st.phase !== "play" || !st.task || st.submitted || left > 0) return;
    if (st.task.kind === "draw") {
      if (strokes.length) submitDrawing();
      if (!st.submitted) game.giveUp();
    } else if (!game.submitText(text.value)) game.giveUp();
  }, 250);
  vokko.on("close", () => {
    clearInterval(ticker);
    game.stop();
  });
  game.start();
  vokko.ready();
})();
