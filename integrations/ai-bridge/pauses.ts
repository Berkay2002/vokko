/**
 * The abuse guard: who may pause whom, for how long, and the pauses themselves (persisted in
 * <stateDir>/pauses.json). A pause means the bot ignores that person; it is not a Vokko timeout.
 * Every rule lives here in code: the model only asks, and the code knows who really sent the
 * message being answered.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs'
import { dirname } from 'path'

export const MIN_MINUTES = 5
export const MAX_MINUTES = 1440
/** A plain member's request (or the model on its own) against someone else. */
export const MEMBER_MAX_MINUTES = 60
export const RECENT_MS = 15 * 60_000
export const REPEAT_MS = 7 * 24 * 60 * 60_000

export type Role = 'owner' | 'moderator' | 'member'

export type Pause = {
  userId: string
  /** A guild id, "dm" (DMs only) or "*" (everywhere: the owner's own pauses). */
  scope: string
  until: number
  minutes: number
  reason: string
  by: string
  at: number
  /** The paused person has had their one notice. */
  noticed: boolean
}

export type PauseRequest = {
  requester: { id: string; role: Role }
  target: string
  minutes: number
  ownerId: string | null
  botId: string | null
  /** The target sent the bot a message in this channel in the last 15 minutes. */
  recent: boolean
  /** The target resolves to a real member of the guild (in a DM: is the author). */
  known: boolean
}

export type Decision = { ok: true; minutes: number } | { ok: false; error: string }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? Math.round(n) : lo))

/** The targeting rules. `priorPauses`: how many times the target was paused in the last 7 days (each doubles). */
export function decide(req: PauseRequest, priorPauses: number): Decision {
  const { requester, target } = req
  // Fail closed: without knowing the owner and the bot, nobody can be sure not to pause them.
  if (req.ownerId == null || req.botId == null) return { ok: false, error: 'the bot does not know its owner yet, pausing is off' }
  if (target === req.ownerId) return { ok: false, error: 'the owner is never paused' }
  if (target === req.botId) return { ok: false, error: 'the bot never pauses itself' }
  if (!req.known) return { ok: false, error: `unknown user ${target}` }
  const other = target !== requester.id && requester.role === 'member'
  if (other && !req.recent) return { ok: false, error: 'only someone who messaged the bot in this channel in the last 15 minutes can be paused on this request' }
  let minutes = Math.min(clamp(req.minutes, MIN_MINUTES, MAX_MINUTES) * 2 ** Math.min(priorPauses, 10), MAX_MINUTES)
  if (other) minutes = Math.min(minutes, MEMBER_MAX_MINUTES)
  return { ok: true, minutes }
}

type File = { pauses: Pause[]; history: Record<string, number[]> }

export class PauseStore {
  private data: File

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<File>
      this.data = { pauses: parsed.pauses ?? [], history: parsed.history ?? {} }
    } catch {
      this.data = { pauses: [], history: {} }
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  private prune(now: number): void {
    const before = this.data.pauses.length
    this.data.pauses = this.data.pauses.filter(p => p.until > now)
    let changed = this.data.pauses.length !== before
    for (const [id, times] of Object.entries(this.data.history)) {
      const kept = times.filter(t => now - t < REPEAT_MS)
      if (kept.length !== times.length) {
        changed = true
        if (kept.length > 0) this.data.history[id] = kept
        else delete this.data.history[id]
      }
    }
    if (changed) this.save()
  }

  /** The pause that silences `userId` where `scope` applies ("*" pauses apply everywhere). */
  active(userId: string, scope: string, now = Date.now()): Pause | undefined {
    this.prune(now)
    return this.data.pauses.find(p => p.userId === userId && (p.scope === scope || p.scope === '*'))
  }

  priorPauses(userId: string, now = Date.now()): number {
    this.prune(now)
    return this.data.history[userId]?.length ?? 0
  }

  add(p: Omit<Pause, 'until' | 'at' | 'noticed'>, now = Date.now(), noticed = false): Pause {
    this.prune(now)
    const pause: Pause = { ...p, at: now, until: now + p.minutes * 60_000, noticed }
    this.data.pauses = this.data.pauses.filter(x => !(x.userId === p.userId && x.scope === p.scope))
    this.data.pauses.push(pause)
    ;(this.data.history[p.userId] ??= []).push(now)
    this.save()
    return pause
  }

  /** Lifts pauses of `userId`: in `scope` only, or every scope when scope is "*". Returns how many. */
  remove(userId: string, scope: string): number {
    const before = this.data.pauses.length
    this.data.pauses = this.data.pauses.filter(p => !(p.userId === userId && (scope === '*' || p.scope === scope)))
    const n = before - this.data.pauses.length
    if (n > 0) this.save()
    return n
  }

  markNoticed(p: Pause): void {
    const found = this.data.pauses.find(x => x.userId === p.userId && x.scope === p.scope && x.at === p.at)
    if (found && !found.noticed) {
      found.noticed = true
      this.save()
    }
  }

  list(now = Date.now()): Pause[] {
    this.prune(now)
    return [...this.data.pauses]
  }
}
