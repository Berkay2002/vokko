// @ts-check
/*
 * Werewolf UI. The rules live in werewolf-core.js; the table (leader as moderator, late join, private roles) in
 * ../table-host.js. Every copy, the leader's too, shows only its own player's view. Relay data reaches the page only
 * via textContent.
 */
(async () => {
  const ROLES = {
    werewolf: { icon: "🐺", name: "Werewolf", text: "Each night, agree with your pack on someone to eat. By day, blend in." },
    seer: { icon: "🔮", name: "Seer", text: "Each night, learn whether one player is a werewolf." },
    doctor: { icon: "🩺", name: "Doctor", text: "Each night, protect one player from the wolves (not the same one twice in a row)." },
    hunter: { icon: "🏹", name: "Hunter", text: "If you die, you take one player down with you." },
    villager: { icon: "🌾", name: "Villager", text: "Find the werewolves and vote them out." },
  };
  const CAUSES = { wolves: "was killed in the night", vote: "was voted out", hunter: "was shot by the hunter", left: "left the game" };
  const PHASES = { lobby: "Werewolf", night: "Night", day: "Day", vote: "Vote", hunter: "The hunter", over: "Game over" };

  /** @param {string} id */
  const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  /** @param {string} tag @param {string} [cls] @param {string} [text] */
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  /** @param {unknown} r */
  const roleOf = (r) => ROLES[/** @type {keyof typeof ROLES} */ (String(r))] ?? ROLES.villager;

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

  const table = TableHost.create({ me, players: ids(), leader: vokko.leader, rules: WerewolfCore.rules, send: (d, to) => vokko.send(d, to), onView: render });
  const view = table.view;

  function secsLeft() {
    const p = view.pub;
    return p ? Math.max(0, Math.ceil(p.secs - (Date.now() - view.at) / 1000)) : 0;
  }

  function render() {
    const p = view.pub;
    const mine = /** @type {any} */ (view.priv);
    el("status").textContent = view.note;
    document.body.dataset.phase = p?.phase ?? "lobby";
    el("lobby").hidden = !p || p.phase !== "lobby";
    el("game").hidden = !p || p.phase === "lobby";
    if (!p) {
      el("status").textContent = view.waiting ? `Waiting for ${nameOf(vokko.leader)} to open the game` : "";
      return;
    }
    /** @type {string[]} */
    const seats = p.seats;
    const seated = seats.includes(me);
    el("phase").textContent = p.phase === "day" || p.phase === "vote" ? `${PHASES[/** @type {"day"} */ (p.phase)]} ${p.day}` : PHASES[/** @type {"night"} */ (p.phase)] ?? "Werewolf";
    tickTimer();

    if (p.phase === "lobby") {
      if (!view.note) el("status").textContent = seated ? (seats.length < 5 ? `Waiting for ${5 - seats.length} more` : "Ready to start") : "Take a seat";
      el("seat-count").textContent = `${seats.length}/16`;
      el("seats").replaceChildren(...seats.map((id) => h("li", "", `${nameOf(id)}${id === me ? " (you)" : ""}`)));
      if (!seats.length) el("seats").append(h("li", "muted", "Nobody yet"));
      el("join").textContent = seated ? "Leave" : "Join";
      /** @type {HTMLButtonElement} */ (el("join")).disabled = !seated && seats.length >= 16;
      /** @type {HTMLButtonElement} */ (el("start")).disabled = !seated || seats.length < 5;
      /** @type {HTMLInputElement} */ (el("hunter")).checked = p.hunter;
      /** @type {HTMLInputElement} */ (el("hunter")).disabled = !seated;
      /** @type {HTMLSelectElement} */ (el("day-len")).value = String(p.dayLen);
      /** @type {HTMLSelectElement} */ (el("day-len")).disabled = !seated;
      return;
    }

    /** @type {string[]} */
    const dead = p.dead;
    const alive = seated && !dead.includes(me);
    const role = mine?.role ?? "";
    // Roles this player may know: the revealed dead, their pack, everything once dead or over.
    /** @type {Record<string, string>} */
    const known = { ...(mine?.all ?? {}), ...p.reveal };
    if (role === "werewolf") for (const id of mine.wolves ?? []) known[id] = "werewolf";
    if (role) known[me] = role;
    /** @type {Record<string, boolean>} */
    const seen = Object.fromEntries(mine?.seerLog ?? []);

    const r = roleOf(role);
    el("role-card").hidden = !role;
    el("role-icon").textContent = r.icon;
    el("role").textContent = role ? `You are the ${r.name}` : "";
    el("role-text").textContent = role ? r.text : "";
    el("dead-note").hidden = !seated || alive || p.phase === "over";

    // What a click on a player does now, if anything.
    /** @type {"pick" | "vote" | "shoot" | ""} */
    let action = "";
    let mark = "";
    if (p.phase === "night" && alive && ["werewolf", "seer", "doctor"].includes(role)) {
      action = "pick";
      mark = role === "werewolf" ? mine.wolf?.[me] ?? "" : mine.pick ?? "";
    } else if (p.phase === "vote" && alive) {
      action = "vote";
      mark = p.votes[me] ?? "";
    } else if (p.phase === "hunter" && p.shooter === me) action = "shoot";
    const canTarget = (/** @type {string} */ id) =>
      !dead.includes(id) &&
      (action === "vote" ||
        (action === "shoot" && id !== me) ||
        (action === "pick" && (role === "werewolf" ? known[id] !== "werewolf" : role === "seer" ? id !== me : id !== mine.last)));

    const living = seats.filter((id) => !dead.includes(id)).length;
    const prompts = {
      night: !seated ? "Night falls. You are watching." : !alive ? "Night: watch quietly." : role === "werewolf" ? "Choose a victim with your pack. The night ends when you all agree."
        : role === "seer" ? "Choose someone to see." : role === "doctor" ? "Choose someone to protect." : "Night falls. Close your eyes and wait for morning.",
      day: `Talk it over in voice. The vote starts when the time is up or everyone is ready (${p.ready.length}/${living}).`,
      vote: `Vote: ${Math.floor(living / 2) + 1} of ${living} votes remove a player.`,
      hunter: p.shooter === me ? "You were the hunter: take someone down with you." : `${nameOf(p.shooter)} was the hunter and takes aim...`,
      over: p.winner === "village" ? "The village wins: every werewolf is gone." : "The werewolves win: they outnumber the village.",
    };
    el("prompt").textContent = prompts[/** @type {"day"} */ (p.phase)] ?? "";
    el("ready").hidden = !(p.phase === "day" && alive);
    /** @type {HTMLButtonElement} */ (el("ready")).disabled = p.ready.includes(me);
    el("nobody").hidden = !(p.phase === "vote" && alive);
    el("nobody").classList.toggle("chosen", p.phase === "vote" && p.votes[me] === "");
    el("again").hidden = !(p.phase === "over" && seated);

    /** @type {string[]} */
    const news = p.news;
    el("news").replaceChildren(...news.map((id) => h("li", "", `${nameOf(id)} ${CAUSES[/** @type {"vote"} */ (p.causes[id])] ?? "died"}: ${roleOf(p.reveal[id]).name.toLowerCase()}.`)));
    if (!news.length && p.day > 0) el("news").append(h("li", "muted", p.phase === "night" ? "Nobody was voted out." : "Nobody died last night."));
    el("seer-log").replaceChildren(...(mine?.seerLog ?? []).map((/** @type {[string, boolean]} */ [id, wolf]) => h("li", wolf ? "wolf" : "", `${role === "seer" ? "" : "The seer saw: "}${nameOf(id)} ${wolf ? "is a werewolf" : "is not a werewolf"}`)));

    // Who voted or picked whom, as far as this player may see.
    /** @type {Record<string, string[]>} */
    const marks = {};
    const add = (/** @type {string} */ target, /** @type {string} */ text) => (marks[target] ??= []).push(text);
    if (p.phase === "vote") for (const [voter, target] of Object.entries(p.votes)) if (target) add(String(target), nameOf(voter));
    const seeAll = !!mine?.all;
    if (p.phase === "night" && (role === "werewolf" || seeAll)) for (const [wolf, target] of Object.entries(mine?.wolf ?? {})) add(String(target), `🐺 ${nameOf(wolf)}`);
    if (p.phase === "night" && seeAll && mine.seer) add(mine.seer, "🔮");
    if (p.phase === "night" && seeAll && mine.doctor) add(mine.doctor, "🩺");

    el("players").replaceChildren(...seats.map((id) => {
      const isDead = dead.includes(id);
      const on = action !== "" && canTarget(id);
      const li = h("li", `player${isDead ? " dead" : ""}${id === me ? " me" : ""}${mark === id ? " chosen" : ""}`);
      const card = h(on ? "button" : "div", "tile");
      if (card instanceof HTMLButtonElement) {
        card.type = "button";
        card.setAttribute("aria-label", `${action === "vote" ? "Vote for" : action === "shoot" ? "Shoot" : "Choose"} ${nameOf(id)}`);
        card.addEventListener("click", () => table.act({ k: action === "pick" ? "pick" : action, target: id }));
      }
      const knownRole = known[id];
      card.append(h("span", "avatar", knownRole ? roleOf(knownRole).icon : nameOf(id).slice(0, 1).toUpperCase()));
      card.append(h("span", "name", `${nameOf(id)}${id === me ? " (you)" : ""}`));
      const sub = isDead ? `${roleOf(p.reveal[id] ?? known[id]).name} · ${CAUSES[/** @type {"vote"} */ (p.causes[id])] ?? "dead"}`
        : knownRole && id !== me ? roleOf(knownRole).name
        : id in seen ? (seen[id] ? "Werewolf (seen)" : "Not a werewolf (seen)")
        : p.phase === "day" && p.ready.includes(id) ? "Ready to vote"
        : "";
      card.append(h("span", "sub", sub));
      if (marks[id]) card.append(h("span", "marks", marks[id].join(", ")));
      li.append(card);
      return li;
    }));
  }

  function tickTimer() {
    const p = view.pub;
    el("timer").textContent = p && ["night", "day", "vote", "hunter"].includes(p.phase) ? `${secsLeft()}s` : "";
  }

  el("join").addEventListener("click", () => table.act({ k: view.pub?.seats.includes(me) ? "leave" : "join" }));
  el("start").addEventListener("click", () => table.act({ k: "start" }));
  el("hunter").addEventListener("change", (e) => table.act({ k: "hunter", on: /** @type {HTMLInputElement} */ (e.target).checked }));
  el("day-len").addEventListener("change", (e) => table.act({ k: "day", secs: Number(/** @type {HTMLSelectElement} */ (e.target).value) }));
  el("ready").addEventListener("click", () => table.act({ k: "ready" }));
  el("nobody").addEventListener("click", () => table.act({ k: "vote", target: "" }));
  el("again").addEventListener("click", () => table.act({ k: "again" }));

  vokko.on("message", (data, from) => table.receive(data, from));
  vokko.on("players", (players, leader) => {
    table.setPlayers(players.map((x) => x.app_id), leader);
    render();
  });
  vokko.on("error", (code) => (el("status").textContent = code === "rate_limited" ? "Slow down a little" : `Error: ${code}`));
  const ticker = setInterval(tickTimer, 500);
  vokko.on("close", () => {
    clearInterval(ticker);
    table.stop();
  });
  table.start();
  vokko.ready();
})();
