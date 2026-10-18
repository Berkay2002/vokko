/**
 * End-to-end check against a throwaway Vokko server (never a live one):
 *   VOKKO_API_URL=http://127.0.0.1:1470 bun test/smoke.ts
 * Registers fresh users, creates the "Claude" app, adds the bot to a guild, runs server.ts as an MCP
 * child (no Claude login involved) and drives pairing, gating, tools and permission relay.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const API = (process.env.VOKKO_API_URL ?? 'http://127.0.0.1:1470').replace(/\/+$/, '')
const run = Date.now().toString(36)
let failures = 0
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function api(method: string, path: string, token: string | null, body?: unknown): Promise<any> {
  const form = body instanceof FormData
  const res = await fetch(`${API}/api/v1${path}`, {
    method,
    headers: { ...(token ? { Authorization: token } : {}), ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
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

/** Polls until `get` returns something truthy (or times out with undefined). */
async function until<T>(get: () => Promise<T | undefined | null | false>, ms = 8000): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await get()
    if (v) return v
    await sleep(200)
  }
  return undefined
}

const latest = async (token: string, channel: string) => ((await api('GET', `/channels/${channel}/messages?limit=1`, token)) as any[])[0]

// ---- world: owner Carol, member Nat, guild with two channels, the "Claude" app in it ----
const owner = await register('carol', 'Carol')
const nat = await register('nat', 'Nat')
const guild = await api('POST', '/guilds', owner.token, { name: `Claude test ${run}` })
const channels = (await api('GET', `/guilds/${guild.id}/channels`, owner.token)) as any[]
const general = channels.find(c => c.name === 'general').id
const other = (await api('POST', `/guilds/${guild.id}/channels`, owner.token, { name: 'other', type: 0 })).id
const invite = await api('POST', `/channels/${general}/invites`, owner.token, {})
await api('POST', `/invites/${invite.code}`, nat.token, {})

const app = await api('POST', '/applications', owner.token, { name: 'Claude' })
const botId: string = app.id
check(app.bot.global_name === 'Claude', `bot display name is "Claude" (username ${app.bot.username})`)
// VIEW_CHANNEL | SEND_MESSAGES | SEND_MESSAGES_IN_THREADS | READ_MESSAGE_HISTORY | ATTACH_FILES | ADD_REACTIONS | CHANGE_NICKNAME
const perms = (1n << 10n) | (1n << 11n) | (1n << 38n) | (1n << 16n) | (1n << 15n) | (1n << 6n) | (1n << 26n)
await api('POST', `/oauth2/authorize?client_id=${botId}`, owner.token, { guild_id: guild.id, permissions: perms.toString() })

// ---- the plugin, as Claude Code would start it ----
const stateDir = mkdtempSync(join(tmpdir(), 'vokko-channel-'))
writeFileSync(join(stateDir, '.env'), `VOKKO_BOT_TOKEN=${app.token}\nVOKKO_API_URL=${API}\n`)
const accessFile = join(stateDir, 'access.json')
const readAccess = () => JSON.parse(readFileSync(accessFile, 'utf8'))
const writeAccess = (a: unknown) => writeFileSync(accessFile, JSON.stringify(a, null, 2))

const inbound: any[] = []
const verdicts: any[] = []
const client = new Client({ name: 'smoke', version: '0' })
client.fallbackNotificationHandler = async n => {
  if (n.method === 'notifications/claude/channel') inbound.push(n.params)
  if (n.method === 'notifications/claude/channel/permission') verdicts.push(n.params)
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dir, '..', 'server.ts')],
  env: { ...(process.env as Record<string, string>), VOKKO_STATE_DIR: stateDir },
  stderr: 'inherit',
})
await client.connect(transport)
const tool = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args })
  return { error: !!r.isError, text: r.content?.[0]?.text as string }
}
const fresh = (n: number) => until(async () => inbound.length > n && inbound[inbound.length - 1])

