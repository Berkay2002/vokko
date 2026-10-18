/**
 * The Vokko side of the channel, kept apart from the MCP glue in server.ts so
 * another assistant backend can reuse it: bot login (REST + gateway), the
 * access.json allowlist with DM pairing, per-channel guild opt-in with
 * requireMention, the "<owner>'s <Name>" guild nickname, and the outbound
 * calls (reply, react, edit, history, attachments).
 *
 * Ported from Anthropic's Discord channel plugin (Apache-2.0, see NOTICE).
 * Vokko's bot API is Discord-shaped but not Discord-identical (gateway at
 * /gateway without ?v=, READY carries full guilds, no /gateway/bot), so this
 * talks to it directly with fetch + WebSocket instead of discord.js.
 */

import { randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, renameSync, realpathSync, chmodSync } from 'fs'
import { basename, join, resolve as resolvePath, sep } from 'path'

// ---- Vokko wire shapes (the subset used here; apps/desktop/src/api/types.ts is the source of truth) ----

export type User = { id: string; username: string; global_name: string | null; bot?: boolean }
export type Attachment = { id: string; filename: string; content_type: string | null; size: number; url: string }
export type Message = {
  id: string
  channel_id: string
  guild_id: string | null
  author: User
  content: string
  timestamp: string
  mentions: User[]
  attachments: Attachment[]
  referenced_message: Message | null
  webhook_id?: string
}
type Overwrite = { id: string; type: number; allow: string; deny: string } // type 0: role (or @everyone, id = guild id), 1: member
type Channel = { id: string; type: number; guild_id?: string | null; parent_id?: string | null; recipients?: User[]; permission_overwrites?: Overwrite[] }
type Member = { user: User; nick?: string | null; roles?: string[]; communication_disabled_until?: string | null }
type GuildInfo = { id: string; owner_id: string; roles: { id: string; permissions: string }[] }

export const ADMINISTRATOR = 1n << 3n
export const VIEW_CHANNEL = 1n << 10n
export const SEND_MESSAGES = 1n << 11n
/** Discord's "use apps" permission: what lets a member talk to Claude in a channel. */
export const USE_APPLICATION_COMMANDS = 1n << 31n
export const MODERATE_MEMBERS = 1n << 40n
/** What a timed-out member keeps (VIEW_CHANNEL | READ_MESSAGE_HISTORY), as in crates/server/src/access.rs. */
const TIMEOUT_ALLOWED = (1n << 10n) | (1n << 16n)
const ALL_PERMISSIONS = (1n << 64n) - 1n
type Guild = { id: string; channels?: Channel[]; threads?: Channel[]; members?: Member[] }

const THREAD_TYPES = new Set([10, 11, 12])
/** Server channels the bot answers in without a groups entry (text, announcement; their threads follow the parent). Not voice, forum or category. */
const DEFAULT_CHANNEL_TYPES = new Set([0, 5])
/** How long the guild's roles and members stay cached for permission checks (gateway events drop them sooner). */
const GUILD_STATE_MS = 30_000
const DEFAULT_POLICY: GroupPolicy = { requireMention: true, allowFrom: [] }

type GuildMember = { guild: GuildInfo; member: Member }

/** Guild-wide bits of a member: all for the guild owner and ADMINISTRATOR, else @everyone plus their roles. */
function baseBits(guild: GuildInfo, member: Member): bigint {
  if (guild.owner_id === member.user.id) return ALL_PERMISSIONS
  const roles = new Map(guild.roles.map(r => [r.id, BigInt(r.permissions)]))
  let bits = roles.get(guild.id) ?? 0n // @everyone
  for (const id of member.roles ?? []) bits |= roles.get(id) ?? 0n
  return bits & ADMINISTRATOR ? ALL_PERMISSIONS : bits
}

/** The member's bits in a channel, as crates/server/src/access.rs resolves them: base, @everyone overwrite, role overwrites (denies, then allows), member overwrite, no VIEW_CHANNEL = nothing, timeout clamp. */
export function channelBits(guild: GuildInfo, member: Member, overwrites: Overwrite[] = [], now = Date.now()): bigint {
  const base = baseBits(guild, member)
  if (base === ALL_PERMISSIONS) return base
  const apply = (bits: bigint, o: Overwrite | undefined) => (o ? (bits & ~BigInt(o.deny)) | BigInt(o.allow) : bits)
  let bits = apply(base, overwrites.find(o => o.type === 0 && o.id === guild.id))
  let allow = 0n, deny = 0n
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== guild.id && member.roles?.includes(o.id)) {
      allow |= BigInt(o.allow)
      deny |= BigInt(o.deny)
    }
  }
  bits = ((bits & ~deny) | allow)
  bits = apply(bits, overwrites.find(o => o.type === 1 && o.id === member.user.id)) & ~ADMINISTRATOR
  if (!(bits & VIEW_CHANNEL)) return 0n
  const timedOut = member.communication_disabled_until != null && Date.parse(member.communication_disabled_until) > now
  return timedOut ? bits & TIMEOUT_ALLOWED : bits
}

// ---- config and state files ----

export type Role = 'channel' | 'bridge-shared' | 'bridge'

/** Owner commands (sent by the bot application's owner in a DM) belong to the bridge, never to the plugin's Claude. */
export const OWNER_COMMAND_RE = /^\s*!(backend|model|effort|pair|pause|unpause|pauses)\b/i

export type Config = {
  stateDir: string
  token: string
  /** Server root, e.g. https://vokko.example.com (REST lives under /api/v1). */
  apiUrl: string
  gatewayUrl: string
  /** The assistant's name: guild nickname "<owner>'s <botName>", and the name used in pairing replies. */
  botName: string
  /** Overrides the owner's display name read from GET /applications/@me. */
  ownerName?: string
  /** Shown in pairing replies, e.g. "/vokko:access pair". */
  pairCommand: string
  /**
   * Which inbound messages this process owns. 'channel': the Claude Code plugin (all, minus what dmBackend/guilds
   * hand to a bridge). 'bridge-shared': a bridge on the plugin's token and state dir (exactly what the plugin hands
   * off). 'bridge': a bridge with its own token and state dir (all).
   */
  role: Role
  /** Access snapshotted at boot, never written (pairing downgraded to allowlist). */
  staticMode: boolean
  log: (line: string) => void
}

