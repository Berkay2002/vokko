// @ts-check
// e2e-only game: shows the player count, sends {ping:n}, lists received messages and answers {ping:n} with {pong:n}.
(async () => {
  const status = /** @type {HTMLElement} */ (document.getElementById("status"));
  const players = /** @type {HTMLElement} */ (document.getElementById("players"));
  const pingButton = /** @type {HTMLButtonElement} */ (document.getElementById("ping"));
  const list = /** @type {HTMLElement} */ (document.getElementById("messages"));

  /** @param {string} text */
  function log(text) {
    const li = document.createElement("li");
    li.dataset.testid = "game-message";
    li.textContent = text;
    list.append(li);
  }

  try {
    const vokko = await VokkoGames.connect();
    status.textContent = `Connected as ${vokko.me.name}`;
    const showPlayers = () => (players.textContent = `players: ${vokko.players.length}`);
    showPlayers();
    vokko.on("players", showPlayers);
    vokko.on("message", (data, from) => {
      log(JSON.stringify(data));
      if (data && typeof data === "object" && "ping" in data && typeof data.ping === "number") {
        vokko.send({ pong: data.ping }, from);
      }
    });
    vokko.on("error", (code) => log(`error: ${code}`));
    let n = 0;
    pingButton.disabled = false;
    pingButton.addEventListener("click", () => vokko.send({ ping: ++n }));
    vokko.ready();
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : String(err);
  }
})();
