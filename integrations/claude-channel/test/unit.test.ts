// Unit checks for the security review fixes: bun test
import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, statSync, mkdirSync, chmodSync, rmSync, symlinkSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { VokkoBot, bridgeState, checkPath, type Config, type Message } from '../vokko.ts'

const ME = '100', OWNER = '200', FRIEND = '300', STRANGER = '400', GROUP = '500', DM = '600'
let calls: { url: string; init?: RequestInit }[]
let respond: (url: string) => Response

beforeEach(() => {
  calls = []
  respond = () => Response.json([])
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return respond(String(url))
  }) as typeof fetch
})

function makeBot(access: object = {}): { bot: VokkoBot; logs: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vokko-unit-'))
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: [OWNER], groups: { [GROUP]: { requireMention: false, allowFrom: [FRIEND] } }, pending: {}, ...access }))
  const logs: string[] = []
  const cfg: Config = { stateDir: dir, token: 'SECRET', apiUrl: 'http://vokko.test', gatewayUrl: 'ws://vokko.test/gateway', botName: 'Claude', pairCommand: '/vokko:access pair', role: 'channel', staticMode: false, log: l => void logs.push(l) }
  const bot = new VokkoBot(cfg, () => {})
  bot.me = { id: ME, username: 'claude', global_name: 'Claude', bot: true }
  const cache = (ch: object) => (bot as any).cacheChannel(ch)
  cache({ id: GROUP, type: 0, guild_id: '1' })
  cache({ id: DM, type: 1, recipients: [bot.me, { id: OWNER, username: 'owner', global_name: null }] })
  return { bot, logs, dir }
}

const msg = (id: string, author: string, extra: Partial<Message> = {}): Message => ({
  id, channel_id: GROUP, guild_id: '1', author: { id: author, username: author === ME ? 'claude' : `u${author}`, global_name: null },
  content: 'hi', timestamp: '', mentions: [], attachments: [], referenced_message: null, ...extra,
})

const TRAVERSALS = ['../../700/messages/pins/1?', '..%2f..%2f700', '%2e%2e', '1/../2', '@me', '1?x=1', '']

test('checkPath accepts the routes the bot uses', () => {
  for (const p of ['/channels/1/messages', '/channels/1/messages?around=2&limit=1', '/channels/1/messages/2/reactions/%E2%9C%85/@me', '/channels/1/messages/2/reactions/name%3A3/@me', '/users/@me/channels', '/applications/@me', '/users/5', '/guilds/1/members/@me', '/channels/1/typing', '/channels/1/attachments'])
    expect(() => checkPath(p)).not.toThrow()
  for (const p of ['/channels/1/messages/../../7/pins/2', '/channels/1/messages/%2e%2e/x', '/channels/1/messages/2/reactions/../@me', '/channels/1/messages/2/reactions/%2E%2E/@me', '/channels/1/messages?around=1/../x', 'channels/1'])
    expect(() => checkPath(p)).toThrow()
})

test('react, edit and download_attachment refuse non-snowflake message ids before any request', async () => {
  const { bot } = makeBot()
  for (const id of TRAVERSALS) {
    await expect(bot.react(GROUP, id, '👍')).rejects.toThrow(/invalid message_id/)
    await expect(bot.edit(GROUP, id, 'x')).rejects.toThrow(/invalid message_id/)
    await expect(bot.message(GROUP, id)).rejects.toThrow(/invalid message_id/)
    await expect(bot.history(id, 5)).rejects.toThrow(/invalid chat_id/)
  }
  await expect(bot.react(GROUP, '1', '..')).rejects.toThrow(/unsafe API path/)
  expect(calls).toEqual([])
  await bot.react(GROUP, '1', '<:party:42>')
  expect(calls[0]!.url).toBe('http://vokko.test/api/v1/channels/500/messages/1/reactions/party%3A42/@me')
})

test('download never sends the token and caps the bytes read, whatever att.size says', async () => {
  const { bot, dir } = makeBot()
  bot.maxUploadBytes = 10
  respond = () => new Response('12345')
  const path = await bot.download({ id: '9', filename: 'a.txt', content_type: null, size: 5, url: 'http://vokko.test/attachments/9/a.txt' })
  expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBeNull()
  if (process.platform !== 'win32') {
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'inbox')).mode & 0o777).toBe(0o700)
  }
  respond = () => new Response('x'.repeat(11))
  await expect(bot.download({ id: '10', filename: 'b', content_type: null, size: 1, url: 'http://vokko.test/x' })).rejects.toThrow(/exceeds/)
})

