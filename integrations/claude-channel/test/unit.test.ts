// Unit checks for the security review fixes: bun test
import { test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, statSync, mkdirSync, chmodSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { VokkoBot, checkPath, type Config, type Message } from '../vokko.ts'

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
  const cfg: Config = { stateDir: dir, token: 'SECRET', apiUrl: 'http://vokko.test', gatewayUrl: 'ws://vokko.test/gateway', botName: 'Claude', pairCommand: '/vokko:access pair', staticMode: false, log: l => void logs.push(l) }
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
