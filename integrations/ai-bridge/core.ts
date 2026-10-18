/**
 * The bridge between Vokko and one assistant backend (Claude API or Codex): routing on top of
 * the channel plugin's VokkoBot (same gate, pairing and access.json), owner and moderator
 * commands, the abuse guard, a per-user rate limit, a monthly cost tally with a soft cap, and
 * one persisted backend session per DM or guild channel.
 */

import { chmodSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync, unlinkSync } from 'fs'
import { join } from 'path'
import { BRIDGE_STALE_MS, BRIDGE_STATE, HANDOFF_DIR, HEARTBEAT_MS, MODERATE_MEMBERS, ownsGuilds, safeAttName, type Access, type Message, type VokkoBot } from '../claude-channel/vokko.ts'
import { PauseStore, RECENT_MS, decide, type Pause, type Role } from './pauses.ts'
import { asker, runMediaTool } from '../claude-channel/media.ts'

export type Totals = { costUsd?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
const TOTALS = ['costUsd', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const

/** What a turn spent. `cumulative`: running totals of the whole session (the bridge counts the difference). */
export type Spent = Totals & { sessionId?: string; cumulative?: boolean }

export type Answer = Spent & {
  text: string
  sessionId: string
  /** false: the session ran into a limit; start a new one next time. */
  keepSession?: boolean
}

/** A backend failure that still cost something. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly spent: Spent,
  ) {
    super(message)
  }
}

/** What a backend's tools may ask the bridge for. Every rule is checked here, against the real author. */
export type TurnContext = {
  /** Where the message came from: DMs and servers have their own model and effort. */
  scope: Scope
  pause(args: { user_id?: string; minutes: number; reason: string }): Promise<string>
  unpause(args: { user_id: string }): Promise<string>
  /** Runs a Spotify/Stremio tool (media.ts) as the author of this turn's message; the text goes back to the model. */
  media?(name: string, args: Record<string, unknown>): Promise<string>
}

/** Media tool calls one reply may make (the per-reply cost cap and maxTurns stop it too). */
export const MEDIA_CALLS_PER_TURN = 12

export const SCOPES = ['dm', 'server'] as const
export type Scope = (typeof SCOPES)[number]
export type Setting = { model: string; effort: string }

/** The owner-adjustable knobs of a backend (!model, !effort), per scope. The next turn reads them; a running session keeps its history. */
export type Tune = {
  /** Effort values the SDK accepts and the owner may pick. */
  efforts: readonly string[]
  /** What `!model` accepts, for the usage line. */
  modelHint: string
  get(scope: Scope): Setting
  /** The model id for what the owner typed (an alias or an id); throws UserFacingError when the backend refuses it. */
  resolveModel(input: string): string
  set(scope: Scope, s: Partial<Setting>): void
}

/** VOKKO_AI_EFFORT (`name`): one of `allowed`, or `fallback` when unset. Throws a message fit for the log. */
export function parseEffort(raw: string | undefined, allowed: readonly string[], fallback = 'low', name = 'VOKKO_AI_EFFORT'): string {
  const v = (raw ?? '').trim().toLowerCase()
  if (!v) return fallback
  if (!allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join(', ')}, not ${raw}`)
  return v
}

export interface Backend {
  /** Key prefix for sessions, e.g. "claude-api". */
  readonly name: string
  /** Costs money per reply: the monthly soft cap applies. */
  readonly metered: boolean
  /** Answers only allowlisted (paired) senders, never other members of an opted-in channel. */
  readonly allowlistedOnly?: boolean
  /** Model and effort the owner can change at runtime. */
  readonly tune?: Tune
  ask(sessionId: string | undefined, prompt: string, ctx: TurnContext): Promise<Answer>
}

/** An error whose message is meant for the chat (e.g. "Codex isn't signed in on the host"). */
export class UserFacingError extends Error {}

export type Limits = {
  /** Messages per user per hour (the owner is exempt). */
  perHour: number
  /** Soft monthly cap in USD for metered backends; the Console's spend limit is the hard cap. */
  monthlyUsd: number
}

export type BotLike = Pick<
  VokkoBot,
  'cfg' | 'me' | 'connected' | 'ownerId' | 'admit' | 'reply' | 'send' | 'dmUser' | 'typing' | 'react' | 'loadAccess' | 'saveAccess' | 'members' | 'memberPermissions' | 'api' | 'policyFor' | 'isOwnerCommand'
>

const SNOWFLAKE = /^\d{1,20}$/
const GUILD_COMMAND_RE = /^\s*!(pause|unpause|pauses)\b/i
/** Owner/moderator rights reach someone else only when their own message is this command for that person. */
const PAUSE_VERB = 'pause|mute|silence'
const UNPAUSE_VERB = 'unpause|unmute'
/** A channel's session starts over after this long or this many turns (each turn re-reads the whole history). */
export const SESSION_MAX_AGE_MS = 3 * 24 * 60 * 60_000
export const SESSION_MAX_TURNS = 40

/** The message minus code (``` blocks, `inline`) and "> " quote lines: a command shown or quoted is not given. */
export function commandText(content: string): string {
  return content
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter(l => !/^\s*>/.test(l))
    .join('\n')
}

/** "<verb> <@target>" at the start of the message (after the bot's mention, if any): "don't mute <@X>" or "should I pause <@X>?" are not. */
export function isCommandFor(content: string, verbs: string, target: string, botId: string | null): boolean {
  const bot = botId ? `(?:<@!?${botId}>\\s*)?` : ''
  return new RegExp(`^\\s*${bot}(?:${verbs})\\s+<@!?${target}>(\\s|$)`, 'i').test(commandText(content))
}

/** "<@123>", "<@!123>" or "123" → "123"; anything else → null. */
export function parseUserId(s: string | undefined): string | null {
  const id = (s ?? '').trim().replace(/^<@!?(\d+)>$/, '$1')
  return SNOWFLAKE.test(id) ? id : null
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(file, 'utf8')) as T) }
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/** An API failure that is not the sender's doing (auth, credit, overload/5xx, network), as a short class for the owner: no secrets, no raw error text. Null: anything else (a bad request may be the sender's), which keeps the old error message. */
export function failureClass(err: unknown): string | null {
  const s = String(err)
  if (/credit|billing|balance|payment/i.test(s)) return 'API: credit balance too low'
  if (/authenticat|api[ _-]?key|unauthori[sz]ed|\b40[13]\b|oauth/i.test(s)) return 'API: authentication failed'
  if (/overload|\b429\b|rate.?limit|\b5\d\d\b|server_error|unavailable/i.test(s)) return 'API: overloaded or down'
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|socket|timed? ?out/i.test(s)) return 'API: unreachable'
  return null
}

