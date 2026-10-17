// @ts-check
/*
 * Werewolf rules for TableHost (../table-host.js), no DOM; tests in src/games/werewolf.test.ts.
 * Rules adapted from JamesCraster/OpenWerewolf (Apache-2.0): night actions in private, a day discussion, a vote where
 * a strict majority of the living eliminates a player, roles revealed on death, win checks after every death.
 *
 * Roles: werewolves (1 for 5-6 players, 2 for 7-11, 3 for 12-16), one seer, one doctor, an optional hunter, the rest
 * villagers. Night: the wolves agree on a victim (if they still disagree when time runs out, the most picked, ties at
 * random), the seer learns whether one player is a wolf, the doctor protects one player (not the same one two nights
 * running). The night ends early once everyone with a night role has picked and the wolves agree. Day: talk in voice,
 * then vote; anyone may say they are ready to vote early. A hunter who dies shoots one player. The village wins when
 * no wolf is left; the wolves win once they are at least as many as everyone else alive. The leader runs this as the
 * moderator: its own UI only shows its own player's view, like everyone else's.
 *
 * Intents: {k:"join"} {k:"leave"} {k:"start"} {k:"hunter", on} {k:"day", secs} {k:"pick", target} {k:"ready"}
 *          {k:"vote", target} (target "" = nobody) {k:"shoot", target} {k:"again"}
 */

/**
 * @typedef {"villager" | "werewolf" | "seer" | "doctor" | "hunter"} Role
 * @typedef {"wolves" | "vote" | "hunter" | "left"} Cause
 * @typedef {{
 *   phase: "lobby" | "night" | "day" | "vote" | "hunter" | "over", seats: string[], roles: Record<string, Role>,
 *   dead: string[], causes: Record<string, Cause>, hunter: boolean, dayLen: number, day: number, deadline: number,
 *   wolf: Record<string, string>, seer: string, doctor: string, lastProtect: string, seerLog: [string, boolean][],
 *   votes: Record<string, string>, ready: string[], shooter: string, after: "day" | "night", news: string[], winner: string,
 * }} WolfState
 */

