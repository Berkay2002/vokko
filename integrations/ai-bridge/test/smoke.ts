/**
 * End-to-end check against a throwaway Vokko server (never a live one):
 *   VOKKO_API_URL=http://127.0.0.1:1470 bun test/smoke.ts
 * The channel plugin (as an MCP child, like Claude Code starts it) and a shared bridge on the same bot
 * token, with a stubbed backend (no API key, no Codex login): DM pairing through the bridge, dmBackend
 * toggling, guild mentions to the bridge, the session kept across messages and a restart, the rate
 * limit and the monthly budget.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { VokkoBot, loadConfig } from '../../claude-channel/vokko.ts'
import { Bridge, type Backend, type Limits } from '../core.ts'

const pluginDir = join(import.meta.dir, '..', '..', 'claude-channel')
const { Client } = await import(Bun.resolveSync('@modelcontextprotocol/sdk/client/index.js', pluginDir))
const { StdioClientTransport } = await import(Bun.resolveSync('@modelcontextprotocol/sdk/client/stdio.js', pluginDir))

const API = (process.env.VOKKO_API_URL ?? 'http://127.0.0.1:1470').replace(/\/+$/, '')
const run = Date.now().toString(36)
let failures = 0
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function api(method: string, path: string, token: string | null, body?: unknown): Promise<any> {
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { ...(token ? { Authorization: token } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : undefined
}

async function register(name: string, display: string): Promise<{ token: string; id: string }> {
  const r = await api('POST', '/auth/register', null, {
    email: `${name}${run}@example.test`,
    username: `${name}${run}`,
    password: 'correct horse battery',
    date_of_birth: '1990-01-01',
  })
  await api('PATCH', '/users/@me', r.token, { global_name: display })
  return { token: r.token, id: r.user.id }
}

async function until<T>(get: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await get()
    if (v) return v
    await sleep(200)
  }
  return undefined
}

const recentMsgs = async (token: string, channel: string, n = 5) => (await api('GET', `/channels/${channel}/messages?limit=${n}`, token)) as any[]

// ---- world: owner Carol, member Nat, a guild with the "Claude" app in it ----
const owner = await register('carol', 'Carol')
const nat = await register('nat', 'Nat')
const guild = await api('POST', '/guilds', owner.token, { name: `Bridge test ${run}` })
const general = ((await api('GET', `/guilds/${guild.id}/channels`, owner.token)) as any[]).find(c => c.name === 'general').id
const invite = await api('POST', `/channels/${general}/invites`, owner.token, {})
await api('POST', `/invites/${invite.code}`, nat.token, {})
const app = await api('POST', '/applications', owner.token, { name: 'Claude' })
const botId: string = app.id
const perms = (1n << 10n) | (1n << 11n) | (1n << 38n) | (1n << 16n) | (1n << 15n) | (1n << 6n) | (1n << 26n)
await api('POST', `/oauth2/authorize?client_id=${botId}`, owner.token, { guild_id: guild.id, permissions: perms.toString() })

const stateDir = mkdtempSync(join(tmpdir(), 'vokko-bridge-'))
writeFileSync(join(stateDir, '.env'), `VOKKO_BOT_TOKEN=${app.token}\nVOKKO_API_URL=${API}\n`)
const accessFile = join(stateDir, 'access.json')
const readAccess = () => JSON.parse(readFileSync(accessFile, 'utf8'))
const writeAccess = (a: unknown) => writeFileSync(accessFile, JSON.stringify(a, null, 2))
writeAccess({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {}, dmBackend: 'api', guilds: false })

// ---- the plugin ----
const inbound: any[] = []
const client = new Client({ name: 'smoke', version: '0' })
client.fallbackNotificationHandler = async (n: any) => {
  if (n.method === 'notifications/claude/channel') inbound.push(n.params)
}
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(pluginDir, 'server.ts')],
    env: { ...(process.env as Record<string, string>), VOKKO_STATE_DIR: stateDir },
    stderr: 'inherit',
  }),
)

// ---- the bridge, with a stubbed metered backend ----
const asks: { sid?: string; prompt: string }[] = []
let sessions = 0
const backend: Backend = {
  name: 'claude-api',
  metered: true,
  async ask(sid, prompt) {
    asks.push({ sid, prompt })
    return { text: `echo ${asks.length}`, sessionId: sid ?? `sess-${++sessions}`, costUsd: 0.01 }
  },
}
async function startBridge(limits: Limits): Promise<VokkoBot> {
  const cfg = loadConfig(stateDir, '/vokko:access pair', line => void process.stderr.write(line), 'bridge-shared')
  let bridge: Bridge | null = null
  const bot = new VokkoBot(cfg, msg => void bridge?.handle(msg).catch(e => console.error(e)))
  bridge = new Bridge(bot, backend, limits)
  bridge.startHeartbeat() // without it the plugin would take guilds over
  bot.start(false)
  await until(async () => bot.ownerId)
  return bot
}

const botSays = (token: string, channel: string, test: (content: string) => boolean) =>
  until(async () => (await recentMsgs(token, channel)).find(m => m.author.id === botId && test(m.content)))
/** Nat posts in #general and waits for the backend's answer; returns [Nat's message, the bot's reply]. */
async function natAsks(content: string): Promise<[any, any]> {
  const want = `echo ${asks.length + 1}`
  const sent = await api('POST', `/channels/${general}/messages`, nat.token, { content })
  return [sent, await botSays(nat.token, general, c => c === want)]
}