/** After an API failure, guild messages go to the subscription for this long; then the next one tries the API again. */
export const COOLDOWN_MS = 10 * 60_000
/** At most this many messages an hour, across all servers, go to the subscription; the rest get the old error message. */
export const HANDOFFS_PER_HOUR = 30
const BUDGET_REASON = 'API: monthly budget reached'
const SORRY = 'Sorry, something went wrong. Try again in a bit.'

const attr = (s: string) => s.replace(/["<>\r\n]/g, '')

type Usage = { month: string } & Required<Totals>
const NO_USAGE: Usage = { month: '', costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

type Session = { id: string; at: number; turns: number; /** The backend's running totals at the last turn. */ last?: Totals }

const totalsOf = (s: Totals): Totals => Object.fromEntries(TOTALS.map(f => [f, s[f] ?? 0]))

export class Bridge {
  readonly pauses: PauseStore
  private readonly sessionsFile: string
  private readonly usageFile: string
  private readonly settingsFile: string
  /** The owner's !model / !effort choices that are in force, per scope; they override the env defaults. */
  private settings: Partial<Record<Scope, Partial<Setting>>> = {}
  private readonly sessions: Record<string, Session>
  private usage: Usage
  private readonly hits = new Map<string, number[]>()
  private readonly commandHits = new Map<string, number[]>()
  private readonly rateNoticed = new Map<string, number>()
  /** channel id → user id → when they last sent the bot a delivered message there. */
  private readonly recent = new Map<string, Map<string, number>>()
  private readonly queues = new Map<string, Promise<void>>()
  /** Set while guild messages go to the plugin instead of the API (a failed turn, or the budget); cleared by the next successful guild turn after `until`. */
  private out: { reason: string; until: number } | null = null
  /** Counts markOut calls: a turn that started before the latest one proves nothing about the API now. */
  private outGen = 0
  private beat: ReturnType<typeof setInterval> | null = null
  private lastBeat: number | null = null
  private readonly handoffHits = new Map<string, number[]>()

  constructor(
    private readonly bot: BotLike,
    private readonly backend: Backend,
    private readonly limits: Limits,
    private readonly now: () => number = Date.now,
    /** How long a handed-off message may wait for the plugin to take it. */
    private readonly handoffWaitMs = 5000,
  ) {
    const dir = bot.cfg.stateDir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700) // an existing dir keeps its old mode otherwise
    this.pauses = new PauseStore(join(dir, 'pauses.json'))
    this.sessionsFile = join(dir, `sessions-${backend.name}.json`)
    this.usageFile = join(dir, `usage-${backend.name}.json`)
    const sessions = readJson<Record<string, Session | string>>(this.sessionsFile, {})
    // Older files kept just the id.
    this.sessions = Object.fromEntries(Object.entries(sessions).map(([k, v]) => [k, typeof v === 'string' ? { id: v, at: now(), turns: 0 } : v]))
    this.usage = readJson<Usage>(this.usageFile, NO_USAGE)
    this.settingsFile = join(dir, `settings-${backend.name}.json`)
    this.restoreSettings()
  }

  /** Re-applies the saved choices; one that is no longer valid (a model gone from the catalog) is logged and skipped. A flat file (before DMs and servers were split) counts for both scopes. */
  private restoreSettings(): void {
    const tune = this.backend.tune
    if (!tune) return
    type Saved = Partial<Setting> & Partial<Record<Scope, Partial<Setting>>>
    const file = readJson<Saved>(this.settingsFile, {})
    const flat = typeof file.model === 'string' || typeof file.effort === 'string'
    for (const scope of SCOPES) {
      const saved = (flat ? file : file[scope]) ?? {}
      const mine: Partial<Setting> = {}
      if (typeof saved.model === 'string') {
        try {
          mine.model = tune.resolveModel(saved.model)
        } catch (e) {
          this.log(`saved ${scope} model ${saved.model} ignored: ${e instanceof Error ? e.message : e}`)
        }
      }
      if (typeof saved.effort === 'string') {
        if (tune.efforts.includes(saved.effort)) mine.effort = saved.effort
        else this.log(`saved ${scope} effort ${saved.effort} ignored: not one of ${tune.efforts.join(', ')}`)
      }
      this.settings[scope] = mine
      tune.set(scope, mine)
    }
  }

  /** `!model` / `!effort`: no argument shows both scopes, `dm|server <value>` sets one. A value without a scope never writes. */
  private tuneCommand(kind: 'model' | 'effort', args: string[]): string {
    const tune = this.backend.tune
    if (!tune) return `This backend has no ${kind} setting.`
    const options = kind === 'model' ? tune.modelHint : tune.efforts.join('|')
    const usage = `Usage: \`!${kind} dm|server ${options}\``
    if (args.length === 0) return `${this.backend.name} ${kind}: DMs ${tune.get('dm')[kind]}, servers ${tune.get('server')[kind]}. ${usage}`
    const scope = args[0].toLowerCase()
    if (args.length !== 2 || !(SCOPES as readonly string[]).includes(scope)) return usage
    let value: string
    if (kind === 'model') {
      try {
        value = tune.resolveModel(args[1])
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    } else {
      value = args[1].toLowerCase()
      if (!tune.efforts.includes(value)) return usage
    }
    const sc = scope as Scope
    this.settings = { ...this.settings, [sc]: { ...this.settings[sc], [kind]: value } }
    writeJson(this.settingsFile, this.settings)
    tune.set(sc, this.settings[sc] ?? {})
    return `${this.backend.name} ${kind} for ${sc === 'dm' ? 'DMs' : 'servers'} is now ${value}, from the next turn (running conversations keep their history; the prompt cache restarts once).`
  }

  /** Only a bridge sharing the plugin's token has a plugin to fall back to. */
  private get fallback(): boolean {
    return this.bot.cfg.role === 'bridge-shared'
  }

  /**
   * Tells the plugin this bridge is alive, but only while the gateway is connected: the plugin takes guilds over once the file is
   * older than 90 s, and this bridge stops answering guilds at the same moment (see `beating`).
   */
  startHeartbeat(): void {
    if (!this.fallback) return
    this.beat = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
    this.beat.unref()
    this.heartbeat()
  }

  heartbeat(): void {
    if (!this.bot.connected) return
    try {
      writeJson(join(this.bot.cfg.stateDir, BRIDGE_STATE), { at: this.now(), pid: process.pid })
      this.lastBeat = this.now()
    } catch (e) {
      this.log(`heartbeat failed: ${e}`)
    }
  }

  /** False once the heartbeat is as old as the plugin takes it to be (a machine that slept, a lost gateway): the plugin has the guilds then, so this bridge must not answer them too. */
  private beating(): boolean {
    return this.beat == null || (this.lastBeat != null && this.now() - this.lastBeat < BRIDGE_STALE_MS)
  }

  /** A clean stop says so, so the plugin takes guilds over at once. */
  stop(): void {
    if (this.beat) clearInterval(this.beat)
    if (this.fallback) writeJson(join(this.bot.cfg.stateDir, BRIDGE_STATE), { stoppedAt: this.now() })
    this.beat = null
  }

  private markOut(reason: string, until: number): void {
    const first = this.out == null
    this.outGen++
    this.out = { reason, until }
    this.log(`servers go to the subscription: ${reason}`)
    if (first) this.notifyOwner(`Servers are now answered by your Claude Code session (subscription). ${reason}. They go back to the API by themselves once it works again.`)
  }

  /**
   * Hands a guild message to the plugin: a file named after the message, which the plugin claims by renaming it, then answers
   * with `<id>.accepted` or `<id>.declined` (a file beats a socket here: both processes already share this dir, and nothing is
   * lost if one restarts). False when nobody took it in time (no Claude Code session is running) or the plugin declined it.
   */
  private async handOff(msg: Message): Promise<boolean> {
    const dir = join(this.bot.cfg.stateDir, HANDOFF_DIR)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, msg.id)
    const [accepted, declined] = [`${file}.accepted`, `${file}.declined`]
    writeJson(file, { channel_id: msg.channel_id })
    try {
      for (let waited = 0; waited < this.handoffWaitMs; waited += 50) {
        if (existsSync(declined)) return false
        if (existsSync(accepted)) return true
        await new Promise(r => setTimeout(r, 50))
      }
      try {
        unlinkSync(file) // still there: nobody took it
      } catch {
        return true // claimed, no verdict yet: assume it is being answered
      }
      return false
    } finally {
      rmSync(accepted, { force: true })
      rmSync(declined, { force: true })
    }
  }

  /** A guild message the API will not answer goes to the plugin; without one (or past the hourly cap), the sender hears an error as before. */
  private async passOn(msg: Message, reason: string): Promise<void> {
    const capped = !this.hit(this.handoffHits, 'all', HANDOFFS_PER_HOUR, 3600_000)
    if (!capped && (await this.handOff(msg))) return
    this.log(`message ${msg.id} not handed to the plugin (${capped ? 'hourly cap' : 'nobody took it'}; ${reason})`)
    await this.say(msg, reason === BUDGET_REASON ? 'Monthly budget reached. Back next month.' : SORRY)
  }

  private log(line: string): void {
    this.bot.cfg.log(`vokko bridge: ${line}\n`)
  }

  private isOwner(userId: string): boolean {
    return this.bot.ownerId != null && userId === this.bot.ownerId
  }

  /**
   * The rights the current message carries for a model pause/unpause of `target`. A channel shares one
   * session, so the model may act on text an earlier member planted: owner/moderator rights count only
   * when the current message itself is the command "<verb> <@target>". The model acting on the author
   * themselves never gets more than member rights.
   */
  private async rightsAgainst(msg: Message, target: string, verbs: string): Promise<Role> {
    if (target === msg.author.id) return 'member'
    const role = await this.roleOf(msg.author.id, msg.guild_id)
    if (role === 'member') return role
    return isCommandFor(msg.content, verbs, target, this.bot.me?.id ?? null) ? role : 'member'
  }

  private async roleOf(userId: string, guildId: string | null): Promise<Role> {
    if (this.isOwner(userId)) return 'owner'
    if (guildId == null) return 'member'
    const bits = await this.bot.memberPermissions(guildId, userId)
    return bits != null && (bits & MODERATE_MEMBERS) !== 0n ? 'moderator' : 'member'
  }

  private link(msg: Message): string {
    return `${this.bot.cfg.apiUrl}/channels/${msg.guild_id ?? '@me'}/${msg.channel_id}/${msg.id}`
  }

  private notifyOwner(text: string): void {
    const owner = this.bot.ownerId
    if (owner) this.bot.dmUser(owner, text).catch(e => this.log(`owner notice failed: ${e}`))
  }

  private say(msg: Message, text: string): Promise<unknown> {
    return this.bot.send(msg.channel_id, text, msg.id).catch(e => this.log(`send failed: ${e}`))
  }

  // ---- usage ----

  private month(): Usage {
    const m = new Date(this.now()).toISOString().slice(0, 7)
    if (this.usage.month !== m) this.usage = { ...NO_USAGE, month: m }
    return this.usage
  }

  monthUsage(): Readonly<Usage> {
    return this.month()
  }

  /** Adds what a turn spent to the month. Running totals of the channel's session count only their growth. */
  private tally(key: string, s: Spent): void {
    const session = this.sessions[key]
    const same = s.cumulative === true && session != null && session.id === s.sessionId
    // A total below the last one was reset (a new or cleared session): it counts whole.
    const base = same && session.last && (s.costUsd ?? 0) >= (session.last.costUsd ?? 0) ? session.last : undefined
    const u = this.month()
    for (const f of TOTALS) u[f] += Math.max(0, (s[f] ?? 0) - (base?.[f] ?? 0))
    writeJson(this.usageFile, u)
    if (same) session.last = totalsOf(s)
  }

  /** Counts a hit; false when `id` already has `max` within `windowMs`. */
  private hit(map: Map<string, number[]>, id: string, max: number, windowMs: number): boolean {
    const now = this.now()
    const recent = (map.get(id) ?? []).filter(t => now - t < windowMs)
    const ok = recent.length < max
    if (ok) recent.push(now)
    map.set(id, recent)
    return ok
  }

  // ---- inbound ----

  async handle(msg: Message): Promise<void> {
    // Owner commands in DMs reach the bridge even when the plugin answers DMs.
    if (this.bot.isOwnerCommand(msg)) return this.ownerCommand(msg)
    if (msg.guild_id != null && !this.beating()) return
    if (msg.guild_id != null && GUILD_COMMAND_RE.test(msg.content) && (await this.guildCommand(msg))) return

    const access = await this.bot.admit(msg)
    if (!access) return
    const author = msg.author.id
    const allowlisted = access.allowFrom.includes(author)
    if (this.backend.allowlistedOnly && !allowlisted) return
    const ok = await this.mayAsk(msg, true)
    if (ok === false) return
    if (ok !== true) return this.passOn(msg, ok)

    const seen = this.recent.get(msg.channel_id) ?? new Map<string, number>()
    seen.set(author, this.now())
    this.recent.set(msg.channel_id, seen)

    const key = `${this.backend.name}:${msg.channel_id}`
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(() => this.answer(msg, key, allowlisted, access.ackReaction)).catch(e => this.log(`answer failed: ${e}`))
    this.queues.set(key, next)
    await next
  }

  /**
   * Pause, rate limit and budget. Checked when a message arrives (`count`: it counts toward the rate
   * limit) and again when its queued turn comes, so a burst queued before a pause or before the budget
   * ran out stops there. A string: the API is out for guild messages (the reason); the caller hands the message to the plugin.
   */
  private async mayAsk(msg: Message, count: boolean): Promise<boolean | string> {
    const author = msg.author.id
    const now = this.now()
    const paused = this.pauses.active(author, msg.guild_id ?? 'dm', now)
    if (paused) {
      if (!paused.noticed) {
        this.pauses.markNoticed(paused)
        await this.say(msg, `You're paused for ${Math.ceil((paused.until - now) / 60_000)} min.`)
      }
      return false
    }
    if (count && !this.isOwner(author) && !this.hit(this.hits, author, this.limits.perHour, 3600_000)) {
      if ((this.rateNoticed.get(author) ?? 0) <= now) {
        const oldest = Math.min(...(this.hits.get(author) ?? [now]))
        this.rateNoticed.set(author, oldest + 3600_000)
        await this.say(msg, `You've reached the limit of ${this.limits.perHour} messages an hour. Try again in ${Math.ceil((oldest + 3600_000 - now) / 60_000)} min.`)
      }
      return false
    }
    const budgetHit = this.backend.metered && this.month().costUsd >= this.limits.monthlyUsd
    if (msg.guild_id != null && this.fallback) {
      if (budgetHit && !(this.out && now < this.out.until)) {
        const d = new Date(now)
        this.markOut(BUDGET_REASON, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
      }
      if (this.out && now < this.out.until) return this.out.reason
    } else if (budgetHit) {
      await this.say(msg, 'Monthly budget reached. Back next month.')
      return false
    }
    return true
  }

  prompt(msg: Message, allowlisted: boolean): string {
    const a = msg.author
    const atts = msg.attachments.map(att => `${safeAttName(att)} (${att.content_type ?? 'unknown'}, ${(att.size / 1024).toFixed(0)}KB)`)
    // The body can't close or forge the envelope; the attributes come from the server, not the sender.
    const body = msg.content.replace(/<(\/?)vokko-message/gi, '‹$1vokko-message')
    const tags = [
      `user_id="${a.id}"`,
      `user="${attr(a.username)}"`,
      a.global_name ? `display_name="${attr(a.global_name)}"` : '',
      this.isOwner(a.id) ? 'owner="true"' : '',
      // Someone the owner never paired: a member of an opted-in channel, untrusted.
      allowlisted ? '' : 'untrusted="true"',
      msg.guild_id ? 'place="server channel"' : 'place="direct message"',
      atts.length > 0 ? `attachments="${attr(atts.join('; '))}"` : '',
    ].filter(Boolean)
    return `<vokko-message ${tags.join(' ')}>\n${body}\n</vokko-message>`
  }

  private async answer(msg: Message, key: string, allowlisted: boolean, ackReaction?: string): Promise<void> {
    const ok = await this.mayAsk(msg, false)
    if (ok === false) return
    if (ok !== true) return this.passOn(msg, ok)
    const gen = this.outGen
    const turn = { authorPaused: false }
    const ctx = this.turnContext(msg, turn)
    if (ackReaction) this.bot.react(msg.channel_id, msg.id, ackReaction).catch(() => {})
    this.bot.typing(msg.channel_id)
    const typing = setInterval(() => this.bot.typing(msg.channel_id), 8000)
    const old = this.sessions[key]
    if (old && (this.now() - old.at > SESSION_MAX_AGE_MS || old.turns >= SESSION_MAX_TURNS)) delete this.sessions[key]
    const prompt = this.prompt(msg, allowlisted)
    const ask = async (sid: string | undefined) => {
      try {
        return await this.backend.ask(sid, prompt, ctx)
      } catch (err) {
        if (err instanceof BackendError) this.tally(key, err.spent)
        throw err
      }
    }
    let ans: Answer
    try {
      const sid = this.sessions[key]?.id
      try {
        ans = await ask(sid)
      } catch (err) {
        // A session the backend no longer has (deleted, other machine): start over once.
        if (!sid || err instanceof UserFacingError || !/session|conversation|thread|not found|no such/i.test(String(err))) throw err
        this.log(`session ${sid} for ${key} could not be resumed, starting a new one: ${err}`)
        delete this.sessions[key]
        ans = await ask(undefined)
      }
    } catch (err) {
      this.log(`${this.backend.name} failed for ${key}: ${err}`)
      writeJson(this.sessionsFile, this.sessions)
      // Not the sender's doing: the plugin answers this message and the next ones for a while.
      const down = msg.guild_id != null && this.fallback && !(err instanceof UserFacingError) && !turn.authorPaused ? failureClass(err) : null
      if (down) {
        this.markOut(down, this.now() + COOLDOWN_MS)
        return this.passOn(msg, down)
      }
      if (!turn.authorPaused) await this.say(msg, err instanceof UserFacingError ? err.message : SORRY)
      return
    } finally {
      clearInterval(typing)
    }
    this.tally(key, ans)
    // Only a turn that started after the latest markOut (the probe once the cooldown is over) shows the API works again.
    if (this.out && msg.guild_id != null && gen === this.outGen) {
      this.out = null
      this.notifyOwner('Servers are back on the API.')
    }
    const session = this.sessions[key]
    if (ans.keepSession === false) delete this.sessions[key]
    else if (session?.id === ans.sessionId) session.turns++
    else this.sessions[key] = { id: ans.sessionId, at: this.now(), turns: 1, last: ans.cumulative ? totalsOf(ans) : undefined }
    writeJson(this.sessionsFile, this.sessions)
    if (turn.authorPaused) return // the pause notice was the answer
    await this.bot.reply(msg.channel_id, ans.text.trim() || '(no reply)', msg.guild_id ? msg.id : undefined)
  }

  // ---- abuse guard: what the model's tools may do ----

  turnContext(msg: Message, turn: { authorPaused: boolean }): TurnContext {
    const author = msg.author.id
    let mediaCalls = 0
    return {
      scope: msg.guild_id == null ? 'dm' : 'server',
      // Same guards as a new message: a pause (including one the model just set on the author), the monthly budget, and a cap per reply.
      media: async (name, args) => {
        if (turn.authorPaused || this.pauses.active(author, msg.guild_id ?? 'dm', this.now())) return 'Not available: this person is paused.'
        if (this.backend.metered && this.month().costUsd >= this.limits.monthlyUsd) return 'Not available: the monthly budget is used up.'
        if (++mediaCalls > MEDIA_CALLS_PER_TURN) return 'Too many music/movie requests in one reply. Answer with what you have.'
        return runMediaTool(this.bot.cfg, asker(msg), name, args)
      },
      pause: async ({ user_id, minutes, reason }) => {
        const target = user_id == null || user_id === '' ? author : parseUserId(user_id)
        if (!target) return `not paused: "${user_id}" is not a user id`
        const role = await this.rightsAgainst(msg, target, PAUSE_VERB)
        const known = msg.guild_id ? ((await this.bot.members(msg.guild_id))?.some(m => m.user.id === target) ?? false) : target === author
        const last = this.recent.get(msg.channel_id)?.get(target) ?? 0
        const d = decide(
          {
            requester: { id: author, role },
            target,
            minutes,
            ownerId: this.bot.ownerId,
            botId: this.bot.me?.id ?? null,
            recent: target === author || this.now() - last < RECENT_MS,
            known,
          },
          this.pauses.priorPauses(target, this.now()),
        )
        if (!d.ok) return `not paused: ${d.error}`
        const why = String(reason ?? '').slice(0, 300)
        const p = this.pauses.add({ userId: target, scope: msg.guild_id ?? 'dm', minutes: d.minutes, reason: why, by: author }, this.now())
        if (target === author) {
          turn.authorPaused = true
          this.pauses.markNoticed(p)
          await this.say(msg, `You're paused for ${d.minutes} min.`)
        }
        this.notifyOwner(this.pauseNotice(p, msg, role))
        return `paused <@${target}> for ${d.minutes} minutes`
      },
      unpause: async ({ user_id }) => {
        const target = parseUserId(user_id)
        if (!target) return `not unpaused: "${user_id}" is not a user id`
        const role = await this.rightsAgainst(msg, target, UNPAUSE_VERB)
        if (role === 'member') return 'not unpaused: only the owner or a moderator can lift a pause, with a message that starts "unpause @person"'
        // Only pauses the model set, and only here: a `!pause` is lifted with `!unpause`.
        const n = this.pauses.remove(target, msg.guild_id ?? 'dm', false)
        return n > 0 ? `unpaused <@${target}>` : `<@${target}> has no pause here that I can lift (a !pause needs !unpause)`
      },
    }
  }

  private pauseNotice(p: Pause, msg: Message, role: Role): string {
    const where = msg.guild_id ? `server ${msg.guild_id}, channel <#${msg.channel_id}>` : 'a DM'
    const by = p.by === p.userId ? 'on its own judgment' : `asked by <@${p.by}> (${role})`
    return `${this.bot.cfg.botName} paused <@${p.userId}> for ${p.minutes} min in ${where}, ${by}.\nReason: ${p.reason || '(none)'}\n${this.link(msg)}`
  }

  // ---- commands ----

  private listPauses(): string {
    const now = this.now()
    const list = this.pauses.list(now)
    if (list.length === 0) return 'Nobody is paused.'
    return list.map(p => `<@${p.userId}> ${p.scope === '*' ? 'everywhere' : p.scope === 'dm' ? 'in DMs' : `in server ${p.scope}`}, ${Math.ceil((p.until - now) / 60_000)} min left: ${p.reason || '(no reason)'}`).join('\n')
  }

  /** `!pause <user> <minutes> [reason]` as `role` in `scope`; returns the reply. */
  private async manualPause(msg: Message, role: Role, args: string[], scope: string): Promise<string> {
    const target = parseUserId(args[0])
    const minutes = Number(args[1])
    if (!target || !Number.isFinite(minutes)) return 'Usage: `!pause @user <minutes> [reason]`'
    let known: boolean
    if (msg.guild_id) known = (await this.bot.members(msg.guild_id))?.some(m => m.user.id === target) ?? false
    else known = await this.bot.api('GET', `/users/${target}`).then(() => true, () => false)
    const d = decide(
      { requester: { id: msg.author.id, role }, target, minutes, ownerId: this.bot.ownerId, botId: this.bot.me?.id ?? null, recent: true, known },
      this.pauses.priorPauses(target, this.now()),
    )
    if (!d.ok) return `Not paused: ${d.error}.`
    const p = this.pauses.add({ userId: target, scope, minutes: d.minutes, reason: args.slice(2).join(' ').slice(0, 300), by: msg.author.id, manual: true }, this.now())
    if (role !== 'owner') this.notifyOwner(this.pauseNotice(p, msg, role))
    return `Paused <@${target}> for ${d.minutes} min${scope === '*' ? ' everywhere' : ''}.`
  }

  private serversNow(access: Access): string {
    if (access.guilds !== false) return 'subscription (guilds is on in access.json)'
    if (!this.out) return 'api'
    const wait = this.out.until - this.now()
    return `subscription (${this.out.reason}; the API is tried again ${wait > 0 ? `in ${Math.ceil(wait / 60_000)} min` : 'on the next server message'})`
  }

  private async ownerCommand(msg: Message): Promise<void> {
    const [cmd, ...args] = msg.content.trim().split(/\s+/)
    const role = this.bot.cfg.role
    let reply: string
    switch (cmd.toLowerCase()) {
      case '!backend': {
        const access = this.bot.loadAccess()
        const want = args[0]?.toLowerCase()
        if (role !== 'bridge-shared') reply = `This bridge runs on its own token: it answers every DM (${this.backend.name}).`
        else if (!want) reply = `DMs go to: ${access.dmBackend === 'api' ? 'api' : 'subscription'}. Servers go to: ${this.serversNow(access)}. Switch DMs with \`!backend api\` or \`!backend subscription\`.`
        else if (want !== 'api' && want !== 'subscription') reply = 'Usage: `!backend api` or `!backend subscription`'
        else if (this.bot.cfg.staticMode) reply = 'Access is static (VOKKO_ACCESS_MODE=static): edit access.json and restart.'
        else {
          this.bot.saveAccess({ ...access, dmBackend: want })
          reply = want === 'api' ? 'DMs now go to the API bridge.' : 'DMs now go to your Claude Code session (subscription).'
        }
        break
      }
      case '!model':
        reply = this.tuneCommand('model', args)
        break
      case '!effort':
        reply = this.tuneCommand('effort', args)
        break
      case '!pair': {
        const access = this.bot.loadAccess()
        const code = args[0]?.toLowerCase() ?? ''
        const p = access.pending[code]
        if (!p || p.expiresAt < this.now()) reply = `No pending pairing with code ${code || '(none)'}.`
        else if (this.bot.cfg.staticMode) reply = 'Access is static (VOKKO_ACCESS_MODE=static): edit access.json and restart.'
        else {
          if (!access.allowFrom.includes(p.senderId)) access.allowFrom.push(p.senderId)
          delete access.pending[code]
          this.bot.saveAccess(access)
          await this.bot.send(p.chatId, `Paired! Say hi to ${this.bot.cfg.botName}.`).catch(e => this.log(`pair confirm failed: ${e}`))
          reply = `Paired <@${p.senderId}>.`
        }
        break
      }
      case '!pause':
        reply = await this.manualPause(msg, 'owner', args, '*')
        break
      case '!unpause': {
        const target = parseUserId(args[0])
        reply = !target ? 'Usage: `!unpause @user`' : this.pauses.remove(target, '*') > 0 ? `Unpaused <@${target}>.` : `<@${target}> was not paused.`
        break
      }
      default:
        reply = this.listPauses()
    }
    await this.say(msg, reply)
  }

  /** `!pause` / `!unpause` (owner or MODERATE_MEMBERS) and `!pauses` (owner) in a channel this bridge answers. False: not a command here. */
  private async guildCommand(msg: Message): Promise<boolean> {
    const guild = msg.guild_id
    if (!guild) return false
    const access = this.bot.loadAccess()
    // Same ownership, opt-in and per-channel allowFrom as the gate, minus requireMention.
    if (!ownsGuilds(this.bot.cfg.role, access)) return false
    const policy = this.bot.policyFor(access, msg.channel_id)
    if (!policy) return false
    if (policy.allowFrom?.length && !policy.allowFrom.includes(msg.author.id)) return false
    // Each check below costs API calls: a flood of `!pause` is dropped first.
    if (!this.isOwner(msg.author.id) && !this.hit(this.commandHits, msg.author.id, 10, 10 * 60_000)) return true
    const role = await this.roleOf(msg.author.id, guild)
    if (role === 'member') return false
    const [cmd, ...args] = msg.content.trim().split(/\s+/)
    let reply: string
    switch (cmd.toLowerCase()) {
      case '!pause':
        reply = await this.manualPause(msg, role, args, guild)
        break
      case '!unpause': {
        const target = parseUserId(args[0])
        reply = !target ? 'Usage: `!unpause @user`' : this.pauses.remove(target, role === 'owner' ? '*' : guild) > 0 ? `Unpaused <@${target}>.` : `<@${target}> was not paused here.`
        break
      }
      default:
        if (role !== 'owner') return false
        reply = this.listPauses()
    }
    await this.say(msg, reply)
    return true
  }
}

const ENV_ALLOW = new Set(
  [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'LANG',
    'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  ],
)

/** A child process environment: what a program needs to run, plus `extra`. No inherited keys, tokens or config dirs. */
export function childEnv(extra: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && (ENV_ALLOW.has(k.toUpperCase()) || /^LC_/i.test(k))) out[k] = v
  return { ...out, ...extra }
}
