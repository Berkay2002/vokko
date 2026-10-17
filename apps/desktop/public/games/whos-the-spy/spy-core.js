// @ts-check
/*
 * Who's the Spy rules for PartyHost (../party-host.js); no DOM. Tests in src/games/party.test.ts.
 *
 * Everyone in the round but the spy (two spies from 7 players) privately gets the location and a role; the spies get
 * nothing. Players question each other out loud. During play anyone may accuse someone once per round; the others vote,
 * and a unanimous yes ends the round (town wins if the accused is a spy). A spy may stop the round to guess the location.
 * When time runs out everyone votes for a suspect; the most votes on a spy (no tie) wins it for the town.
 * Only the host knows the spies; private info: {loc, role} or {spy: true}. A new host cannot know them, so it ends the round.
 *
 * Intents: {k:"cfg", mins} {k:"start"} {k:"again"} (host), {k:"accuse", id} {k:"vote", yes} {k:"guess", loc} {k:"final", id}.
 */

var SpyCore = (() => {
  const { isInt, shuffle } = PartyHost;
  const C = { MINS: [4, 6, 8, 10], VOTE_MS: 30000, FINAL_MS: 45000, MIN_PLAYERS: 3, TWO_SPIES_AT: 7 };

  /** Our own locations; each has at least 7 roles so a 16-player call never runs out. */
  const LOCATIONS = /** @type {const} */ ([
    ["Airplane", ["Pilot", "Flight attendant", "Passenger in a middle seat", "Air marshal", "Mechanic", "Nervous flyer", "Baby"]],
    ["Bank", ["Teller", "Manager", "Security guard", "Customer", "Robber", "Armored car driver", "Loan officer"]],
    ["Beach", ["Lifeguard", "Ice cream seller", "Surfer", "Sunbather", "Kite flyer", "Sandcastle builder", "Photographer"]],
    ["Bowling alley", ["League champion", "Shoe rental clerk", "Snack bar cook", "Birthday kid", "Mechanic", "First-timer", "Referee"]],
    ["Cathedral", ["Priest", "Choir singer", "Tourist", "Organist", "Bell ringer", "Wedding guest", "Sinner"]],
    ["Circus", ["Acrobat", "Clown", "Ringmaster", "Lion tamer", "Juggler", "Visitor", "Magician"]],
    ["Cruise ship", ["Captain", "Bartender", "Rich passenger", "Musician", "Cook", "Sailor", "Honeymooner"]],
    ["Day spa", ["Masseur", "Customer", "Receptionist", "Stylist", "Manicurist", "Beautician", "Sauna regular"]],
    ["Embassy", ["Ambassador", "Security guard", "Secretary", "Refugee", "Diplomat", "Tourist", "Translator"]],
    ["Film studio", ["Director", "Stunt double", "Camera operator", "Actor", "Costume designer", "Extra", "Sound engineer"]],
    ["Fire station", ["Chief", "Firefighter", "Dispatcher", "Rookie", "Station dog", "Visiting class teacher", "Mechanic"]],
    ["Hospital", ["Nurse", "Doctor", "Surgeon", "Patient", "Anesthetist", "Intern", "Therapist"]],
    ["Hotel", ["Doorman", "Receptionist", "Bellhop", "Guest", "Housekeeper", "Bartender", "Manager"]],
    ["Ice rink", ["Figure skater", "Hockey player", "Zamboni driver", "Coach", "Parent", "Skate sharpener", "Beginner"]],
    ["Library", ["Librarian", "Student", "Author on tour", "Old reader", "Night guard", "Volunteer", "Book club host"]],
    ["Lighthouse", ["Keeper", "Fisher", "Tourist", "Painter", "Coast guard", "Storm chaser", "Supply boat captain"]],
    ["Mountain cabin", ["Ski instructor", "Hiker", "Cook", "Owner", "Lost tourist", "Snowboarder", "Mountain guide"]],
    ["Museum", ["Curator", "Guard", "Tour guide", "Art thief", "Student", "Restorer", "Visitor"]],
    ["Night market", ["Food stall cook", "Fortune teller", "Pickpocket", "Shopper", "Street musician", "Lantern seller", "Night owl"]],
    ["Bakery", ["Baker", "Cashier", "Delivery driver", "Cake decorator", "Regular customer", "Apprentice", "Health inspector"]],
    ["Pirate ship", ["Captain", "Cook", "Sailor", "Prisoner", "Cannoneer", "Lookout", "Parrot keeper"]],
    ["Police station", ["Detective", "Lawyer", "Journalist", "Criminal", "Desk sergeant", "Witness", "Patrol officer"]],
    ["Polar station", ["Medic", "Geologist", "Expedition leader", "Biologist", "Radio operator", "Hydrologist", "Cook"]],
    ["Recording studio", ["Producer", "Singer", "Drummer", "Sound engineer", "Manager", "Session violinist", "Intern"]],
    ["Restaurant", ["Musician", "Customer", "Bouncer", "Host", "Chef", "Food critic", "Waiter"]],
    ["School", ["Gym teacher", "Student", "Principal", "Janitor", "Cafeteria cook", "Nurse", "Substitute teacher"]],
    ["Space station", ["Engineer", "Commander", "Space tourist", "Doctor", "Scientist", "Pilot", "Alien stowaway"]],
    ["Submarine", ["Captain", "Sonar operator", "Cook", "Navigator", "Engineer", "Radio operator", "Diver"]],
    ["Supermarket", ["Cashier", "Shelf stocker", "Shopper", "Butcher", "Store manager", "Security guard", "Sample giver"]],
    ["Theater", ["Lead actor", "Prompter", "Ticket seller", "Audience member", "Director", "Stagehand", "Understudy"]],
    ["Train", ["Conductor", "Passenger", "Engineer", "Ticket inspector", "Dining car cook", "Stowaway", "Commuter"]],
    ["University", ["Professor", "Student", "Dean", "Lab assistant", "Janitor", "Visiting speaker", "Exchange student"]],
    ["Vineyard", ["Winemaker", "Grape picker", "Sommelier", "Tourist", "Owner", "Barrel maker", "Wedding planner"]],
    ["Zoo", ["Zookeeper", "Veterinarian", "Visitor", "Photographer", "Ice cream seller", "Tour guide", "Escaped monkey"]],
    ["Car repair shop", ["Mechanic", "Customer", "Tow truck driver", "Receptionist", "Apprentice", "Parts supplier", "Racing driver"]],
    ["Wedding", ["Bride", "Groom", "Best friend", "Photographer", "Caterer", "Uninvited guest", "Officiant"]],
  ]);

  function game() {
    /** Host only: who the spies are and the location. */
    let spies = /** @type {string[]} */ ([]);
    let loc = -1;
    /** Host only: final votes, app id -> suspect. @type {Record<string, string>} */
    let finals = {};
    let paused = 0; // play time left while a vote runs

    /** @param {PartyState} st @param {PartyCtx} ctx @param {"town" | "spy"} win @param {string} why */
    function finish(st, ctx, win, why) {
      st.phase = "end";
      st.deadline = 0;
      st.result = { win, why, spies, loc };
      for (const id of st.ids) {
        const spy = spies.includes(id);
        if (win === "spy" && spy) st.scores[id] = (st.scores[id] ?? 0) + 2;
        if (win === "town" && !spy) st.scores[id] = (st.scores[id] ?? 0) + 1;
      }
      ctx.secret = {};
    }

    /** @param {PartyState} st @param {PartyCtx} ctx @param {string} note */
    function abort(st, ctx, note) {
      Object.assign(st, { phase: "lobby", deadline: 0, note, result: null, accused: "", votes: {} });
      ctx.secret = {};
      spies = [];
    }

    /** @param {PartyState} st @param {PartyCtx} ctx */
    function resume(st, ctx) {
      Object.assign(st, { phase: "play", accused: "", by: "", votes: {}, deadline: ctx.now() + paused });
    }

    /** @param {PartyState} st @param {PartyCtx} ctx */
    function tally(st, ctx) {
      /** @type {Record<string, number>} */
      const count = {};
      for (const id of Object.values(finals)) count[id] = (count[id] ?? 0) + 1;
      const top = Math.max(0, ...Object.values(count));
      const leaders = Object.keys(count).filter((id) => count[id] === top);
      st.finals = finals;
      if (leaders.length === 1 && spies.includes(leaders[0])) finish(st, ctx, "town", "The vote found a spy");
      else finish(st, ctx, "spy", leaders.length === 1 ? "The vote picked someone innocent" : "The vote was split");
    }

    /** @type {PartyGame} */
    const g = {
      init: () => ({ phase: "lobby", deadline: 0, mins: 6, ids: [], spyCount: 1, first: "", accused: "", by: "", votes: {}, used: [], voted: [], finals: {}, result: null, scores: {}, note: "" }),
      intent(st, from, m, ctx) {
        const host = from === ctx.leader;
        const idle = st.phase === "lobby" || st.phase === "end";
        const inRound = st.ids.includes(from);
        if (m.k === "cfg" && host && idle && C.MINS.includes(m.mins)) {
          st.mins = m.mins;
          return true;
        }
        if (m.k === "again" && host && st.phase === "end") {
          Object.assign(st, { phase: "lobby", result: null, note: "" });
          return true;
        }
        if (m.k === "start" && host && idle) {
          if (ctx.players.length < C.MIN_PLAYERS) {
            st.note = `Needs at least ${C.MIN_PLAYERS} players`;
            return true;
          }
          const ids = ctx.players.slice();
          const count = ids.length >= C.TWO_SPIES_AT ? 2 : 1;
          spies = shuffle(ids, ctx.random).slice(0, count);
          loc = Math.floor(ctx.random() * LOCATIONS.length);
          const roles = shuffle(LOCATIONS[loc][1].slice(), ctx.random);
          ctx.secret = {};
          let r = 0;
          for (const id of ids) ctx.secret[id] = spies.includes(id) ? { spy: true } : { loc, role: roles[r++ % roles.length] };
          finals = {};
          Object.assign(st, {
            phase: "play", ids, spyCount: count, first: ids[Math.floor(ctx.random() * ids.length)], accused: "", by: "", votes: {},
            used: [], voted: [], finals: {}, result: null, note: "", deadline: ctx.now() + st.mins * 60000,
          });
          return true;
        }
        if (!inRound) return false;
        if (m.k === "accuse" && st.phase === "play" && typeof m.id === "string" && m.id !== from && st.ids.includes(m.id) && !st.used.includes(from)) {
          paused = Math.max(0, st.deadline - ctx.now());
          Object.assign(st, { phase: "vote", accused: m.id, by: from, votes: { [from]: true }, used: [...st.used, from], deadline: ctx.now() + C.VOTE_MS });
          return true;
        }
        if (m.k === "vote" && st.phase === "vote" && from !== st.accused && !(from in st.votes) && typeof m.yes === "boolean") {
          st.votes = { ...st.votes, [from]: m.yes };
          if (!m.yes) resume(st, ctx);
          else if (st.ids.every((/** @type {string} */ id) => id === st.accused || st.votes[id])) {
            if (spies.includes(st.accused)) finish(st, ctx, "town", "The accused was a spy");
            else finish(st, ctx, "spy", "The accused was innocent");
          }
          return true;
        }
        if (m.k === "guess" && (st.phase === "play" || st.phase === "vote") && spies.includes(from) && isInt(m.loc, LOCATIONS.length - 1)) {
          st.guess = { by: from, loc: m.loc };
          if (m.loc === loc) finish(st, ctx, "spy", "A spy named the location");
          else finish(st, ctx, "town", "A spy guessed the wrong location");
          return true;
        }
        if (m.k === "final" && st.phase === "final" && typeof m.id === "string" && m.id !== from && st.ids.includes(m.id) && !finals[from]) {
          finals[from] = m.id;
          st.voted = [...st.voted, from];
          if (st.ids.every((/** @type {string} */ id) => finals[id])) tally(st, ctx);
          return true;
        }
        return false;
      },
      timeout(st, ctx) {
        if (st.phase === "play") Object.assign(st, { phase: "final", voted: [], deadline: ctx.now() + C.FINAL_MS });
        else if (st.phase === "vote") resume(st, ctx);
        else if (st.phase === "final") tally(st, ctx);
      },
      players(st, ctx) {
        if (st.phase === "lobby" || st.phase === "end") return false;
        const gone = st.ids.filter((/** @type {string} */ id) => !ctx.players.includes(id));
        if (!gone.length) return false;
        if (gone.some((/** @type {string} */ id) => spies.includes(id))) abort(st, ctx, "A spy left the call, so the round ended");
        else if (st.ids.length - gone.length < C.MIN_PLAYERS) abort(st, ctx, "Too few players left, so the round ended");
        else {
          st.ids = st.ids.filter((/** @type {string} */ id) => !gone.includes(id));
          if (st.phase === "vote" && gone.includes(st.accused)) resume(st, ctx);
        }
        return true;
      },
      takeOver(st, ctx) {
        if (st.phase !== "lobby" && st.phase !== "end") abort(st, ctx, "The host left, so the round ended");
      },
    };
    return g;
  }

  return { game, LOCATIONS, C };
})();
globalThis.SpyCore = SpyCore;
