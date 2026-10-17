// @ts-check
// Trivia page: lobby settings, the question with its answers, the reveal and the end screen. Rules in trivia-core.js.
(() => {
  const { el, h, select, players, boot } = PartyUI;
  const bank = /** @type {TriviaBank} */ (TRIVIA_DATA);
  const LETTERS = ["A", "B", "C", "D"];
  const CREDIT = "Questions from the Open Trivia Database (opentdb.com), CC BY-SA 4.0";
  let key = "";

  /** @param {PartyApp} app */
  function lobby(app) {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const host = app.isHost();
    el("status").textContent = host ? "Pick the questions and start" : `${app.nameOf(app.host.ctx.leader)} is setting up the game`;
    const cats = /** @type {[number, string][]} */ ([[-1, "Any category"], ...bank.cats.map((c, i) => /** @type {[number, string]} */ ([i, c]))]);
    const diffs = /** @type {[number, string][]} */ ([[-1, "Any difficulty"], ...TriviaCore.DIFFS.map((d, i) => /** @type {[number, string]} */ ([i, d]))]);
    const lens = /** @type {[number, string][]} */ (TriviaCore.C.LENGTHS.map((n) => [n, `${n} questions`]));
    const cfg = (/** @type {object} */ change) => app.act({ k: "cfg", cat: st.cat, diff: st.diff, len: st.len, ...change });
    const label = (/** @type {[number, string][]} */ list, /** @type {number} */ v) => list.find((x) => x[0] === v)?.[1] ?? "";
    const body = host
      ? h("div", { className: "row" },
          select(cats, st.cat, (cat) => cfg({ cat }), "Category"),
          select(diffs, st.diff, (diff) => cfg({ diff }), "Difficulty"),
          select(lens, st.len, (len) => cfg({ len }), "Length"),
          h("button", { className: "primary", textContent: "Start", onclick: () => app.act({ k: "start" }) }))
      : h("p", { className: "big", textContent: `${label(cats, st.cat)} · ${label(diffs, st.diff)} · ${st.len} questions` });
    return h("div", { className: "card" }, h("h2", { textContent: "Game settings" }), body,
      h("p", { className: "muted", textContent: `Answer fast: a right answer scores ${TriviaCore.C.BASE} plus up to ${TriviaCore.C.SPEED} for speed.` }));
  }

  /** @param {PartyApp} app */
  function question(app) {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const q = bank.q[st.qs[st.i]];
    const answers = h("div", { className: "answers" });
    /** @type {number[]} */ (st.ord).forEach((idx, pos) => {
      const b = h("button", { type: "button", className: "answer", "data-pos": pos }, h("span", { className: "letter", textContent: LETTERS[pos] }), h("span", { textContent: String(q[3 + idx]) }));
      b.onclick = () => {
        if (app.host.view.st?.phase !== "q") return;
        mine = pos;
        app.act({ k: "ans", i: st.i, c: pos });
        update(app);
      };
      answers.append(b);
    });
    return h("div", { className: "card question" },
      h("div", { className: "row muted" }, h("span", { textContent: `Question ${st.i + 1} of ${st.qs.length}` }),
        h("span", { className: "chip", textContent: bank.cats[q[0]] ?? "" }), h("span", { className: "chip", textContent: TriviaCore.DIFFS[q[1]] ?? "" })),
      h("p", { className: "big", textContent: q[2] }), answers, h("p", { id: "result", className: "muted" }));
  }

  /** @param {PartyApp} app */
  function end(app) {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const ranked = app.host.ctx.players.slice().sort((a, b) => (st.scores[b] ?? 0) - (st.scores[a] ?? 0));
    const top = ranked[0];
    return h("div", { className: "card" }, h("h2", { textContent: "Final scores" }),
      h("p", { className: "big", textContent: top && st.scores[top] ? `${app.nameOf(top)} wins with ${st.scores[top]} points` : "Nobody scored this time" }),
      h("ol", { className: "ranking" }, ...ranked.map((id) => h("li", { textContent: `${app.nameOf(id)}: ${st.scores[id] ?? 0}` }))),
      app.isHost() ? h("button", { className: "primary", textContent: "Play again", onclick: () => app.act({ k: "again" }) }) : h("p", { className: "muted", textContent: "Waiting for the host to start another game" }),
      h("p", { className: "credit", textContent: CREDIT }));
  }

  /** This copy's pick for the current question (shown before the reveal); reset when the question changes. */
  let mine = -1;

  /** In-place updates that keep the layout (answer marks, status). @param {PartyApp} app */
  function update(app) {
    const st = /** @type {PartyState} */ (app.host.view.st);
    if (st.phase !== "q" && st.phase !== "reveal") return;
    const reveal = st.phase === "reveal";
    const answered = /** @type {string[]} */ (st.answered).includes(app.me) || mine >= 0;
    const pick = reveal ? (st.picks[app.me] ?? -1) : mine;
    document.querySelectorAll(".answer").forEach((node) => {
      const b = /** @type {HTMLButtonElement} */ (node);
      const pos = Number(b.dataset.pos);
      b.disabled = reveal || answered;
      b.classList.toggle("picked", pos === pick);
      b.classList.toggle("right", reveal && st.ord[pos] === 0);
      b.classList.toggle("wrong", reveal && pos === pick && st.ord[pos] !== 0);
    });
    const gain = st.gain[app.me] ?? 0;
    el("result").textContent = reveal ? (gain ? `Right! +${gain}` : pick >= 0 ? "Not this time" : "No answer") : answered ? "Locked in" : "";
    el("status").textContent = reveal ? "Answer revealed" : `${st.answered.length} of ${app.host.ctx.players.length} answered`;
  }

  boot(() => TriviaCore.game(bank), (app) => {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const k = `${st.phase === "reveal" ? "q" : st.phase}:${st.i}:${st.qs?.[st.i]}:${st.phase === "lobby" ? JSON.stringify([st.cat, st.diff, st.len, app.isHost()]) : ""}:${st.phase === "end" && app.isHost()}`;
    if (k !== key) {
      if (st.phase === "q" && !key.startsWith(`q:${st.i}:`)) mine = -1;
      key = k;
      const stage = el("stage");
      if (st.phase === "lobby") stage.replaceChildren(lobby(app));
      else if (st.phase === "end") {
        el("status").textContent = "Game over";
        stage.replaceChildren(end(app));
      } else stage.replaceChildren(question(app));
    }
    update(app);
    const reveal = st.phase === "reveal";
    players(app, st.scores, (id) => (reveal ? (st.gain[id] ? `+${st.gain[id]}` : "") : st.phase === "q" && st.answered.includes(id) ? "✓" : ""));
  });
})();