let bot = await startBridge({ perHour: 100, monthlyUsd: 100 })
try {
  check(bot.ownerId === owner.id, 'the bridge reads the application owner at READY')
  const nick = await until(async () => {
    const members = (await api('GET', `/guilds/${guild.id}/members?limit=100`, owner.token)) as any[]
    return members.find(m => m.user.id === botId)?.nick === "Carol's Claude"
  })
  check(nick, `bot nickname in the guild is "Carol's Claude"`)

  // DM pairing through the bridge (dmBackend "api")
  const dm = (await api('POST', '/users/@me/channels', owner.token, { recipient_id: botId })).id
  await api('POST', `/channels/${dm}/messages`, owner.token, { content: 'hi' })
  const pairMsg = await botSays(owner.token, dm, c => c.includes('!pair'))
  const code = /!pair ([0-9a-f]{6})/.exec(pairMsg?.content ?? '')?.[1]
  check(code, `the bridge answers an unpaired DM with a code: ${JSON.stringify(pairMsg?.content)}`)
  await api('POST', `/channels/${dm}/messages`, owner.token, { content: `!pair ${code}` })
  check(await botSays(owner.token, dm, c => c === 'Paired! Say hi to Claude.'), '`!pair <code>` from the owner pairs ("Paired! Say hi to Claude.")')
  check(readAccess().allowFrom.includes(owner.id), 'the owner is allowlisted')

  await api('POST', `/channels/${dm}/messages`, owner.token, { content: 'hello bridge' })
  check(await botSays(owner.token, dm, c => c === 'echo 1'), 'an allowlisted DM is answered by the bridge backend')
  check(asks[0]?.prompt.includes('owner="true"') && asks[0].prompt.includes('hello bridge'), 'the prompt marks the owner')
  check(inbound.length === 0, 'the plugin stayed silent (dmBackend "api")')

  // dmBackend toggle from the owner's DM
  await api('POST', `/channels/${dm}/messages`, owner.token, { content: '!backend subscription' })
  check(await botSays(owner.token, dm, c => c.startsWith('DMs now go to your Claude Code session')), '`!backend subscription` confirms')
  check(readAccess().dmBackend === 'subscription', 'access.json dmBackend is "subscription"')
  await api('POST', `/channels/${dm}/messages`, owner.token, { content: 'to the plugin' })
  check(await until(async () => inbound.find(n => n.content === 'to the plugin')), 'DMs reach the plugin now')
  await sleep(1000)
  check(asks.length === 1, 'and not the bridge')
  check(!inbound.some(n => /^!backend/.test(n.content)), "the owner's !backend never reached the plugin's Claude")
  await api('POST', `/channels/${dm}/messages`, owner.token, { content: '!backend api' })
  check(await botSays(owner.token, dm, c => c === 'DMs now go to the API bridge.'), '`!backend api` switches back')

  // guild mention → the bridge; session kept across messages
  writeAccess({ ...readAccess(), groups: { [general]: { requireMention: true, allowFrom: [] } } })
  const pluginBefore = inbound.length
  const mention = `<@${botId}>`
  const [one, r1] = await natAsks(`${mention} one`)
  check(r1 && r1.referenced_message?.id === one.id, 'a guild mention is answered by the bridge, quoting the message')
  check(asks.at(-1)?.prompt.includes('untrusted="true"'), "a non-allowlisted member's message is marked untrusted")
  const guildSession = asks.at(-1)?.sid === undefined ? `sess-${sessions}` : asks.at(-1)?.sid
  await natAsks(`${mention} two`)
  check(asks.at(-1)?.sid === guildSession, `the second message resumes the channel session (${guildSession})`)
  await api('POST', `/channels/${general}/messages`, nat.token, { content: 'no mention' })
  await sleep(1500)
  check(asks.at(-1)?.prompt.includes('two'), 'requireMention: a message without a mention is dropped')
  check(inbound.length === pluginBefore, 'the plugin stayed silent (guilds false)')

  // restart: the session survives; rate limit 3/hour
  bot.stop()
  await sleep(1500)
  bot = await startBridge({ perHour: 3, monthlyUsd: 100 })
  await natAsks(`${mention} three`)
  check(asks.at(-1)?.prompt.includes('three') && asks.at(-1)?.sid === guildSession, 'after a restart the channel session is resumed')
  for (const w of ['four', 'five']) check((await natAsks(`${mention} ${w}`))[1], `message "${w}" is answered`)
  const before = asks.length
  await api('POST', `/channels/${general}/messages`, nat.token, { content: `${mention} six` })
  check(await botSays(nat.token, general, c => c.startsWith("You've reached the limit of 3 messages an hour")), 'the 4th message in an hour gets the rate-limit reply')
  check(asks.length === before, 'and never reaches the backend')

  // monthly budget
  bot.stop()
  await sleep(1500)
  const spent = JSON.parse(readFileSync(join(stateDir, 'usage-claude-api.json'), 'utf8'))
  check(Math.abs(spent.costUsd - asks.length * 0.01) < 1e-9, `the monthly cost tally is persisted ($${spent.costUsd})`)
  bot = await startBridge({ perHour: 100, monthlyUsd: spent.costUsd })
  const toPlugin = inbound.length
  await api('POST', `/channels/${general}/messages`, nat.token, { content: `${mention} seven` })
  check(await until(async () => inbound.length === toPlugin + 1), 'over the monthly budget the message goes to the plugin (the subscription)')
  check(asks.length === before, 'and never reaches the backend')
} finally {
  bot.stop()
  await client.close()
  rmSync(stateDir, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