test('history and message leave out senders outside the channel allowFrom', async () => {
  const { bot } = makeBot()
  respond = () => Response.json([msg('3', STRANGER), msg('2', FRIEND), msg('1', ME)])
  expect((await bot.history(GROUP, 10)).map(m => m.id)).toEqual(['1', '2'])
  respond = () => Response.json([msg('3', STRANGER)])
  await expect(bot.message(GROUP, '3')).rejects.toThrow(/not allowlisted/)
  respond = () => Response.json([msg('2', FRIEND)])
  expect((await bot.message(GROUP, '2')).id).toBe('2')
})

test('full pairing slots are logged and DMed to the owner once, one pending code per sender', async () => {
  const later = Date.now() + 3600_000
  const pending = Object.fromEntries(['a', 'b', 'c'].map((c, i) => [c, { senderId: `90${i}`, chatId: `80${i}`, createdAt: 0, expiresAt: later, replies: 1 }]))
  const { bot, logs } = makeBot({ pending })
  respond = url =>
    url.endsWith('/applications/@me') ? Response.json({ owner_id: OWNER })
    : url.endsWith(`/users/${OWNER}`) ? Response.json({ id: OWNER, username: 'owner', global_name: null })
    : Response.json({ id: '1' })
  const dm = (author: string) => msg('1', author, { guild_id: null, channel_id: '700' })
  expect(await bot.gate(dm(STRANGER))).toEqual({ action: 'drop' })
  expect(await bot.gate(dm('401'))).toEqual({ action: 'drop' })
  await new Promise(r => setTimeout(r, 10))
  expect(logs.filter(l => l.includes('Pairing is full')).length).toBe(1)
  const sent = calls.filter(c => c.url.endsWith(`/channels/${DM}/messages`))
  expect(sent.length).toBe(1)
  expect(String(sent[0]!.init?.body)).toContain('deny <code>')
  // a sender that already holds a code gets it again instead of a second one
  expect(await bot.gate(dm('900'))).toEqual({ action: 'pair', code: 'a', isResend: true })
})

test.skipIf(process.platform !== 'linux')('assertSendable refuses /proc, /dev and /sys', () => {
  const { bot } = makeBot()
  for (const f of ['/proc/self/environ', '/dev/stdin', '/sys/kernel/hostname']) expect(() => bot.assertSendable(f)).toThrow(/pseudo-file/)
  expect(() => bot.assertSendable('/etc/hostname')).not.toThrow()
})

test('assertSendable refuses channel state but allows the inbox', () => {
  const { bot, dir } = makeBot()
  expect(() => bot.assertSendable(join(dir, 'access.json'))).toThrow(/channel state/)
  mkdirSync(join(dir, 'inbox'))
  writeFileSync(join(dir, 'inbox', 'x.txt'), 'x')
  expect(() => bot.assertSendable(join(dir, 'inbox', 'x.txt'))).not.toThrow()
})

