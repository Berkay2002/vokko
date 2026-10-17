// @ts-check
// Who's the Spy page: your secret card, accusations and votes, the spy's guess and the result. Rules in spy-core.js.
(() => {
  const { el, h, select, players, boot } = PartyUI;
  const { LOCATIONS, C } = SpyCore;
  let key = "";
  let pickedPlace = -1; // the spy's chosen guess, confirmed with a second button
  /** Places this player crossed out (local only). @type {Set<number>} */
  const crossed = new Set();

  /** @param {PartyApp} app */
  function lobby(app) {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const host = app.isHost();
    const n = app.host.ctx.players.length;
    el("status").textContent = host ? "Set the timer and start" : `${app.nameOf(app.host.ctx.leader)} starts the round`;
    const mins = /** @type {[number, string][]} */ (C.MINS.map((m) => [m, `${m} minutes`]));
    return h("div", { className: "card" }, h("h2", { textContent: "How to play" }),
      h("p", { textContent: "Everyone but the spy sees the same secret location and a role there. Take turns asking each other questions out loud. The spy tries to blend in and work out where you are; everyone else tries to find the spy without giving the place away." }),
      h("p", { className: "muted", textContent: `Accuse someone to call a vote (once per round each). A spy can stop the round any time to guess the location. ${C.MIN_PLAYERS}+ players; two spies from ${C.TWO_SPIES_AT}.` }),
      host
        ? h("div", { className: "row" }, select(mins, st.mins, (m) => app.act({ k: "cfg", mins: m }), "Round length"),
            h("button", { className: "primary", textContent: "Start round", disabled: n < C.MIN_PLAYERS, onclick: () => app.act({ k: "start" }) }),
            n < C.MIN_PLAYERS ? h("span", { className: "muted", textContent: `Waiting for ${C.MIN_PLAYERS - n} more` }) : "")
        : h("p", { className: "big", textContent: `${st.mins}-minute rounds` }));
  }

  /** My secret card. @param {PartyApp} app */
  function secret(app) {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const mine = app.host.view.mine;
    if (!st.ids.includes(app.me)) return h("div", { className: "card secret" }, h("p", { className: "big", textContent: "Round in progress" }), h("p", { className: "muted", textContent: "You join from the next round." }));
    if (mine?.spy) {
      return h("div", { className: "card secret spy" }, h("p", { className: "big", textContent: "You are the spy" }),
        h("p", { textContent: st.spyCount > 1 ? "There is one more spy. Find out the location without getting caught." : "Find out the location without getting caught." }));
    }
    const loc = LOCATIONS[mine?.loc];
    if (!loc) return h("div", { className: "card secret" }, h("p", { className: "big", textContent: "Getting your card..." }));
    return h("div", { className: "card secret" }, h("p", { className: "muted", textContent: "Location" }), h("p", { className: "big", textContent: loc[0] }),
      h("p", { className: "muted", textContent: "Your role" }), h("p", { className: "role", textContent: String(mine.role ?? "") }));
  }

  /** The vote or result panel under the card. @param {PartyApp} app */
  function action(app) {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const me = app.me;
    const playing = st.ids.includes(me);
    if (st.phase === "vote") {
      const voters = st.ids.filter((/** @type {string} */ id) => id !== st.accused);
      const canVote = playing && me !== st.accused && !(me in st.votes);
      return h("div", { className: "card vote" },
        h("p", { className: "big", textContent: `${app.nameOf(st.by)} accuses ${app.nameOf(st.accused)}. Is ${app.nameOf(st.accused)} a spy?` }),
        h("p", { className: "muted", textContent: `Everyone else must say yes: ${Object.keys(st.votes).length} of ${voters.length} voted` }),
        canVote ? h("div", { className: "row" }, h("button", { className: "good", textContent: "Yes, a spy", onclick: () => app.act({ k: "vote", yes: true }) }),
          h("button", { className: "bad", textContent: "No", onclick: () => app.act({ k: "vote", yes: false }) })) : "");
    }
    if (st.phase === "final") {
      const done = st.voted.includes(me);
      return h("div", { className: "card vote" }, h("p", { className: "big", textContent: "Time's up! Who is the spy?" }),
        h("p", { className: "muted", textContent: `${st.voted.length} of ${st.ids.length} voted. The most votes on a spy wins it for the town; a tie lets the spy win.` }),
        playing && !done ? h("div", { className: "row" }, ...st.ids.filter((/** @type {string} */ id) => id !== me).map((/** @type {string} */ id) =>
          h("button", { textContent: app.nameOf(id), onclick: () => app.act({ k: "final", id }) }))) : h("p", { textContent: done ? "Your vote is in" : "" }));
    }
    if (st.phase === "end" && st.result) {
      const r = st.result;
      const spyNames = (Array.isArray(r.spies) ? r.spies : []).map((/** @type {string} */ id) => app.nameOf(id)).join(" and ");
      return h("div", { className: `card result ${r.win}` },
        h("p", { className: "big", textContent: r.win === "town" ? "The town wins" : r.spies?.length > 1 ? "The spies win" : "The spy wins" }),
        h("p", { textContent: String(r.why ?? "") }),
        h("p", { textContent: `${r.spies?.length > 1 ? "Spies" : "Spy"}: ${spyNames}. Location: ${LOCATIONS[r.loc]?.[0] ?? "?"}` }),
        app.isHost() ? h("button", { className: "primary", textContent: "Next round", onclick: () => app.act({ k: "again" }) }) : h("p", { className: "muted", textContent: "Waiting for the host" }));
    }
    const first = st.first ? h("p", { className: "muted", textContent: `${app.nameOf(st.first)} asks the first question.` }) : "";
    const accuse = playing && !st.used.includes(me)
      ? h("div", { className: "row" }, h("span", { className: "muted", textContent: "Accuse:" }), ...st.ids.filter((/** @type {string} */ id) => id !== me).map((/** @type {string} */ id) =>
          h("button", { textContent: app.nameOf(id), onclick: () => app.act({ k: "accuse", id }) })))
      : h("p", { className: "muted", textContent: playing ? "You used your accusation this round." : "" });
    return h("div", { className: "card" }, first, accuse);
  }

  /** The location list: the spy picks a guess there; others can cross places out for themselves. @param {PartyApp} app */
  function places(app) {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const spy = !!app.host.view.mine?.spy && (st.phase === "play" || st.phase === "vote");
    const show = st.phase !== "lobby";
    el("places-card").hidden = !show;
    if (!show) return;
    el("places-title").textContent = spy ? "Guess the location (ends the round)" : "Possible locations";
    const box = el("places");
    box.replaceChildren(...LOCATIONS.map(([name], i) => {
      const b = h("button", { type: "button", textContent: name, className: `place${crossed.has(i) ? " crossed" : ""}${i === pickedPlace ? " picked" : ""}` });
      b.onclick = () => {
        if (spy) pickedPlace = pickedPlace === i ? -1 : i;
        else if (!crossed.delete(i)) crossed.add(i);
        places(app);
      };
      return b;
    }));
    if (spy && pickedPlace >= 0) {
      box.append(h("div", { className: "row confirm" }, h("button", { className: "primary", textContent: `Guess: ${LOCATIONS[pickedPlace][0]}`, onclick: () => app.act({ k: "guess", loc: pickedPlace }) }),
        h("button", { textContent: "Cancel", onclick: () => ((pickedPlace = -1), places(app)) })));
    }
  }

  boot(() => SpyCore.game(), (app) => {
    const st = /** @type {PartyState} */ (app.host.view.st);
    const mine = app.host.view.mine;
    const k = JSON.stringify([st.phase, st.ids, st.first, st.accused, st.votes, st.voted, st.used, st.result, st.mins, mine, app.isHost(), app.host.ctx.players.length]);
    if (k !== key) {
      if (st.phase !== "play" && st.phase !== "vote") pickedPlace = -1;
      if (st.phase === "lobby") crossed.clear();
      key = k;
      if (st.phase === "lobby") el("stage").replaceChildren(lobby(app));
      else el("stage").replaceChildren(st.phase === "end" ? "" : secret(app), action(app));
      places(app);
    }
    if (st.phase === "play") el("status").textContent = "Ask questions, find the spy";
    else if (st.phase === "vote") el("status").textContent = "Vote";
    else if (st.phase === "final") el("status").textContent = "Final vote";
    else if (st.phase === "end") el("status").textContent = "Round over";
    players(app, st.scores, (id) => (st.phase === "final" && st.voted.includes(id) ? "✓" : st.phase === "vote" && id in st.votes ? (st.votes[id] ? "✓" : "✗") : ""));
  });
})();