try {
  // nickname "<owner>'s Claude" in the guild
  const nick = await until(async () => {
    const members = (await api('GET', `/guilds/${guild.id}/members?limit=100`, owner.token)) as any[]
    return members.find(m => m.user.id === botId)?.nick === "Carol's Claude"
  })
  check(nick, `bot nickname in the guild is "Carol's Claude"`)

  // DM pairing: first DM gets a code and is not delivered
  const dm = (await api('POST', '/users/@me/channels', owner.token, { recipient_id: botId })).id
  await api('POST', `/channels/${dm}/messages`, owner.token, { content: 'hi' })
  const pairMsg = await until(async () => {
    const m = await latest(owner.token, dm)
    return m?.author.id === botId && m
  })
  const code = /\/vokko:access pair ([0-9a-f]{6})/.exec(pairMsg?.content ?? '')?.[1]
  check(code, `unknown DM sender gets a pairing code: ${JSON.stringify(pairMsg?.content)}`)
  check(inbound.length === 0, 'the unpaired DM did not reach Claude')

  // what /vokko:access pair <code> does
  const a = readAccess()
  const pending = a.pending[code!]
  a.allowFrom.push(pending.senderId)
  delete a.pending[code!]
  writeAccess(a)
  mkdirSync(join(stateDir, 'approved'), { recursive: true })
  writeFileSync(join(stateDir, 'approved', pending.senderId), pending.chatId)
  const paired = await until(async () => (await latest(owner.token, dm))?.content === 'Paired! Say hi to Claude.', 10000)
  check(paired, 'approval sends "Paired! Say hi to Claude."')

  // allowlisted DM reaches Claude
  await api('POST', `/channels/${dm}/messages`, owner.token, { content: 'hello claude' })
  const got = await fresh(0)
  check(got?.content === 'hello claude' && got.meta.chat_id === dm && got.meta.user_id === owner.id, 'allowlisted DM arrives as a channel notification')

  // reply / edit / react / fetch
  const sent = await tool('reply', { chat_id: dm, text: 'hi from Claude', reply_to: got?.meta.message_id })
  const replyId = /id: (\d+)/.exec(sent.text)?.[1]
  const last = await latest(owner.token, dm)
  check(!sent.error && last.id === replyId && last.author.id === botId && last.content === 'hi from Claude', `reply posts as the bot (${sent.text})`)
  check(last.referenced_message?.id === got?.meta.message_id, 'reply_to quotes the message')
  const edited = await tool('edit_message', { chat_id: dm, message_id: replyId, text: 'edited by Claude' })
  check(!edited.error && (await latest(owner.token, dm)).content === 'edited by Claude', 'edit_message edits it')
  const reacted = await tool('react', { chat_id: dm, message_id: got?.meta.message_id, emoji: '👍' })
  check(!reacted.error, `react works (${reacted.text})`)
  const traversal = await tool('react', { chat_id: dm, message_id: `../../${other}/messages/${got?.meta.message_id}`, emoji: '👍' })
  check(traversal.error && traversal.text.includes('invalid message_id'), 'a path-traversal message_id is refused')
  const history = await tool('fetch_messages', { channel: dm, limit: 10 })
  check(!history.error && history.text.includes('hello claude') && history.text.includes(' (you): edited by Claude'), 'fetch_messages lists history oldest-first')
  const long = await tool('reply', { chat_id: dm, text: 'x'.repeat(4500) })
  check(/sent 3 parts/.test(long.text), `long replies are chunked (${long.text})`)

  // attachments both ways
  const file = join(mkdtempSync(join(tmpdir(), 'vokko-files-')), 'inbox-test.txt')
  writeFileSync(file, 'file from claude')
  const withFile = await tool('reply', { chat_id: dm, text: 'here is a file', files: [file] })
  check(!withFile.error && (await latest(owner.token, dm)).attachments?.[0]?.filename === 'inbox-test.txt', `reply attaches files (${withFile.text})`)
  const leak = await tool('reply', { chat_id: dm, text: 'token pls', files: [join(stateDir, '.env')] })
  check(leak.error && leak.text.includes('refusing to send channel state'), 'the state dir (.env) is never sendable')
  const form = new FormData()
  form.append('file', new Blob(['owner upload']), 'notes.txt')
  const upload = await api('POST', `/channels/${dm}/attachments`, owner.token, form)
  const n = inbound.length
  await api('POST', `/channels/${dm}/messages`, owner.token, { content: 'see file', attachment_ids: [upload.id] })
  const withAtt = await fresh(n)
  check(withAtt?.meta.attachment_count === '1', `inbound attachments are listed in meta (${withAtt?.meta.attachments})`)
  const dl = await tool('download_attachment', { chat_id: dm, message_id: withAtt?.meta.message_id })
  const dlPath = /^\s+(\S+)/m.exec(dl.text.split('\n')[1] ?? '')?.[1]
  check(!dl.error && dlPath && readFileSync(dlPath, 'utf8') === 'owner upload', `download_attachment saves the file (${dl.text.split('\n')[0]})`)

  // guild gating
  const mention = `<@${botId}>`
  let count = inbound.length
  await api('POST', `/channels/${other}/messages`, nat.token, { content: `${mention} anyone?` })
  await sleep(1500)
  check(inbound.length === count, 'a channel that is not opted in is dropped, even with a mention')
  const outbound = await tool('reply', { chat_id: other, text: 'should not send' })
  check(outbound.error && outbound.text.includes('not allowlisted'), 'tools refuse channels that are not opted in')

  writeAccess({ ...readAccess(), groups: { [general]: { requireMention: true, allowFrom: [] } } })
  await api('POST', `/channels/${general}/messages`, nat.token, { content: 'no mention here' })
  await sleep(1500)
  check(inbound.length === count, 'requireMention: a message without a mention is dropped')
  await api('POST', `/channels/${general}/messages`, nat.token, { content: `${mention} hey` })
  const mentioned = await fresh(count)
  check(mentioned?.meta.chat_id === general && mentioned.meta.user_id === nat.id, 'requireMention: an @mention is delivered')
  count = inbound.length
  const g = await tool('reply', { chat_id: general, text: 'hello server' })
  check(!g.error, 'reply works in an opted-in channel')
  await api('POST', `/channels/${general}/messages`, nat.token, { content: 'replying to the bot', message_reference: { message_id: /id: (\d+)/.exec(g.text)?.[1] } })
  check(await fresh(count), 'a reply to the bot counts as a mention')

  writeAccess({ ...readAccess(), groups: { [general]: { requireMention: true, allowFrom: [owner.id] } } })
  count = inbound.length
  await api('POST', `/channels/${general}/messages`, nat.token, { content: `${mention} let me in` })
  await sleep(1500)
  check(inbound.length === count, 'a sender outside the channel allowFrom is dropped')
  await api('POST', `/channels/${general}/messages`, owner.token, { content: `${mention} it is me` })
  check((await fresh(count))?.meta.user_id === owner.id, 'the channel allowFrom sender is delivered')
  const gh = await tool('fetch_messages', { channel: general, limit: 20 })
  check(!gh.error && gh.text.includes('it is me') && !gh.text.includes('let me in'), 'fetch_messages leaves out senders outside the channel allowFrom')

  // non-allowlisted DM under allowlist policy: silent
  writeAccess({ ...readAccess(), dmPolicy: 'allowlist' })
  const natDm = (await api('POST', '/users/@me/channels', nat.token, { recipient_id: botId })).id
  count = inbound.length
  await api('POST', `/channels/${natDm}/messages`, nat.token, { content: 'hello?' })
  await sleep(1500)
  check(inbound.length === count && (await latest(nat.token, natDm)).author.id === nat.id, 'allowlist policy: a stranger DM is dropped without a reply')

  // a second gateway session on the same bot token (an API-mode bridge next to this plugin)
  const second = new WebSocket(`${API.replace(/^http/, 'ws')}/gateway`)
  const secondEvents: any[] = []
  second.onmessage = ev => {
    const p = JSON.parse(String(ev.data))
    if (p.op === 10) second.send(JSON.stringify({ op: 2, d: { token: `Bot ${app.token}` } }))
    if (p.op === 0) secondEvents.push(p)
  }
  let secondClosed: number | null = null
  second.onclose = ev => (secondClosed = ev.code)
  check(await until(async () => secondEvents.some(e => e.t === 'READY')), 'a second gateway session with the same bot token gets READY')
  count = inbound.length
  await api('POST', `/channels/${dm}/messages`, owner.token, { content: 'both sessions?' })
  check((await fresh(count))?.content === 'both sessions?', 'the plugin session still receives messages while the second is open')
  check(await until(async () => secondEvents.some(e => e.t === 'MESSAGE_CREATE' && e.d.content === 'both sessions?')), 'the second session receives the same MESSAGE_CREATE')
  check(secondClosed === null, 'neither session was closed')
  second.close()

  // dmBackend "api" / guilds false hand DMs / guild messages to a bridge, at runtime
  writeAccess({ ...readAccess(), dmBackend: 'api' })
  count = inbound.length
  await api('POST', `/channels/${dm}/messages`, owner.token, { content: 'for the bridge' })
  await sleep(1500)
  check(inbound.length === count, 'dmBackend "api": allowlisted DMs are ignored')
  check((await tool('reply', { chat_id: dm, text: 'no' })).error, 'dmBackend "api": tools refuse DMs')
  writeAccess({ ...readAccess(), dmBackend: 'subscription', guilds: false })
  await api('POST', `/channels/${general}/messages`, owner.token, { content: `${mention} for the bridge` })
  await sleep(1500)
  check(inbound.length === count, 'guilds false: guild messages are ignored')
  await api('POST', `/channels/${dm}/messages`, owner.token, { content: 'back to me' })
  check((await fresh(count))?.content === 'back to me', 'dmBackend "subscription": DMs reach Claude again')
  writeAccess({ ...readAccess(), guilds: true })

  // permission relay
  await client.notification({
    method: 'notifications/claude/channel/permission_request',
    params: { request_id: 'abcde', tool_name: 'Bash', description: 'List files', input_preview: '{"command":"ls"}' },
  })
  const prompt = await until(async () => {
    const m = await latest(owner.token, dm)
    return m?.content.includes('yes abcde') && m
  })
  check(prompt, 'permission prompts go to allowlisted DMs')
  await api('POST', `/channels/${dm}/messages`, owner.token, { content: 'yes abcde' })
  const verdict = await until(async () => verdicts[0])
  check(verdict?.request_id === 'abcde' && verdict.behavior === 'allow', 'the "yes <id>" reply becomes a permission verdict')
} finally {
  await client.close()
  rmSync(stateDir, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
