/**
 * The bridge between Vokko and one assistant backend (Claude API or Codex): routing on top of
 * the channel plugin's VokkoBot (same gate, pairing and access.json), owner and moderator
 * commands, the abuse guard, a per-user rate limit, a monthly cost tally with a soft cap, and
 * one persisted backend session per DM or guild channel.
 */

import { chmodSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { join } from 'path'
import { MODERATE_MEMBERS, ownsGuilds, safeAttName, type Message, type VokkoBot } from '../claude-channel/vokko.ts'
import { PauseStore, RECENT_MS, decide, type Pause, type Role } from './pauses.ts'

export type Answer = { text: string; sessionId: string; costUsd?: number; inputTokens?: number; outputTokens?: number }

/** What a backend's tools may ask the bridge for. Every rule is checked here, against the real author. */
export type TurnContext = {
  pause(args: { user_id?: string; minutes: number; reason: string }): Promise<string>
  unpause(args: { user_id: string }): Promise<string>
}

export interface Backend {
  /** Key prefix for sessions, e.g. "claude-api". */
  readonly name: string
  /** Costs money per reply: the monthly soft cap applies. */
  readonly metered: boolean
  /** Answers only allowlisted (paired) senders, never other members of an opted-in channel. */
  readonly allowlistedOnly?: boolean
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
  'cfg' | 'me' | 'ownerId' | 'admit' | 'reply' | 'send' | 'dmUser' | 'typing' | 'react' | 'loadAccess' | 'saveAccess' | 'members' | 'memberPermissions' | 'api' | 'gateKey' | 'isOwnerCommand'
>

const SNOWFLAKE = /^\d{1,20}$/
const GUILD_COMMAND_RE = /^\s*!(pause|unpause|pauses)\b/i

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

const attr = (s: string) => s.replace(/["<>\r\n]/g, '')

type Usage = { month: string; costUsd: number; inputTokens: number; outputTokens: number }

export class Bridge {
  readonly pauses: PauseStore
  private readonly sessionsFile: string
  private readonly usageFile: string
  private readonly sessions: Record<string, string>
  private usage: Usage
  private readonly hits = new Map<string, number[]>()
  private readonly rateNoticed = new Map<string, number>()
  /** channel id → user id → when they last sent the bot a delivered message there. */
  private readonly recent = new Map<string, Map<string, number>>()
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly bot: BotLike,
    private readonly backend: Backend,
    private readonly limits: Limits,
    private readonly now: () => number = Date.now,
  ) {
    const dir = bot.cfg.stateDir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700) // an existing dir keeps its old mode otherwise
    this.pauses = new PauseStore(join(dir, 'pauses.json'))
    this.sessionsFile = join(dir, `sessions-${backend.name}.json`)
    this.usageFile = join(dir, `usage-${backend.name}.json`)
    this.sessions = readJson<Record<string, string>>(this.sessionsFile, {})
    this.usage = readJson<Usage>(this.usageFile, { month: '', costUsd: 0, inputTokens: 0, outputTokens: 0 })
  }

  private log(line: string): void {
    this.bot.cfg.log(`vokko bridge: ${line}\n`)
  }

  private isOwner(userId: string): boolean {
    return this.bot.ownerId != null && userId === this.bot.ownerId
  }

  /**
   * The rights the current message carries against `target`. A guild channel shares one session, so the
   * model may act on text an earlier member planted: owner/moderator rights against someone else count only
   * when the current message itself names that person.
   */
  private async rightsAgainst(msg: Message, target: string): Promise<Role> {
    const role = await this.roleOf(msg.author.id, msg.guild_id)
    if (role === 'member' || target === msg.author.id) return role
    return new RegExp(`(^|\\D)${target}(\\D|$)`).test(msg.content) ? role : 'member'
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
    if (this.usage.month !== m) this.usage = { month: m, costUsd: 0, inputTokens: 0, outputTokens: 0 }
    return this.usage
  }

  monthUsage(): Readonly<Usage> {
    return this.month()
  }

  private tally(a: Answer): void {
    const u = this.month()
    u.costUsd += a.costUsd ?? 0
    u.inputTokens += a.inputTokens ?? 0
    u.outputTokens += a.outputTokens ?? 0
    writeJson(this.usageFile, u)
  }

  /** Counts the message; false when the user is over the hourly limit. */
  private rateOk(userId: string): boolean {
    const now = this.now()
    const recent = (this.hits.get(userId) ?? []).filter(t => now - t < 3600_000)
    if (recent.length >= this.limits.perHour) {
      this.hits.set(userId, recent)
      return false
    }
    recent.push(now)
    this.hits.set(userId, recent)
    return true
  }

  // ---- inbound ----

  async handle(msg: Message): Promise<void> {
    // Owner commands in DMs reach the bridge even when the plugin answers DMs.
    if (this.bot.isOwnerCommand(msg)) return this.ownerCommand(msg)
    if (msg.guild_id != null && GUILD_COMMAND_RE.test(msg.content) && (await this.guildCommand(msg))) return

    const access = await this.bot.admit(msg)
    if (!access) return
    const author = msg.author.id
    const allowlisted = access.allowFrom.includes(author)
    if (this.backend.allowlistedOnly && !allowlisted) return
    const scope = msg.guild_id ?? 'dm'
    const now = this.now()

    const paused = this.pauses.active(author, scope, now)
    if (paused) {
      if (!paused.noticed) {
        this.pauses.markNoticed(paused)
        await this.say(msg, `You're paused for ${Math.ceil((paused.until - now) / 60_000)} min.`)
      }
      return
    }

    if (!this.isOwner(author) && !this.rateOk(author)) {
      if ((this.rateNoticed.get(author) ?? 0) <= now) {
        const oldest = Math.min(...(this.hits.get(author) ?? [now]))
        this.rateNoticed.set(author, oldest + 3600_000)
        await this.say(msg, `You've reached the limit of ${this.limits.perHour} messages an hour. Try again in ${Math.ceil((oldest + 3600_000 - now) / 60_000)} min.`)
      }
      return
    }

    if (this.backend.metered && this.month().costUsd >= this.limits.monthlyUsd) {
      await this.say(msg, 'Monthly budget reached. Back next month.')
      return
    }

    const seen = this.recent.get(msg.channel_id) ?? new Map<string, number>()
    seen.set(author, now)
    this.recent.set(msg.channel_id, seen)

    const key = `${this.backend.name}:${msg.channel_id}`
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(() => this.answer(msg, key, allowlisted, access.ackReaction)).catch(e => this.log(`answer failed: ${e}`))
    this.queues.set(key, next)
    await next
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
    const turn = { authorPaused: false }
    const ctx = this.turnContext(msg, turn)
    if (ackReaction) this.bot.react(msg.channel_id, msg.id, ackReaction).catch(() => {})
    this.bot.typing(msg.channel_id)
    const typing = setInterval(() => this.bot.typing(msg.channel_id), 8000)
    let ans: Answer
    try {
      const prompt = this.prompt(msg, allowlisted)
      const sid = this.sessions[key]
      try {
        ans = await this.backend.ask(sid, prompt, ctx)
      } catch (err) {
        // A session the backend no longer has (deleted, other machine): start over once.
        if (!sid || err instanceof UserFacingError || !/session|conversation|thread|not found|no such/i.test(String(err))) throw err
        this.log(`session ${sid} for ${key} could not be resumed, starting a new one: ${err}`)
        ans = await this.backend.ask(undefined, prompt, ctx)
      }
    } catch (err) {
      this.log(`${this.backend.name} failed for ${key}: ${err}`)
      if (!turn.authorPaused) await this.say(msg, err instanceof UserFacingError ? err.message : 'Sorry, something went wrong. Try again in a bit.')
      return
    } finally {
      clearInterval(typing)
    }
    this.sessions[key] = ans.sessionId
    writeJson(this.sessionsFile, this.sessions)
    this.tally(ans)
    if (turn.authorPaused) return // the pause notice was the answer
    await this.bot.reply(msg.channel_id, ans.text.trim() || '(no reply)', msg.guild_id ? msg.id : undefined)
  }

  // ---- abuse guard: what the model's tools may do ----

  turnContext(msg: Message, turn: { authorPaused: boolean }): TurnContext {
    const author = msg.author.id
    return {
      pause: async ({ user_id, minutes, reason }) => {
        const target = user_id == null || user_id === '' ? author : parseUserId(user_id)
        if (!target) return `not paused: "${user_id}" is not a user id`
        const role = await this.rightsAgainst(msg, target)
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
        const role = await this.rightsAgainst(msg, target)
        if (role === 'member') return 'not unpaused: only the owner or a moderator can lift a pause, in a message that names that person'
        const n = this.pauses.remove(target, role === 'owner' ? '*' : (msg.guild_id ?? 'dm'))
        return n > 0 ? `unpaused <@${target}>` : `<@${target}> was not paused here`
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
    const p = this.pauses.add({ userId: target, scope, minutes: d.minutes, reason: args.slice(2).join(' ').slice(0, 300), by: msg.author.id }, this.now())
    if (role !== 'owner') this.notifyOwner(this.pauseNotice(p, msg, role))
    return `Paused <@${target}> for ${d.minutes} min${scope === '*' ? ' everywhere' : ''}.`
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
        else if (!want) reply = `DMs go to: ${access.dmBackend === 'api' ? 'api' : 'subscription'}. Switch with \`!backend api\` or \`!backend subscription\`.`
        else if (want !== 'api' && want !== 'subscription') reply = 'Usage: `!backend api` or `!backend subscription`'
        else if (this.bot.cfg.staticMode) reply = 'Access is static (VOKKO_ACCESS_MODE=static): edit access.json and restart.'
        else {
          this.bot.saveAccess({ ...access, dmBackend: want })
          reply = want === 'api' ? 'DMs now go to the API bridge.' : 'DMs now go to your Claude Code session (subscription).'
        }
        break
      }
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
    const policy = access.groups[this.bot.gateKey(msg.channel_id)]
    if (!policy) return false
    if (policy.allowFrom?.length && !policy.allowFrom.includes(msg.author.id)) return false
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