test.skipIf(process.platform === 'win32')('assertSendable folds the given path on case-insensitive systems (/DEV/stdin)', () => {
  const { bot } = makeBot()
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  try {
    expect(() => bot.assertSendable('/DEV/stdin')).toThrow(/pseudo-file/)
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

test.skipIf(process.platform === 'win32')('download tightens an inbox that already exists, and its old files', async () => {
  const { bot, dir } = makeBot()
  mkdirSync(join(dir, 'inbox'), { mode: 0o755 })
  chmodSync(join(dir, 'inbox'), 0o755)
  writeFileSync(join(dir, 'inbox', 'old.txt'), 'x', { mode: 0o644 })
  respond = () => new Response('new')
  await bot.download({ id: '9', filename: 'a.txt', content_type: null, size: 3, url: 'http://vokko.test/a' })
  expect(statSync(join(dir, 'inbox')).mode & 0o777).toBe(0o700)
  expect(statSync(join(dir, 'inbox', 'old.txt')).mode & 0o777).toBe(0o600)
})

test.skipIf(process.platform === 'win32')('reply reads every file before the first upload: a symlink swapped in later is not sent', async () => {
  const { bot, dir } = makeBot()
  const files = mkdtempSync(join(tmpdir(), 'vokko-files-'))
  const [a, b] = [join(files, 'a.txt'), join(files, 'b.txt')]
  writeFileSync(a, 'first')
  writeFileSync(b, 'second')
  const uploads: string[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/attachments')) {
      uploads.push(await ((init!.body as FormData).get('file') as Blob).text())
      rmSync(b)
      if (uploads.length === 1) symlinkSync(join(dir, 'access.json'), b)
      return Response.json({ id: String(uploads.length) })
    }
    return Response.json({ id: '99' })
  }) as typeof fetch
  await bot.reply(GROUP, 'files', undefined, [a, b])
  expect(uploads).toEqual(['first', 'second'])
})

// ---- fallback: the API bridge is out, this session answers its guild messages ----

const EPOCH = 1420070400000
/** A snowflake minted `ageMs` ago. */
const snow = (n: number, ageMs = 0) => String((BigInt(Date.now() - ageMs - EPOCH) << 22n) | BigInt(n))
const beat = (dir: string, at = Date.now(), pid: number = process.pid) => writeFileSync(join(dir, 'bridge-state.json'), JSON.stringify({ at, pid }))
const handoff = (dir: string, id: string, channel = GROUP) => {
  mkdirSync(join(dir, 'handoff'), { recursive: true })
  writeFileSync(join(dir, 'handoff', id), JSON.stringify({ channel_id: channel }))
}
const verdicts = (dir: string) => readdirSync(join(dir, 'handoff')).filter(n => /\.(accepted|declined)$/.test(n)).sort()
const settle = () => new Promise(r => setTimeout(r, 30))

test('bridgeState: none without a file, alive for 90 s with a live pid, down when stale, stopped, dead or unreadable', () => {
  const { dir } = makeBot()
  expect(bridgeState(dir)).toBe('none')
  beat(dir, 1_000_000)
  expect(bridgeState(dir, 1_000_000 + 89_000)).toBe('alive')
  expect(bridgeState(dir, 1_000_000 + 91_000)).toBe('down')
  beat(dir, Date.now(), 99_999_999)
  expect(bridgeState(dir)).toBe('down')
  writeFileSync(join(dir, 'bridge-state.json'), JSON.stringify({ stoppedAt: Date.now() }))
  expect(bridgeState(dir)).toBe('down')
  writeFileSync(join(dir, 'bridge-state.json'), 'nope')
  expect(bridgeState(dir)).toBe('down')
})

test('a handed-off message is answered here once, through the normal gate, and replies to its channel are allowed', async () => {
  const { bot, dir } = makeBot({ guilds: false })
  const got: Message[] = []
  ;(bot as any).onMessage = (m: Message) => void got.push(m)
  beat(dir)
  const id = snow(5)
  const m = msg(id, FRIEND)
  expect(await bot.admit(m)).toBeNull() // the bridge owns guilds while it is alive
  await expect(bot.reply(GROUP, 'x')).rejects.toThrow(/not allowlisted/)

  handoff(dir, id)
  respond = url => (url.includes(`around=${id}`) ? Response.json([m]) : Response.json({}))
  ;(bot as any).checkHandoffs()
  await settle()
  expect(got.map(x => x.id)).toEqual([id])
  expect(existsSync(join(dir, 'handoff', id))).toBe(false)
  expect(await bot.admit(got[0]!)).not.toBeNull()
  expect(verdicts(dir)).toEqual([`${id}.accepted`])
  expect(await bot.admit(got[0]!)).toBeNull() // one-shot: not answered twice
  ;(bot as any).checkHandoffs()
  await settle()
  expect(got.length).toBe(1)

  beat(dir) // the bridge is back: replies to a channel taken over still go out
  respond = () => Response.json({ id: '9' })
  await bot.reply(GROUP, 'answer')
  expect(calls.some(c => c.url.endsWith(`/channels/${GROUP}/messages`) && c.init?.method === 'POST')).toBe(true)
})

test('the gate still applies to a handed-off message, and the bridge is told when it is refused, too old or unfetchable', async () => {
  const { bot, dir } = makeBot({ guilds: false })
  const got: Message[] = []
  ;(bot as any).onMessage = (m: Message) => void got.push(m)
  beat(dir)
  const [stranger, optout, bot_, old, broken] = [snow(6), snow(7), snow(8), snow(9, 61_000), snow(10)]
  handoff(dir, stranger) // a sender outside the channel's allowFrom
  handoff(dir, optout, '999') // a channel that never opted in
  handoff(dir, bot_) // a bot's message
  handoff(dir, old) // older than 60 s
  handoff(dir, broken) // the fetch fails
  writeFileSync(join(dir, 'handoff', 'notes.txt'), 'x')
  respond = url =>
    url.includes(`around=${stranger}`) ? Response.json([msg(stranger, STRANGER)])
    : url.includes(`around=${optout}`) ? Response.json([msg(optout, FRIEND, { channel_id: '999' })])
    : url.includes(`around=${bot_}`) ? Response.json([msg(bot_, FRIEND, { author: { id: '77', username: 'b', global_name: null, bot: true } })])
    : new Response('boom', { status: 500 })
  ;(bot as any).checkHandoffs()
  await settle()
  expect(existsSync(join(dir, 'handoff', 'notes.txt'))).toBe(true)
  expect(calls.some(c => c.url.includes(`around=${old}`))).toBe(false) // too old: never fetched
  expect(got.map(x => x.id).sort()).toEqual([optout, stranger].sort())
  for (const m of got) expect(await bot.admit(m)).toBeNull()
  expect(verdicts(dir)).toEqual([`${stranger}.declined`, `${optout}.declined`, `${bot_}.declined`, `${old}.declined`, `${broken}.declined`].sort())
})

test('in a server channel held only as the bridge\'s fallback, reply attaches files from the inbox only', async () => {
  const { bot, dir } = makeBot({ guilds: false })
  beat(dir)
  ;(bot as any).adopted.set(GROUP, Date.now() + 60_000)
  mkdirSync(join(dir, 'inbox'))
  writeFileSync(join(dir, 'inbox', 'in.txt'), 'x')
  const outside = join(mkdtempSync(join(tmpdir(), 'vokko-out-')), 'secret.txt')
  writeFileSync(outside, 'key')
  respond = () => Response.json({ id: '9' })
  await expect(bot.reply(GROUP, 'x', undefined, [outside])).rejects.toThrow(/only files from the inbox/)
  await bot.reply(GROUP, 'x', undefined, [join(dir, 'inbox', 'in.txt')])
  // where the plugin owns guilds anyway, any file may be attached, as before
  const own = makeBot()
  await own.bot.reply(GROUP, 'x', undefined, [outside])
})

test('the owner is told once when the bridge goes away and once when it is back, only while a bridge is there to lose', async () => {
  const { bot, dir } = makeBot({ guilds: false })
  ;(bot as any).owner_ = { id: OWNER, username: 'owner', global_name: null }
  const notices = () => calls.filter(c => c.url.endsWith(`/channels/${DM}/messages`)).map(c => JSON.parse(String(c.init?.body)).content as string)
  respond = () => Response.json({ id: '1' })
  ;(bot as any).watchBridge() // no bridge state at all: nothing to report
  beat(dir)
  ;(bot as any).watchBridge() // first look: nothing to report
  writeFileSync(join(dir, 'bridge-state.json'), JSON.stringify({ stoppedAt: Date.now() })) // a clean stop
  ;(bot as any).watchBridge()
  ;(bot as any).watchBridge()
  await settle()
  expect(notices().length).toBe(1)
  expect(notices()[0]).toContain('not running')
  beat(dir)
  ;(bot as any).watchBridge()
  await settle()
  expect(notices().length).toBe(2)
  expect(notices()[1]).toContain('back')
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'pairing', allowFrom: [OWNER], groups: {}, pending: {} })) // guilds is the plugin's
  writeFileSync(join(dir, 'bridge-state.json'), JSON.stringify({ stoppedAt: Date.now() }))
  ;(bot as any).watchBridge()
  await settle()
  expect(notices().length).toBe(2)
})
