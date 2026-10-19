import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { COMMANDS, respond, type Interaction } from "./bot.ts";

const interaction = (name: string, options: Interaction["data"]["options"] = []): Interaction => ({
  id: "1",
  application_id: "2",
  type: 2,
  token: "t",
  data: { name, options },
  user: { id: "3", username: "sam" },
});

test("echo answers ephemerally with the text", () => {
  assert.deepEqual(respond(interaction("echo", [{ name: "text", type: 3, value: "hi there" }])), { type: 4, data: { content: "hi there", flags: 64 } });
});

test("roll uses the sides option (default 6)", () => {
  assert.equal(respond(interaction("roll", [{ name: "sides", type: 4, value: 20 }]), () => 0.999)?.data.content, "🎲 You rolled **20** (d20)");
  assert.equal(respond(interaction("roll"), () => 0)?.data.content, "🎲 You rolled **1** (d6)");
});

test("unknown commands get no answer and the registered set is /echo and /roll", () => {
  assert.equal(respond(interaction("nope")), null);
  assert.deepEqual(COMMANDS.map(c => c.name), ["echo", "roll"]);
});

test("running bot.ts directly starts it (here: fails fast without a token)", () => {
  const env = { ...process.env };
  delete env.VOKKO_BOT_TOKEN;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./bot.ts", import.meta.url))], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /set VOKKO_BOT_TOKEN/);
});
