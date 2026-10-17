// @ts-check
/*
 * Crazy Eights UI. The rules live in eights-core.js; the table (leader, late join, private hands) in ../table-host.js.
 * Relay data reaches the page only via textContent.
 */
(async () => {
  const { face, playable, SKIP, REV, DRAW2, WILD, WILD4 } = EightsCore;
  const SUITS = [
    { name: "Sun", mark: "●" },
    { name: "Leaf", mark: "▲" },
    { name: "Sea", mark: "■" },
    { name: "Dusk", mark: "◆" },
  ];

  /** @param {string} id */
  const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  /** @param {string} tag @param {string} [cls] @param {string} [text] */
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /** @param {number} v */
  const valueMark = (v) => (v <= 9 ? String(v) : v === SKIP ? "⦸" : v === REV ? "⇄" : v === DRAW2 ? "+2" : v === WILD ? "★" : "+4");
  /** @param {number} v */
  const valueName = (v) => (v <= 9 ? String(v) : v === SKIP ? "skip" : v === REV ? "reverse" : v === DRAW2 ? "draw two" : "");
  /** @param {number} card */
  function cardName(card) {
    const f = face(card);
    return f.v === WILD ? "Wild" : f.v === WILD4 ? "Wild draw four" : `${SUITS[f.s].name} ${valueName(f.v)}`;
  }

  /** A card face: corner marks and a big centre, all our own design. @param {number} card @param {string} tag */
  function cardEl(card, tag = "div") {
    const f = face(card);
    const c = h(tag, `card s${f.s}`);
    if (c instanceof HTMLButtonElement) c.type = "button";
    c.setAttribute("aria-label", cardName(card));
    const mark = valueMark(f.v);
    const corner = f.s === 4 ? mark : `${mark}${SUITS[f.s].mark}`;
    c.append(h("span", "corner tl", corner), h("span", "face", mark), h("span", "corner br", corner));
    return c;
  }

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
  let picking = -1; // a wild waiting for its suit

  const table = TableHost.create({ me, players: ids(), leader: vokko.leader, rules: EightsCore.rules, send: (d, to) => vokko.send(d, to), onView: render });
  const view = table.view;

  /** @param {any} e */
  function logLine(e) {
    const who = nameOf(e.by);
    if (e.k === "play") return `${who} played ${cardName(e.card)}${typeof e.suit === "number" ? `, called ${SUITS[e.suit]?.name}` : ""}`;
    if (e.k === "draw") return `${who} drew ${e.n === 1 ? "a card" : `${e.n} cards`}`;
    if (e.k === "last") return `${who}: "Last card!"`;
    if (e.k === "catch") return `${who} caught ${nameOf(e.who)}: +2 cards`;
    if (e.k === "left") return `${who} left the table`;
    return "";
  }

  function render() {
    const p = view.pub;
    const mine = /** @type {{ hand: number[], drawn: number } | null} */ (view.priv);
    el("note").textContent = view.note;
    el("lobby").hidden = !p || p.phase !== "lobby";
    el("table").hidden = !p || p.phase === "lobby";
    if (!p) {
      el("status").textContent = view.waiting ? `Waiting for ${nameOf(vokko.leader)} to open the game` : "";
      return;
    }
    /** @type {string[]} */
    const seats = p.seats;
    const seated = seats.includes(me);
    if (p.phase === "lobby") {
      el("status").textContent = seated ? (seats.length < 2 ? "Waiting for another player" : "Ready to deal") : "Take a seat";
      el("seat-count").textContent = `${seats.length}/10`;
      const list = el("seats");
      list.replaceChildren(...seats.map((id) => h("li", "", `${nameOf(id)}${id === me ? " (you)" : ""}${p.wins[id] ? ` · ${p.wins[id]} won` : ""}`)));
      if (!seats.length) list.append(h("li", "muted", "Nobody yet"));
      el("join").textContent = seated ? "Leave" : "Join";
      /** @type {HTMLButtonElement} */ (el("join")).disabled = !seated && seats.length >= 10;
      /** @type {HTMLButtonElement} */ (el("start")).disabled = !seated || seats.length < 2;
      picking = -1;
      return;
    }

    const myTurn = p.phase === "play" && p.turn === me;
    el("status").textContent =
      p.phase === "over" ? (p.winner ? `${p.winner === me ? "You win" : `${nameOf(p.winner)} wins`} the round!` : "Round over")
      : myTurn ? (p.drew ? "Play the card you drew, or keep it" : "Your turn")
      : `${nameOf(p.turn)}'s turn`;

    const others = el("others");
    const start = Math.max(0, seats.indexOf(me));
    const order = seats.slice(start).concat(seats.slice(0, start)).filter((id) => id !== me);
    others.replaceChildren(...order.map((id) => {
      const li = h("li", `seat${id === p.turn ? " turn" : ""}${id === p.winner ? " winner" : ""}`);
      const n = p.counts[seats.indexOf(id)];
      li.append(h("span", "name", nameOf(id)));
      const backs = h("span", "backs");
      for (let i = 0; i < Math.min(n, 8); i++) backs.append(h("span", "mini"));
      li.append(backs, h("span", "count", `${n}`));
      if (p.called.includes(id)) li.append(h("span", "badge", "Last card"));
      if (p.exposed === id && seated && p.phase === "play") {
        const b = h("button", "catch", "Catch!");
        b.setAttribute("aria-label", `Catch ${nameOf(id)}`);
        b.addEventListener("click", () => table.act({ k: "catch", who: id }));
        li.append(b);
      }
      return li;
    }));

    el("pile-count").textContent = String(p.pile);
    /** @type {HTMLButtonElement} */ (el("pile")).disabled = !myTurn || p.drew;
    el("top").replaceChildren(p.top >= 0 ? cardEl(p.top) : h("span"));
    el("suit").textContent = `${SUITS[p.suit].mark} ${SUITS[p.suit].name}`;
    el("suit").className = `suit s${p.suit}`;
    el("dir").textContent = p.dir > 0 ? "↻" : "↺";
    el("dir").title = p.dir > 0 ? "Clockwise" : "Counter-clockwise";
    el("log").replaceChildren(...p.log.slice().reverse().map((/** @type {any} */ e) => h("li", "", logLine(e))));

    const hand = mine ? mine.hand.slice().sort((a, b) => a - b) : [];
    const box = el("hand");
    box.replaceChildren(...hand.map((card) => {
      const ok = myTurn && (mine?.drawn ?? -1) < 0 ? playable(card, p.top, p.suit) : myTurn && card === mine?.drawn;
      const b = cardEl(card, "button");
      b.classList.toggle("playable", ok);
      /** @type {HTMLButtonElement} */ (b).disabled = !ok;
      b.addEventListener("click", () => {
        if (face(card).s === 4) {
          picking = card;
          render();
        } else table.act({ k: "play", card });
      });
      return b;
    }));
    if (!seated) box.append(h("p", "muted", "You are watching this round."));
    const count = hand.length;
    el("last").hidden = !seated || p.phase !== "play";
    /** @type {HTMLButtonElement} */ (el("last")).disabled = count > 2 || p.called.includes(me);
    el("last").classList.toggle("urgent", p.exposed === me);
    el("pass").hidden = !(myTurn && p.drew);
    el("again").hidden = p.phase !== "over" || !seated;

    const picker = el("suit-picker");
    picker.hidden = picking < 0 || !myTurn;
    picker.replaceChildren(h("p", "", "Choose a suit"), ...SUITS.map((s, i) => {
      const b = h("button", `pick s${i}`, `${s.mark} ${s.name}`);
      b.setAttribute("aria-label", `Choose ${s.name}`);
      b.addEventListener("click", () => {
        table.act({ k: "play", card: picking, suit: i });
        picking = -1;
        render();
      });
      return b;
    }));
    if (!picker.hidden) {
      const cancel = h("button", "", "Cancel");
      cancel.addEventListener("click", () => {
        picking = -1;
        render();
      });
      picker.append(cancel);
    }
  }

  el("join").addEventListener("click", () => table.act({ k: view.pub?.seats.includes(me) ? "leave" : "join" }));
  el("start").addEventListener("click", () => table.act({ k: "start" }));
  el("pile").addEventListener("click", () => table.act({ k: "draw" }));
  el("pass").addEventListener("click", () => table.act({ k: "pass" }));
  el("last").addEventListener("click", () => table.act({ k: "last" }));
  el("again").addEventListener("click", () => table.act({ k: "again" }));

  vokko.on("message", (data, from) => table.receive(data, from));
  vokko.on("players", (players, leader) => {
    table.setPlayers(players.map((x) => x.app_id), leader);
    render();
  });
  vokko.on("error", (code) => (el("note").textContent = code === "rate_limited" ? "Slow down a little" : `Error: ${code}`));
  vokko.on("close", () => table.stop());
  table.start();
  vokko.ready();
})();