/** Loads <stateDir>/.env into process.env (the real environment wins) and builds the config. */
export function loadConfig(stateDir: string, pairCommand: string, log: (line: string) => void, role: Role = 'channel'): Config {
  const envFile = join(stateDir, '.env')
  try {
    // The token is a credential: lock it to the owner. No-op on Windows (would need ACLs).
    chmodSync(envFile, 0o600)
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
  const token = process.env.VOKKO_BOT_TOKEN ?? ''
  const apiUrl = (process.env.VOKKO_API_URL ?? '').replace(/\/+$/, '')
  if (!token || !apiUrl) {
    log(`vokko channel: VOKKO_BOT_TOKEN and VOKKO_API_URL required\n  set in ${envFile}\n  format: VOKKO_BOT_TOKEN=...  VOKKO_API_URL=https://your.vokko.server\n`)
    process.exit(1)
  }
  return {
    stateDir,
    token,
    apiUrl,
    gatewayUrl: process.env.VOKKO_GATEWAY_URL ?? `${apiUrl.replace(/^http/, 'ws')}/gateway`,
    botName: process.env.VOKKO_BOT_NAME || 'Claude',
    ownerName: process.env.VOKKO_OWNER_NAME || undefined,
    pairCommand,
    role,
    staticMode: process.env.VOKKO_ACCESS_MODE === 'static',
    log,
  }
}

type PendingEntry = {
  senderId: string
  chatId: string // DM channel id: where to send the approval confirm
  createdAt: number
  expiresAt: number
  replies: number
}

type GroupPolicy = { requireMention: boolean; allowFrom: string[] }

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  /** Keyed on channel id, not guild id. One entry per guild channel. */
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  /** Emoji to react with on receipt. Empty string disables. Unicode or name:id. */
  ackReaction?: string
  /** Which chunks quote-reply when reply_to is passed. Default: 'first'. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default and cap: 2000. */
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
  /** Who answers DMs: this Claude Code session ('subscription', default) or a separate bridge on the same token ('api'): then DMs are ignored here. */
  dmBackend?: 'subscription' | 'api'
  /** false: guild messages are ignored here (a separate bridge on the same token owns them). Default true. */
  guilds?: boolean
}

function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
}

/**
 * Whether this process answers a DM: the plugin unless dmBackend is "api" or the sender is not the owner, a shared bridge only then.
 * The plugin is one conversation for everything it answers, so only the owner's DMs share it. `bridgeRan` false (no shared bridge was ever set up): the plugin keeps everyone's.
 */
export function ownsDms(role: Role, access: Access, fromOwner = true, bridgeRan = true): boolean {
  return role === 'bridge' || (role === 'bridge-shared') === (access.dmBackend === 'api' || (!fromOwner && bridgeRan))
}

/**
 * Whether this process answers guild messages: the plugin unless guilds is false, a shared bridge only then.
 * `bridgeUp` false (the bridge's heartbeat is stale): guilds is false but no bridge is there, so the plugin answers.
 */
export function ownsGuilds(role: Role, access: Access, bridgeUp = true): boolean {
  return role === 'bridge' || (role === 'bridge-shared') === (access.guilds === false && bridgeUp)
}

/**
 * The shared bridge rewrites this ({at, pid}) every HEARTBEAT_MS while its gateway is connected, and writes {stoppedAt} on a
 * clean stop. The plugin takes guilds over once the file says stopped, is older than BRIDGE_STALE_MS, or names a dead pid.
 * No file at all: no shared bridge has run here, so `guilds: false` is honoured as it is.
 */
export const BRIDGE_STATE = 'bridge-state.json'
export const HEARTBEAT_MS = 10_000
export const BRIDGE_STALE_MS = 90_000
/** The owner hears the bridge is down only after this long, and "back" only if that notice went out (remembered in this file next to bridge-state.json). */
const BRIDGE_DOWN_NOTICE_MS = 60_000
const BRIDGE_DOWN_MARKER = 'bridge-down-notified.json'
/** A message the bridge passes on is a file `handoff/<message id>` (JSON: channel_id); the plugin claims it by renaming it. */
export const HANDOFF_DIR = 'handoff'
/** How long the plugin may still reply in a channel it took a message from, whatever the bridge state does meanwhile. */
const ADOPT_MS = 30 * 60_000
/** A handed-off message older than this is not answered any more. */
const HANDOFF_MAX_AGE_MS = 60_000

const GUILD_EPOCH_MS = 1420070400000

/** When a snowflake id was minted (Vokko uses the Discord epoch). */
export const snowflakeMs = (id: string): number => Number(BigInt(id) >> 22n) + GUILD_EPOCH_MS

export type BridgeState = 'none' | 'alive' | 'down'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function bridgeState(stateDir: string, now = Date.now()): BridgeState {
  let st: { at?: unknown; pid?: unknown; stoppedAt?: unknown }
  try {
    st = JSON.parse(readFileSync(join(stateDir, BRIDGE_STATE), 'utf8'))
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'none' : 'down'
  }
  if (typeof st.stoppedAt === 'number' || typeof st.at !== 'number' || now - st.at >= BRIDGE_STALE_MS) return 'down'
  return typeof st.pid === 'number' && !pidAlive(st.pid) ? 'down' : 'alive'
}

export const MAX_CHUNK_LIMIT = 2000

export type GateResult = { action: 'deliver'; access: Access } | { action: 'drop' } | { action: 'pair'; code: string; isResend: boolean }

/** Splits text at the limit, preferring paragraph, then line, then word boundaries in 'newline' mode. */
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/** "<owner>'s <name>", cut to Vokko's 32-character nickname limit by shortening the owner part. */
export function nickname(owner: string, botName: string): string {
  const suffix = `'s ${botName}`
  return [...owner].slice(0, Math.max(1, 32 - [...suffix].length)).join('').trimEnd() + suffix
}

/** Throws unless id is a snowflake: ids from tool calls go into URL paths, and fetch collapses `..` and `%2e%2e`. */
export function snowflake(id: unknown, what = 'id'): string {
  if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) throw new Error(`invalid ${what}: ${JSON.stringify(id)}`)
  return id
}

