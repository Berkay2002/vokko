// A tiny Vokko bot using only the public API (docs/api.md "Apps"): registers /echo text: and /roll sides:, connects to the
// gateway with its bot token and answers INTERACTION_CREATE through the callback URL. No dependencies: Node 22's fetch and WebSocket.
//
//   VOKKO_API=http://127.0.0.1:8710 VOKKO_BOT_TOKEN=... [VOKKO_GUILD_ID=...] node bot.ts
//
// With VOKKO_GUILD_ID the commands are registered for that server only; otherwise globally.

export interface InteractionOption {
  name: string;
  type: number;
  value: string | number | boolean;
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  data: { name: string; options?: InteractionOption[] };
  user: { id: string; username: string };
}

export interface InteractionResponse {
  type: 4;
  data: { content: string; flags?: number };
}

const EPHEMERAL = 1 << 6;

export const COMMANDS = [
  { name: "echo", description: "Repeat text back (only you see it)", options: [{ type: 3, name: "text", description: "What to say", required: true, max_length: 2000 }] },
  { name: "roll", description: "Roll a die", options: [{ type: 4, name: "sides", description: "Number of sides (default 6)", min_value: 2, max_value: 100 }] },
];

/** The answer to one command; `random` is injectable for tests. */
export function respond(interaction: Interaction, random: () => number = Math.random): InteractionResponse | null {
  const option = (name: string) => interaction.data.options?.find(o => o.name === name)?.value;
  switch (interaction.data.name) {
    case "echo":
      return { type: 4, data: { content: String(option("text") ?? ""), flags: EPHEMERAL } };
    case "roll": {
      const sides = Number(option("sides") ?? 6);
      return { type: 4, data: { content: `🎲 You rolled **${1 + Math.floor(random() * sides)}** (d${sides})` } };
    }
    default:
      return null;
  }
}

async function api<T>(base: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bot ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** Callback: needs no Authorization header, the interaction token is the credential. */
async function answer(base: string, interaction: Interaction, response: InteractionResponse): Promise<void> {
  const result = await fetch(`${base}/api/v1/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
  });
  if (!result.ok) console.error(`callback failed: ${result.status} ${await result.text()}`);
}

export async function run(base: string, token: string, guildId?: string): Promise<void> {
  const me = await api<{ id: string; username: string }>(base, token, "GET", "/users/@me");
  const path = guildId ? `/applications/${me.id}/guilds/${guildId}/commands` : `/applications/${me.id}/commands`;
  const registered = await api<{ name: string }[]>(base, token, "PUT", path, COMMANDS);
  console.log(`${me.username}: registered ${registered.map(c => `/${c.name}`).join(", ")}`);
  connect(base, token);
}

function connect(base: string, token: string, attempt = 0): void {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/gateway`);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let seq: number | null = null;
  socket.addEventListener("message", event => {
    const payload = JSON.parse(String(event.data)) as { op: number; d: unknown; s: number | null; t: string | null };
    if (payload.s !== null) seq = payload.s;
    if (payload.op === 10) {
      const { heartbeat_interval } = payload.d as { heartbeat_interval: number };
      heartbeat = setInterval(() => socket.send(JSON.stringify({ op: 1, d: seq })), heartbeat_interval);
      socket.send(JSON.stringify({ op: 2, d: { token: `Bot ${token}` } }));
    } else if (payload.op === 0 && payload.t === "READY") {
      attempt = 0;
      console.log("connected to the gateway");
    } else if (payload.op === 0 && payload.t === "INTERACTION_CREATE") {
      const interaction = payload.d as Interaction;
      const response = respond(interaction);
      if (response) void answer(base, interaction, response);
    }
  });
  socket.addEventListener("close", event => {
    clearInterval(heartbeat);
    if (event.code === 4004) {
      console.error("the bot token was rejected (reset?)");
      return;
    }
    const delay = Math.min(60_000, 1000 * 2 ** attempt);
    setTimeout(() => connect(base, token, attempt + 1), delay);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.VOKKO_BOT_TOKEN;
  if (!token) {
    console.error("set VOKKO_BOT_TOKEN (Settings > Developer > New Application shows it once)");
    process.exit(1);
  }
  run(process.env.VOKKO_API ?? "http://127.0.0.1:8710", token, process.env.VOKKO_GUILD_ID).catch(error => {
    console.error(error);
    process.exit(1);
  });
}