var WerewolfCore = (() => {
  const C = { MIN: 5, MAX: 16, NIGHT: 60, VOTE: 60, SHOT: 30, DAYS: [60, 120, 180], DAY: 120 };

  const wolvesFor = (/** @type {number} */ n) => (n <= 6 ? 1 : n <= 11 ? 2 : 3);

  /** @param {{ seats: string[] } | null} prev @returns {WolfState} */
  function init(prev) {
    return {
      phase: "lobby", seats: prev ? prev.seats.slice(0, C.MAX) : [], roles: {}, dead: [], causes: {}, hunter: false, dayLen: C.DAY,
      day: 0, deadline: 0, wolf: {}, seer: "", doctor: "", lastProtect: "", seerLog: [], votes: {}, ready: [], shooter: "",
      after: "day", news: [], winner: "",
    };
  }

  /** @param {WolfState} s */
  const alive = (s) => s.seats.filter((id) => !s.dead.includes(id));
  /** @param {WolfState} s @param {Role} role */
  const aliveWith = (s, role) => alive(s).filter((id) => s.roles[id] === role);

  /** @param {WolfState} s @param {() => number} random */
  function deal(s, random) {
    const n = s.seats.length;
    /** @type {Role[]} */
    const roles = [...Array(wolvesFor(n)).fill("werewolf"), "seer", "doctor"];
    if (s.hunter) roles.push("hunter");
    while (roles.length < n) roles.push("villager");
    TableHost.shuffle(roles, random);
    s.roles = Object.fromEntries(s.seats.map((id, i) => [id, roles[i]]));
    Object.assign(s, { dead: [], causes: {}, day: 0, lastProtect: "", seerLog: [], news: [], winner: "", shooter: "" });
  }

  /** @param {WolfState} s @param {"night" | "day" | "vote"} phase @param {number} now */
  function go(s, phase, now) {
    s.phase = phase;
    if (phase === "night") {
      Object.assign(s, { wolf: {}, seer: "", doctor: "", deadline: now + C.NIGHT * 1000 });
    } else if (phase === "day") {
      s.day += 1;
      Object.assign(s, { ready: [], votes: {}, deadline: now + s.dayLen * 1000 });
    } else {
      Object.assign(s, { votes: {}, deadline: now + C.VOTE * 1000 });
    }
  }

  /** @param {WolfState} s @param {string} id @param {Cause} cause */
  function kill(s, id, cause) {
    if (s.dead.includes(id)) return;
    s.dead.push(id);
    s.causes[id] = cause;
    s.news.push(id);
    if (s.roles[id] === "hunter" && cause !== "left") s.shooter = id;
  }

  /** Win check, then the hunter's shot if one is due, else the next phase. @param {WolfState} s @param {"day" | "night"} next @param {number} now */
  function afterDeaths(s, next, now) {
    const wolves = aliveWith(s, "werewolf").length;
    const others = alive(s).length - wolves;
    if (!wolves || wolves >= others) {
      s.phase = "over";
      s.winner = wolves ? "wolves" : "village";
      s.shooter = "";
    } else if (s.shooter) {
      s.phase = "hunter";
      s.after = next;
      s.deadline = now + C.SHOT * 1000;
    } else {
      s.shooter = "";
      go(s, next, now);
    }
  }

  /** @param {WolfState} s @param {() => number} random */
  function wolfVictim(s, random) {
    /** @type {Record<string, number>} */
    const count = {};
    for (const id of aliveWith(s, "werewolf")) if (s.wolf[id]) count[s.wolf[id]] = (count[s.wolf[id]] ?? 0) + 1;
    const top = Math.max(0, ...Object.values(count));
    const tied = Object.keys(count).filter((id) => count[id] === top);
    return tied.length ? tied[Math.floor(random() * tied.length)] : "";
  }

  /** @param {WolfState} s @param {{ now: number, random: () => number }} ctx */
  function dawn(s, ctx) {
    s.news = [];
    const victim = wolfVictim(s, ctx.random);
    const seer = aliveWith(s, "seer")[0];
    if (seer && s.seer) s.seerLog.push([s.seer, s.roles[s.seer] === "werewolf"]);
    s.lastProtect = s.doctor;
    if (victim && victim !== s.doctor) kill(s, victim, "wolves");
    afterDeaths(s, "day", ctx.now);
  }

  /** @param {WolfState} s */
  function nightDone(s) {
    const wolves = aliveWith(s, "werewolf");
    const picks = new Set(wolves.map((id) => s.wolf[id]));
    return wolves.every((id) => s.wolf[id]) && picks.size <= 1 && (!aliveWith(s, "seer").length || !!s.seer) && (!aliveWith(s, "doctor").length || !!s.doctor);
  }

  /** The vote ends on a strict majority (for a player or for nobody), or when everyone voted. @param {WolfState} s @param {number} now @param {boolean} timeUp */
  function tally(s, now, timeUp) {
    const living = alive(s);
    /** @type {Record<string, number>} */
    const count = {};
    for (const id of living) if (id in s.votes) count[s.votes[id]] = (count[s.votes[id]] ?? 0) + 1;
    const out = Object.keys(count).find((t) => count[t] * 2 > living.length);
    if (out === undefined && !timeUp && living.some((id) => !(id in s.votes))) return false;
    s.news = [];
    if (out) kill(s, out, "vote");
    afterDeaths(s, "night", now);
    return true;
  }

  /** Move on when everyone is done before the clock. @param {WolfState} s @param {{ now: number, random: () => number }} ctx */
  function progress(s, ctx) {
    if (s.phase === "night" && nightDone(s)) dawn(s, ctx);
    else if (s.phase === "day" && alive(s).every((id) => s.ready.includes(id))) go(s, "vote", ctx.now);
    else if (s.phase === "vote") tally(s, ctx.now, false);
  }

  /** @param {WolfState} s @param {string} from @param {any} a @param {{ now: number, random: () => number }} ctx */
  function act(s, from, a, ctx) {
    const seated = s.seats.includes(from);
    const living = seated && !s.dead.includes(from);
    const target = typeof a.target === "string" ? a.target : null;
    const targetAlive = target !== null && s.seats.includes(target) && !s.dead.includes(target);
    const role = s.roles[from];
    switch (a.k) {
      case "join":
        if (s.phase !== "lobby" || seated || s.seats.length >= C.MAX) return false;
        s.seats.push(from);
        return true;
      case "leave":
        if (s.phase !== "lobby" || !seated) return false;
        s.seats = s.seats.filter((x) => x !== from);
        return true;
      case "hunter":
        if (s.phase !== "lobby" || !seated || typeof a.on !== "boolean") return false;
        s.hunter = a.on;
        return true;
      case "day":
        if (s.phase !== "lobby" || !seated || !C.DAYS.includes(a.secs)) return false;
        s.dayLen = a.secs;
        return true;
      case "start":
        if (s.phase !== "lobby" || !seated || s.seats.length < C.MIN) return false;
        deal(s, ctx.random);
        go(s, "night", ctx.now);
        return true;
      case "again":
        if (s.phase !== "over" || !seated) return false;
        Object.assign(s, init(s), { hunter: s.hunter, dayLen: s.dayLen });
        return true;
      case "pick":
        if (s.phase !== "night" || !living || !targetAlive || target === null) return false;
        if (role === "werewolf" && s.roles[target] !== "werewolf") s.wolf[from] = target;
        else if (role === "seer" && target !== from) s.seer = target;
        else if (role === "doctor" && target !== s.lastProtect) s.doctor = target;
        else return false;
        progress(s, ctx);
        return true;
      case "ready":
        if (s.phase !== "day" || !living || s.ready.includes(from)) return false;
        s.ready.push(from);
        progress(s, ctx);
        return true;
      case "vote":
        if (s.phase !== "vote" || !living || target === null || (target !== "" && !targetAlive)) return false;
        s.votes[from] = target;
        progress(s, ctx);
        return true;
      case "shoot":
        if (s.phase !== "hunter" || from !== s.shooter || !targetAlive || target === null || target === from) return false;
        s.shooter = "";
        kill(s, target, "hunter");
        afterDeaths(s, s.after, ctx.now);
        return true;
    }
    return false;
  }

  /** @param {WolfState} s @param {{ now: number, random: () => number }} ctx */
  function tick(s, ctx) {
    if (s.phase === "lobby" || s.phase === "over" || ctx.now < s.deadline) return false;
    if (s.phase === "night") dawn(s, ctx);
    else if (s.phase === "day") go(s, "vote", ctx.now);
    else if (s.phase === "vote") tally(s, ctx.now, true);
    else {
      s.shooter = "";
      afterDeaths(s, s.after, ctx.now);
    }
    return true;
  }

  /** A player who left the call dies (revealed, no hunter shot); in the lobby they lose their seat. @param {WolfState} s @param {string[]} present */
  function left(s, present, ctx = { now: Date.now(), random: Math.random }) {
    if (s.phase === "lobby" || s.phase === "over") {
      const seats = s.seats.filter((id) => present.includes(id));
      if (seats.length === s.seats.length) return false;
      s.seats = seats;
      return true;
    }
    const gone = s.seats.filter((id) => !present.includes(id) && !s.dead.includes(id));
    if (!gone.length) return false;
    for (const id of gone) {
      kill(s, id, "left");
      if (s.shooter === id) s.shooter = "";
    }
    if (s.phase === "hunter" && !s.shooter) afterDeaths(s, s.after, ctx.now);
    else {
      const wolves = aliveWith(s, "werewolf").length;
      if (!wolves || wolves >= alive(s).length - wolves) afterDeaths(s, "night", ctx.now);
      else progress(s, ctx);
    }
    return true;
  }

  /** @param {WolfState} s @param {{ now: number }} ctx */
  function pub(s, ctx) {
    const shown = s.phase === "over" ? s.seats : s.dead;
    return {
      phase: s.phase, seats: s.seats, dead: s.dead, causes: s.causes, reveal: Object.fromEntries(shown.map((id) => [id, s.roles[id]])),
      hunter: s.hunter, dayLen: s.dayLen, day: s.day, secs: Math.max(0, Math.ceil((s.deadline - ctx.now) / 1000)),
      votes: s.phase === "vote" ? s.votes : {}, ready: s.phase === "day" ? s.ready : [], shooter: s.phase === "hunter" ? s.shooter : "",
      news: s.news, winner: s.winner,
    };
  }

  /** @param {WolfState} s @param {string} id */
  function priv(s, id) {
    const role = s.roles[id];
    if (s.phase === "lobby" || !role) return null;
    // Dead players (and everyone once it is over) see everything.
    if (s.dead.includes(id) || s.phase === "over") return { role, all: s.roles, wolf: s.wolf, seer: s.seer, doctor: s.doctor, seerLog: s.seerLog };
    if (role === "werewolf") return { role, wolves: s.seats.filter((x) => s.roles[x] === "werewolf"), wolf: s.wolf };
    if (role === "seer") return { role, pick: s.seer, seerLog: s.seerLog };
    if (role === "doctor") return { role, pick: s.doctor, last: s.lastProtect };
    return { role };
  }

  /** @type {TableRules} */
  const rules = { init, act, left, tick, pub, priv };
  return { rules, C, wolvesFor };
})();
globalThis.WerewolfCore = WerewolfCore;