const PATH_LITERALS = new Set(['channels', 'messages', 'reactions', '@me', 'attachments', 'typing', 'users', 'applications', 'guilds', 'members'])

/** The REST helper's path check: every segment is a snowflake or a fixed literal (the emoji after
 * `reactions` excepted: encoded, no dots or slashes), and the query is plain key=value pairs. */
export function checkPath(path: string): void {
  const q = path.indexOf('?')
  const segs = (q < 0 ? path : path.slice(0, q)).split('/')
  const ok =
    segs[0] === '' &&
    segs.slice(1).every((s, i) => /^\d{1,20}$/.test(s) || PATH_LITERALS.has(s) || (segs[i] === 'reactions' && s !== '' && !/[./\\?#]|%2e|%2f|%5c/i.test(s))) &&
    (q < 0 || /^\w+=\w+(&\w+=\w+)*$/.test(path.slice(q + 1)))
  if (!ok) throw new Error(`refusing unsafe API path: ${path}`)
}

// Attachment names are uploader-controlled and land inside [...] annotations and newline-joined tool results.
export function safeAttName(att: Attachment): string {
  return (att.filename || att.id).replace(/[\[\]\r\n;]/g, '_')
}

export class VokkoBot {
  readonly cfg: Config
  me: User | null = null
  maxUploadBytes = 25 * 1024 * 1024
  private readonly accessFile: string
  private readonly approvedDir: string
  private readonly inboxDir: string
  private readonly handoffDir: string
  /** Message ids taken over from the bridge: the gate lets each through once, as if the plugin owned guilds. */
  private readonly handed = new Set<string>()
  /** channel id → until when tools may reach it (see ADOPT_MS): set when the gate delivers a message from there, so Claude only reads and writes channels someone triggered it in. */
  private readonly adopted = new Map<string, number>()
  /** When the bridge was first seen down by watchBridge; null while it is up. */
  private downSince: number | null = null
  private readonly bootAccess: Access | null
  private readonly channels = new Map<string, Channel>()
  private readonly dmByUser = new Map<string, string>()
  private owner_: User | null = null
  /** The bot application's owner (GET /applications/@me), read at READY. */
  get ownerId(): string | null {
    return this.owner_?.id ?? null
  }
  private pairingFullAt = -Infinity
  private inboxLocked = false
  private ws: WebSocket | null = null
  private seq: number | null = null
  private sessionId: string | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private acked = true
  private stopped = false
  private backoff = 1000
  /** The gateway is READY (not merely open): what a bridge's heartbeat vouches for. */
  connected = false
  /** Called at READY, after `connected` is set: a bridge writes its heartbeat then instead of waiting for the next tick. */
  onReady?: () => void

  constructor(cfg: Config, private readonly onMessage: (msg: Message) => void) {
    this.cfg = cfg
    this.accessFile = join(cfg.stateDir, 'access.json')
    this.approvedDir = join(cfg.stateDir, 'approved')
    this.inboxDir = join(cfg.stateDir, 'inbox')
    this.handoffDir = join(cfg.stateDir, HANDOFF_DIR)
    // In static mode pairing would hand out codes that can never be approved, so it is downgraded to allowlist.
    this.bootAccess = cfg.staticMode
      ? (() => {
          const a = this.readAccessFile()
          if (a.dmPolicy === 'pairing') {
            cfg.log('vokko channel: static mode — dmPolicy "pairing" downgraded to "allowlist"\n')
            a.dmPolicy = 'allowlist'
          }
          a.pending = {}
          return a
        })()
      : null
  }

  // ---- access.json ----

  private readAccessFile(): Access {
    try {
      const parsed = JSON.parse(readFileSync(this.accessFile, 'utf8')) as Partial<Access>
      return {
        dmPolicy: parsed.dmPolicy ?? 'pairing',
        allowFrom: parsed.allowFrom ?? [],
        groups: parsed.groups ?? {},
        pending: parsed.pending ?? {},
        mentionPatterns: parsed.mentionPatterns,
        ackReaction: parsed.ackReaction,
        replyToMode: parsed.replyToMode,
        textChunkLimit: parsed.textChunkLimit,
        chunkMode: parsed.chunkMode,
        dmBackend: parsed.dmBackend,
        guilds: parsed.guilds,
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
      try {
        renameSync(this.accessFile, `${this.accessFile}.corrupt-${Date.now()}`)
      } catch {}
      this.cfg.log('vokko channel: access.json is corrupt, moved aside. Starting fresh.\n')
      return defaultAccess()
    }
  }

  loadAccess(): Access {
    if (!this.bootAccess) return this.readAccessFile()
    // Static access stays frozen, except who answers what: dmBackend and guilds are shared with the other process on this token.
    try {
      const { dmBackend, guilds } = JSON.parse(readFileSync(this.accessFile, 'utf8')) as Partial<Access>
      return { ...this.bootAccess, dmBackend, guilds }
    } catch {
      return this.bootAccess
    }
  }

  saveAccess(a: Access): void {
    if (this.cfg.staticMode) return
    mkdirSync(this.cfg.stateDir, { recursive: true, mode: 0o700 })
    const tmp = this.accessFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.accessFile)
  }

  // The reply tool's files param takes any path; the channel's own state (token, access.json) is never sendable.
  // inboxOnly: this session holds the channel only as a fallback for the bridge, so nothing outside the inbox may be attached.
  assertSendable(f: string, inboxOnly = false): void {
    // macOS and Windows file systems are case-insensitive by default: compare folded paths there.
    const fold = (p: string) => (process.platform === 'linux' ? p : p.toLowerCase())
    const resolve = (p: string) => {
      try {
        return fold(realpathSync.native(p))
      } catch {
        return null
      }
    }
    const real = resolve(f)
    // /proc/self/environ holds an env-provided token; /dev and /sys are never meant as attachments.
    // The given path counts too: /dev/stdin may resolve to a pipe realpath can't name.
    for (const p of [fold(resolvePath(f)), real]) if (p && /^\/(proc|dev|sys)(\/|$)/.test(p)) throw new Error(`refusing to send a system pseudo-file: ${f}`)
    if (!real) return // statSync fails properly later
    const stateReal = resolve(this.cfg.stateDir)
    const inbox = stateReal && join(stateReal, 'inbox')
    if (inboxOnly && !(real && inbox && real.startsWith(inbox + sep))) throw new Error(`in a server channel answered as the bridge's fallback only files from the inbox can be sent: ${f}`)
    if (!stateReal || !inbox) return // no state dir: nothing to leak
    if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
      throw new Error(`refusing to send channel state: ${f}`)
    }
  }

  // ---- inbound gate ----

  async gate(msg: Message): Promise<GateResult> {
    const access = this.loadAccess()
    const now = Date.now()
    let pruned = false
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.expiresAt < now) {
        delete access.pending[code]
        pruned = true
      }
    }
    if (pruned) this.saveAccess(access)

    if (access.dmPolicy === 'disabled') return { action: 'drop' }
    const senderId = msg.author.id

    if (msg.guild_id == null) {
      if (!this.dmsOwned(access, senderId)) return { action: 'drop' } // the other process answers DMs, pairing included
      if (this.cfg.role === 'channel' && this.isOwnerCommand(msg)) return { action: 'drop' } // a bridge's command
      if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
      if (access.dmPolicy === 'allowlist') return { action: 'drop' }
      for (const [code, p] of Object.entries(access.pending)) {
        if (p.senderId === senderId) {
          // Reply twice max (initial + one reminder), then go silent.
          if ((p.replies ?? 1) >= 2) return { action: 'drop' }
          p.replies = (p.replies ?? 1) + 1
          this.saveAccess(access)
          return { action: 'pair', code, isResend: true }
        }
      }
      // Cap pending at 3 (one per sender, above). Extra attempts are dropped and the owner is told.
      if (Object.keys(access.pending).length >= 3) {
        this.pairingFull(now)
        return { action: 'drop' }
      }
      const code = randomBytes(3).toString('hex')
      access.pending[code] = { senderId, chatId: msg.channel_id, createdAt: now, expiresAt: now + 60 * 60 * 1000, replies: 1 }
      this.saveAccess(access)
      return { action: 'pair', code, isResend: false }
    }

    if (!this.handed.has(msg.id) && !this.guildsOwned(access)) return { action: 'drop' }
    // Keyed on channel id; threads inherit their parent's opt-in (the reply still goes to the thread).
    const policy = this.policyFor(access, msg.channel_id)
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) return { action: 'drop' }
    if ((policy.requireMention ?? true) && !this.isMentioned(msg, access.mentionPatterns)) return { action: 'drop' }
    // Last, because it may cost API calls: the owner always may; everyone else needs Use Application Commands in this channel.
    if (senderId !== this.ownerId && !((await this.bitsIn(msg.guild_id, msg.channel_id, senderId)) & USE_APPLICATION_COMMANDS)) return { action: 'drop' }
    // The plugin answering for a bridge that is out (a handoff, or its heartbeat gone): this session is one conversation, so only channels everyone can see.
    if (!(await this.publicOrOwn(access, msg.guild_id, msg.channel_id))) return { action: 'drop' }
    // A channel the bot answers by default, not by a groups entry: only where it can write too (not a read-only channel).
    if (!access.groups[this.gateKey(msg.channel_id)] && this.me && !((await this.bitsIn(msg.guild_id, msg.channel_id, this.me.id)) & SEND_MESSAGES)) return { action: 'drop' }
    this.adopted.set(msg.channel_id, Date.now() + ADOPT_MS)
    return { action: 'deliver', access }
  }

  /** What the bot does in a server channel: its groups entry, else (any channel it can see, text or announcement, threads via their parent) mention-only for everyone. Null: it stays out. */
  policyFor(access: Access, channelId: string): GroupPolicy | null {
    const key = this.gateKey(channelId)
    const ch = this.channels.get(key)
    return access.groups[key] ?? (ch?.guild_id && DEFAULT_CHANNEL_TYPES.has(ch.type) ? DEFAULT_POLICY : null)
  }

  private readonly guildState = new Map<string, { at: number; guild: GuildInfo; members: Member[] }>()
  private readonly guildLoads = new Map<string, Promise<{ at: number; guild: GuildInfo; members: Member[] } | null>>()

  /** The guild's cached roles and members; concurrent callers (a history page) share one load. */
  private loadGuildState(guildId: string) {
    const st = this.guildState.get(guildId)
    if (st && Date.now() - st.at <= GUILD_STATE_MS) return Promise.resolve(st)
    let load = this.guildLoads.get(guildId)
    if (!load) {
      load = (async () => {
        const [guild, members] = await Promise.all([this.api<GuildInfo>('GET', `/guilds/${snowflake(guildId)}`), this.members(guildId, true)])
        if (!members || !Array.isArray(guild.roles)) return null
        const fresh = { at: Date.now(), guild, members }
        this.guildState.set(guildId, fresh)
        return fresh
      })().finally(() => this.guildLoads.delete(guildId))
      this.guildLoads.set(guildId, load)
    }
    return load
  }

  /** The user's bits in the channel (0n when they are not a member or anything can't be read: a failed lookup refuses). Roles and members are cached for 30 s, overwrites come from the channel cache. */
  private async bitsIn(guildId: string | null, channelId: string, userId: string): Promise<bigint> {
    if (!guildId) return 0n
    try {
      const channel = this.channels.get(this.gateKey(channelId))
      if (!channel) return 0n // overwrites unknown: refuse rather than guess none
      const st = await this.loadGuildState(guildId)
      const member = st?.members.find(m => m.user.id === userId)
      return st && member ? channelBits(st.guild, member, channel.permission_overwrites) : 0n
    } catch (err) {
      this.cfg.log(`vokko channel: cannot read permissions in guild ${guildId}: ${err}
`)
      return 0n
    }
  }

  // Three accounts can hold every pairing slot for an hour: say so, at most once an hour.
  private pairingFull(now: number): void {
    if (now - this.pairingFullAt < 60 * 60 * 1000) return
    this.pairingFullAt = now
    const text = `Pairing is full: 3 requests are pending, so new ones are dropped until they expire (1 hour). If you don't know them, deny them with ${this.cfg.pairCommand.replace(/ pair$/, '')} deny <code>.`
    this.cfg.log(`vokko channel: ${text}\n`)
    this.ownerUser()
      .then(u => u && this.dmUser(u.id, text))
      .catch(err => this.cfg.log(`vokko channel: could not tell the owner that pairing is full: ${err}\n`))
  }

  /** Whether @everyone can view the channel (a thread follows its parent; a private thread never counts). A failed lookup says no. */
  async publicChannel(guildId: string, channelId: string): Promise<boolean> {
    if (this.channels.get(channelId)?.type === 12) return false
    try {
      const channel = this.channels.get(this.gateKey(channelId))
      const st = channel && (await this.loadGuildState(guildId))
      // Nobody's id and no roles: exactly @everyone.
      return st != null && (channelBits(st.guild, { user: { id: '', username: '', global_name: null }, roles: [] }, channel!.permission_overwrites) & VIEW_CHANNEL) !== 0n
    } catch (err) {
      this.cfg.log(`vokko channel: cannot read permissions in guild ${guildId}: ${err}
`)
      return false
    }
  }

  /** Answering a bridge's guilds as its fallback (`guilds false`): only public channels, in the gate and for tools alike. */
  private async publicOrOwn(access: Access, guildId: string, channelId: string): Promise<boolean> {
    return this.cfg.role !== 'channel' || access.guilds !== false || (await this.publicChannel(guildId, channelId))
  }

  /** ownsDms for this sender; a plugin with no bridge set up keeps everyone's DMs. */
  dmsOwned(access: Access, userId: string): boolean {
    return ownsDms(this.cfg.role, access, userId === this.ownerId, this.cfg.role !== 'channel' || bridgeState(this.cfg.stateDir) !== 'none')
  }

  /** ownsGuilds, with the bridge's heartbeat for the plugin. */
  private guildsOwned(access: Access): boolean {
    return ownsGuilds(this.cfg.role, access, this.cfg.role !== 'channel' || bridgeState(this.cfg.stateDir) !== 'down')
  }

  isOwnerCommand(msg: Message): boolean {
    return msg.guild_id == null && this.ownerId != null && msg.author.id === this.ownerId && OWNER_COMMAND_RE.test(msg.content)
  }

  gateKey(channelId: string): string {
    const ch = this.channels.get(channelId)
    return ch && THREAD_TYPES.has(ch.type) && ch.parent_id ? ch.parent_id : channelId
  }

  private isMentioned(msg: Message, extraPatterns?: string[]): boolean {
    const me = this.me?.id
    if (me && msg.mentions.some(u => u.id === me)) return true
    // A reply to one of our messages counts as a mention (Vokko sends the referenced message inline).
    if (me && msg.referenced_message?.author.id === me) return true
    for (const pat of extraPatterns ?? []) {
      try {
        if (new RegExp(pat, 'i').test(msg.content)) return true
      } catch {}
    }
    return false
  }

  /** Handles the gate's verdict for pairing (sends the code) and returns whether the message should be delivered. */
  async admit(msg: Message): Promise<Access | null> {
    const result = await this.gate(msg)
    if (this.handed.delete(msg.id)) this.verdict(msg.id, result.action === 'deliver' ? 'accepted' : 'declined')
    if (result.action === 'drop') return null
    if (result.action === 'pair') {
      const lead = result.isResend ? 'Still pending' : 'Pairing required'
      const how =
        this.cfg.role === 'channel'
          ? `run in ${this.cfg.botName}'s terminal:\n\n${this.cfg.pairCommand} ${result.code}`
          : `the bot's owner approves it by sending me \`!pair ${result.code}\`${this.cfg.role === 'bridge-shared' ? ` (or ${this.cfg.pairCommand} ${result.code} in their terminal)` : ''}.`
      try {
        await this.send(msg.channel_id, `${lead} — ${how}`, msg.id)
      } catch (err) {
        this.cfg.log(`vokko channel: failed to send pairing code: ${err}\n`)
      }
      return null
    }
    return result.access
  }

  // The access skill drops approved/<senderId> (contents: the DM channel id) when it pairs someone.
  private checkApprovals(): void {
    let files: string[]
    try {
      files = readdirSync(this.approvedDir)
    } catch {
      return
    }
    for (const senderId of files) {
      const file = join(this.approvedDir, senderId)
      let dmChannelId = ''
      try {
        dmChannelId = readFileSync(file, 'utf8').trim()
      } catch {}
      rmSync(file, { force: true }) // removed either way: never loop on a broken send
      if (!dmChannelId) continue
      this.send(dmChannelId, `Paired! Say hi to ${this.cfg.botName}.`).catch(err => this.cfg.log(`vokko channel: failed to send approval confirm: ${err}\n`))
    }
  }

  // ---- fallback: the API bridge is out, this session answers its guild messages ----

  private notifyOwner(text: string): void {
    if (this.ownerId) this.dmUser(this.ownerId, text).catch(err => this.cfg.log(`vokko channel: owner notice failed: ${err}\n`))
  }

  /**
   * Tells the owner when the bridge has been away for BRIDGE_DOWN_NOTICE_MS in a row (a planned restart sends nothing), and once it is back.
   * The "down" notice is remembered in BRIDGE_DOWN_MARKER, so "back" still arrives after this plugin restarted meanwhile, and never without a "down".
   * Only while guilds belong to the bridge.
   */
  private watchBridge(now = Date.now()): void {
    const marker = join(this.cfg.stateDir, BRIDGE_DOWN_MARKER)
    const st = this.loadAccess().guilds === false ? bridgeState(this.cfg.stateDir, now) : 'none'
    if (st === 'none') {
      this.downSince = null
      rmSync(marker, { force: true })
      return
    }
    if (st === 'alive') {
      this.downSince = null
      if (existsSync(marker)) {
        rmSync(marker, { force: true })
        this.notifyOwner('Servers are back on the API bridge.')
      }
      return
    }
    this.downSince ??= now
    if (now - this.downSince < BRIDGE_DOWN_NOTICE_MS || existsSync(marker)) return
    try {
      writeFileSync(`${marker}.tmp`, JSON.stringify({ at: now }), { mode: 0o600 })
      renameSync(`${marker}.tmp`, marker)
    } catch (err) {
      return this.cfg.log(`vokko channel: cannot remember the bridge-down notice: ${err}\n`) // no marker, no "back" later: say nothing now either
    }
    this.notifyOwner('The API bridge is not running: servers are answered by your Claude Code session (subscription) until it is back.')
  }

  private checkHandoffs(): void {
    let files: string[]
    try {
      files = readdirSync(this.handoffDir)
    } catch {
      return
    }
    for (const id of files) {
      if (!/^\d{1,20}$/.test(id)) continue
      const file = join(this.handoffDir, id)
      const taken = `${file}.taken`
      try {
        renameSync(file, taken) // the claim: the bridge sees the file gone, and no second poll can take it
      } catch {
        continue
      }
      let channelId = ''
      try {
        channelId = String((JSON.parse(readFileSync(taken, 'utf8')) as { channel_id?: unknown }).channel_id ?? '')
      } catch {}
      rmSync(taken, { force: true })
      if (Date.now() - snowflakeMs(id) > HANDOFF_MAX_AGE_MS) {
        this.verdict(id, 'declined') // too old to answer now
        continue
      }
      this.adopt(id, channelId).catch(err => {
        this.cfg.log(`vokko channel: handoff ${id} failed: ${err}\n`)
        this.verdict(id, 'declined')
      })
    }
  }

  /** Tells the bridge, still waiting, what became of a message it passed on (it answers "Sorry…" for a declined one). */
  private verdict(id: string, kind: 'accepted' | 'declined'): void {
    try {
      writeFileSync(join(this.handoffDir, `${id}.${kind}`), '', { mode: 0o600 })
    } catch {}
  }

  /** Fetches the message by id and runs it through the normal gate (opt-in, requireMention, allowFrom) as if guilds were ours. */
  private async adopt(id: string, channelId: string): Promise<void> {
    const [msg] = await this.api<Message[]>('GET', `/channels/${snowflake(channelId, 'channel_id')}/messages?around=${snowflake(id, 'message_id')}&limit=1`)
    if (msg?.id !== id || msg.guild_id == null || msg.author.bot || msg.author.id === this.me?.id) return this.verdict(id, 'declined')
    this.handed.add(id)
    this.onMessage(msg)
  }

  // ---- REST ----

  async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    checkPath(path)
    for (let attempt = 0; ; attempt++) {
      const form = body instanceof FormData
      const res = await fetch(`${this.cfg.apiUrl}/api/v1${path}`, {
        method,
        headers: { Authorization: `Bot ${this.cfg.token}`, ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : form ? body : JSON.stringify(body),
      })
      if (res.status === 429 && attempt < 3) {
        await new Promise(r => setTimeout(r, Math.min(10, Number(res.headers.get('retry-after')) || 1) * 1000))
        continue
      }
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
      return (res.status === 204 ? undefined : await res.json()) as T
    }
  }

  // ---- outbound gate: tools reach only chats the inbound gate would deliver from ----

  async allowedChannel(id: string): Promise<void> {
    snowflake(id, 'chat_id')
    const access = this.loadAccess()
    const ch = this.channels.get(id)
    if (ch?.type === 1) {
      const userId = ch.recipients?.find(u => u.id !== this.me?.id)?.id
      if (userId && this.dmsOwned(access, userId) && access.allowFrom.includes(userId)) return
    } else if (ch && ((this.guildsOwned(access) && this.gateKey(id) in access.groups) || (this.adopted.get(id) ?? 0) > Date.now()) && (await this.publicOrOwn(access, ch.guild_id ?? '', id))) {
      // a groups entry, or a channel someone triggered Claude in: not every channel it merely sees
      return
    }
    throw new Error(`channel ${id} is not allowlisted — add via ${this.cfg.pairCommand.replace(/ pair$/, '')}`)
  }

  async send(channelId: string, content: string, replyTo?: string, attachmentIds: string[] = []): Promise<Message> {
    return this.api<Message>('POST', `/channels/${channelId}/messages`, {
      content,
      ...(replyTo ? { message_reference: { message_id: replyTo } } : {}),
      ...(attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {}),
    })
  }

  /** Sends text (chunked per access.json) with files on the first chunk; returns the sent ids. */
  async reply(chatId: string, text: string, replyTo?: string, files: string[] = []): Promise<string[]> {
    await this.allowedChannel(chatId)
    if (files.length > 10) throw new Error('Vokko allows max 10 attachments per message')
    // A server channel the bridge owns (guilds false) is only ours as its fallback: members could steer this session into attaching files.
    const inboxOnly = this.cfg.role === 'channel' && this.channels.get(chatId)?.type !== 1 && this.loadAccess().guilds === false
    // Read each file right after its check: a symlink swapped in while earlier uploads await is never sent.
    const blobs: Blob[] = []
    for (const f of files) {
      this.assertSendable(f, inboxOnly)
      const st = statSync(f)
      if (st.size > this.maxUploadBytes) throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max ${(this.maxUploadBytes / 1024 / 1024).toFixed(0)}MB)`)
      blobs.push(new Blob([readFileSync(f)]))
    }
    const access = this.loadAccess()
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
    const replyMode = access.replyToMode ?? 'first'
    const chunks = chunk(text, limit, access.chunkMode ?? 'length')
    const sentIds: string[] = []
    try {
      const uploaded: string[] = []
      for (const [i, f] of files.entries()) {
        const form = new FormData()
        form.append('file', blobs[i]!, basename(f))
        uploaded.push((await this.api<Attachment>('POST', `/channels/${chatId}/attachments`, form)).id)
      }
      for (let i = 0; i < chunks.length; i++) {
        const quote = replyTo != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
        const sent = await this.send(chatId, chunks[i], quote ? replyTo : undefined, i === 0 ? uploaded : [])
        sentIds.push(sent.id)
      }
    } catch (err) {
      throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${err instanceof Error ? err.message : err}`)
    }
    return sentIds
  }

  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.allowedChannel(chatId)
    snowflake(messageId, 'message_id')
    // custom emoji may come as <:name:id> or <a:name:id>; Vokko takes name:id
    const e = emoji.replace(/^<a?:([^:>]+):(\d+)>$/, '$1:$2')
    await this.api('PUT', `/channels/${chatId}/messages/${messageId}/reactions/${encodeURIComponent(e)}/@me`)
  }

  async edit(chatId: string, messageId: string, text: string): Promise<Message> {
    await this.allowedChannel(chatId)
    snowflake(messageId, 'message_id')
    return this.api<Message>('PATCH', `/channels/${chatId}/messages/${messageId}`, { content: text })
  }

  /** Whether the inbound gate would let this author through in this chat (ourselves included).
   * Channels restricted with an allowFrom list, and members without Use Application Commands, still have messages here that must not reach the session. */
  async senderAllowed(chatId: string, authorId: string): Promise<boolean> {
    if (authorId === this.me?.id) return true
    const ch = this.channels.get(chatId)
    if (ch?.type === 1) return true // a DM: the other side passed allowedChannel
    const allow = this.policyFor(this.loadAccess(), chatId)?.allowFrom ?? []
    if (allow.length > 0 && !allow.includes(authorId)) return false
    return authorId === this.ownerId || ((await this.bitsIn(ch?.guild_id ?? null, chatId, authorId)) & USE_APPLICATION_COMMANDS) !== 0n
  }

  /** Newest `limit` messages, oldest first, without senders the gate would drop. */
  async history(chatId: string, limit: number): Promise<Message[]> {
    await this.allowedChannel(chatId)
    const msgs = await this.api<Message[]>('GET', `/channels/${chatId}/messages?limit=${Math.max(1, Math.min(Math.floor(limit) || 1, 100))}`)
    const ok = await Promise.all(msgs.map(m => this.senderAllowed(chatId, m.author.id)))
    return msgs.filter((_, i) => ok[i]).reverse()
  }

  async message(chatId: string, messageId: string): Promise<Message> {
    await this.allowedChannel(chatId)
    snowflake(messageId, 'message_id')
    const [msg] = await this.api<Message[]>('GET', `/channels/${chatId}/messages?around=${messageId}&limit=1`)
    if (msg?.id !== messageId) throw new Error(`message ${messageId} not found`)
    if (!(await this.senderAllowed(chatId, msg.author.id))) throw new Error(`message ${messageId} is from a sender not allowlisted in this channel`)
    return msg
  }

  /** Saves an attachment into <stateDir>/inbox and returns its path. */
  async download(att: Attachment): Promise<string> {
    const max = this.maxUploadBytes
    if (att.size > max) throw new Error(`attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB`)
    // Attachment URLs are capability URLs (and may redirect off-origin when presigned): never send the token.
    const res = await fetch(att.url)
    if (!res.ok || !res.body) throw new Error(`download ${att.id}: ${res.status}`)
    // att.size is the uploader's word: cap what is actually read.
    const parts: Uint8Array[] = []
    let total = 0
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += part.length
      if (total > max) throw new Error(`attachment ${att.id} exceeds ${(max / 1024 / 1024).toFixed(0)}MB`)
      parts.push(part)
    }
    const rawExt = att.filename.includes('.') ? att.filename.slice(att.filename.lastIndexOf('.') + 1) : 'bin'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const path = join(this.inboxDir, `${Date.now()}-${snowflake(att.id, 'attachment id')}.${ext}`)
    mkdirSync(this.inboxDir, { recursive: true, mode: 0o700 })
    if (!this.inboxLocked) {
      // mkdir's mode skips a dir that already exists: tighten it (and older files) once per run.
      chmodSync(this.inboxDir, 0o700)
      for (const name of readdirSync(this.inboxDir)) chmodSync(join(this.inboxDir, name), 0o600)
      this.inboxLocked = true
    }
    writeFileSync(path, Buffer.concat(parts), { mode: 0o600 })
    return path
  }

  /** Sends a DM to an allowlisted user (opens the DM channel if needed). */
  async dmUser(userId: string, text: string): Promise<void> {
    let chatId = this.dmByUser.get(userId)
    if (!chatId) {
      const ch = await this.api<Channel>('POST', '/users/@me/channels', { recipient_id: userId })
      this.cacheChannel(ch)
      chatId = ch.id
    }
    for (const part of chunk(text, MAX_CHUNK_LIMIT, 'newline')) await this.send(chatId, part)
  }

  typing(chatId: string): void {
    this.api('POST', `/channels/${chatId}/typing`).catch(() => {})
  }

  // ---- guild members (pause targets and moderator checks) ----

  private readonly memberCache = new Map<string, { at: number; list: Member[] }>()

  /** The guild's members (cached for a minute unless `fresh`), or null when they can't be read. */
  async members(guildId: string, fresh = false): Promise<Member[] | null> {
    const cached = this.memberCache.get(guildId)
    if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.list
    try {
      const out: Member[] = []
      for (;;) {
        const after = out.length > 0 ? `&after=${out[out.length - 1].user.id}` : ''
        const page = await this.api<Member[]>('GET', `/guilds/${snowflake(guildId)}/members?limit=1000${after}`)
        out.push(...page)
        if (page.length < 1000) break
      }
      this.memberCache.set(guildId, { at: Date.now(), list: out })
      return out
    } catch (err) {
      this.cfg.log(`vokko channel: cannot list members of guild ${guildId}: ${err}\n`)
      return null
    }
  }

  /** Guild-level permission bits of a member (owner and ADMINISTRATOR: all), or null when they are not a member. Always read fresh: a removed role or a timeout counts at once. */
  async memberPermissions(guildId: string, userId: string): Promise<bigint | null> {
    const [guild, members] = await Promise.all([this.api<GuildInfo>('GET', `/guilds/${snowflake(guildId)}`).catch(() => null), this.members(guildId, true)])
    const member = members?.find(m => m.user.id === userId)
    if (!guild || !member) return null
    const bits = baseBits(guild, member)
    if (bits === ALL_PERMISSIONS) return bits
    const timedOut = member.communication_disabled_until != null && Date.parse(member.communication_disabled_until) > Date.now()
    return timedOut ? bits & TIMEOUT_ALLOWED : bits
  }

  // ---- nickname ----

  private async ownerUser(): Promise<User | null> {
    if (this.owner_) return this.owner_
    try {
      const app = await this.api<{ owner_id: string }>('GET', '/applications/@me')
      this.owner_ = await this.api<User>('GET', `/users/${app.owner_id}`)
    } catch (err) {
      this.cfg.log(`vokko channel: cannot read the application owner: ${err}\n`)
    }
    return this.owner_
  }

  private async owner(): Promise<string | null> {
    if (this.cfg.ownerName) return this.cfg.ownerName
    const u = await this.ownerUser()
    if (!u) this.cfg.log('vokko channel: set VOKKO_OWNER_NAME to name the bot without /applications/@me\n')
    return u ? u.global_name || u.username : null
  }

  private async setNickname(guild: Guild): Promise<void> {
    const owner = await this.owner()
    if (!owner || !this.me) return
    const nick = nickname(owner, this.cfg.botName)
    if (guild.members?.find(m => m.user.id === this.me?.id)?.nick === nick) return
    try {
      await this.api('PATCH', `/guilds/${guild.id}/members/@me`, { nick })
    } catch (err) {
      this.cfg.log(`vokko channel: could not set nickname in guild ${guild.id} (needs CHANGE_NICKNAME): ${err}\n`)
    }
  }

  // ---- gateway ----

  private cacheChannel(ch: Channel): void {
    this.channels.set(ch.id, ch)
    const other = ch.type === 1 ? ch.recipients?.find(u => u.id !== this.me?.id) : undefined
    if (other) this.dmByUser.set(other.id, ch.id)
  }

  private cacheGuild(g: Guild): void {
    for (const ch of [...(g.channels ?? []), ...(g.threads ?? [])]) this.cacheChannel({ ...ch, guild_id: g.id })
  }

  private dispatch(t: string, d: any): void {
    switch (t) {
      case 'READY':
        this.me = d.user
        this.connected = true
        this.sessionId = d.session_id
        if (typeof d.max_upload_bytes === 'number') this.maxUploadBytes = d.max_upload_bytes
        for (const ch of d.private_channels ?? []) this.cacheChannel(ch)
        void this.ownerUser()
        for (const g of d.guilds ?? []) {
          this.cacheGuild(g)
          void this.setNickname(g)
        }
        this.cfg.log(`vokko channel: gateway connected as ${d.user.username}\n`)
        this.onReady?.()
        break
      case 'GUILD_CREATE':
        this.cacheGuild(d)
        void this.setNickname(d)
        break
      case 'GUILD_UPDATE':
      case 'GUILD_MEMBER_ADD':
      case 'GUILD_MEMBER_UPDATE':
      case 'GUILD_MEMBER_REMOVE':
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE':
      case 'GUILD_ROLE_DELETE':
        // roles or members changed: the next permission check reads them again
        this.guildState.delete(d.guild_id ?? d.id)
        break
      case 'CHANNEL_DELETE':
      case 'THREAD_DELETE':
        // also what the server sends when the channel is hidden from the bot
        this.channels.delete(d.id)
        break
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE':
        this.cacheChannel(d)
        break
      case 'MESSAGE_CREATE': {
        const msg = d as Message
        if (msg.author.bot || msg.webhook_id || msg.author.id === this.me?.id) return
        // a DM channel we have not seen yet (opened by the other side)
        if (msg.guild_id == null && !this.channels.has(msg.channel_id)) this.cacheChannel({ id: msg.channel_id, type: 1, recipients: [msg.author] })
        this.onMessage(msg)
        break
      }
    }
  }

  private sendWs(op: number, d: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }))
  }

  private connect(): void {
    const ws = new WebSocket(this.cfg.gatewayUrl)
    this.ws = ws
    ws.onmessage = ev => {
      const p = JSON.parse(String(ev.data)) as { op: number; d: any; s?: number | null; t?: string | null }
      if (p.s != null) this.seq = p.s
      switch (p.op) {
        case 0:
          this.backoff = 1000
          this.dispatch(p.t ?? '', p.d)
          break
        case 10:
          if (this.heartbeat) clearInterval(this.heartbeat)
          this.acked = true
          this.heartbeat = setInterval(() => {
            // no ack since the last beat: the connection is a zombie, reconnect
            if (!this.acked) return ws.close(4000)
            this.acked = false
            this.sendWs(1, this.seq)
          }, p.d.heartbeat_interval)
          if (this.sessionId && this.seq != null) this.sendWs(6, { token: `Bot ${this.cfg.token}`, session_id: this.sessionId, seq: this.seq })
          else this.sendWs(2, { token: `Bot ${this.cfg.token}` })
          break
        case 11:
          this.acked = true
          break
        case 1:
          this.sendWs(1, this.seq)
          break
        case 7:
          ws.close(4000)
          break
        case 9:
          this.sessionId = null
          this.seq = null
          this.sendWs(2, { token: `Bot ${this.cfg.token}` })
          break
      }
    }
    ws.onclose = ev => {
      this.connected = false
      if (this.heartbeat) clearInterval(this.heartbeat)
      this.heartbeat = null
      if (this.stopped) return
      if (ev.code === 4004) {
        this.cfg.log('vokko channel: login failed (bad bot token)\n')
        process.exit(1)
      }
      this.cfg.log(`vokko channel: gateway closed (${ev.code}), reconnecting in ${this.backoff / 1000}s\n`)
      setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, 60_000)
    }
    ws.onerror = () => {} // onclose follows and reconnects
  }

  /** approvals: poll approved/ for /vokko:access pairings (the plugin does; a shared bridge leaves it to the plugin). */
  start(approvals = true): void {
    this.connect()
    if (approvals && !this.cfg.staticMode) setInterval(() => this.checkApprovals(), 5000).unref()
    if (this.cfg.role === 'channel') {
      setInterval(() => this.checkHandoffs(), 1000).unref()
      setInterval(() => this.watchBridge(), 10_000).unref()
    }
  }

  stop(): void {
    this.stopped = true
    this.connected = false
    this.ws?.close(1000)
  }
}
