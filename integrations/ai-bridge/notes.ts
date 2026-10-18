/**
 * Per-channel notes that outlive a conversation: one small text file per scope in <stateDir>/notes/, a line per note,
 * newest last. A scope is a guild channel (a thread uses its parent, as the gate does) or `dm-<user id>`
 * (not `dm:`: a colon is not a valid file name on Windows). Written by the model's `remember` tool, read into the first prompt
 * of a new conversation, listed and cleared by the owner and moderators.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

/** A note is one line of at most this many characters. */
export const NOTE_MAX_CHARS = 200
/** A scope's file holds at most this many bytes; the oldest lines go first. */
export const NOTES_MAX_BYTES = 2048

// Controls, format characters (bidi, zero-width, Unicode tags, U+061C, U+180E), private use and unassigned, plus variation selectors (marks, but invisible).
const JUNK = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}︀-️\u{E0100}-\u{E01EF}]/gu

/** One line, no control or invisible characters; backticks and a `<vokko-` tag opener can't break out of a code block or the envelope. Cut by code point, never mid-character. */
export function cleanNote(s: unknown): string {
  const line = String(s ?? '')
    .replace(JUNK, ' ')
    .replace(/`/g, "'")
    .replace(/<(\/?)vokko-/gi, '‹$1vokko-')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(line).slice(0, NOTE_MAX_CHARS).join('').trim()
}

export class NoteStore {
  constructor(private readonly dir: string) {}

  private file(scope: string): string {
    return join(this.dir, `${scope.replace(/[^\w-]/g, '_')}.md`)
  }

  list(scope: string): string[] {
    try {
      return readFileSync(this.file(scope), 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  private save(scope: string, lines: string[]): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const file = this.file(scope)
    const tmp = file + '.tmp'
    writeFileSync(tmp, lines.map(l => l + '\n').join(''), { mode: 0o600 })
    renameSync(tmp, file)
  }

  /** Appends `note` (already clean); `added` false when this exact line is already there. Drops the oldest lines past the cap. */
  add(scope: string, note: string): { added: boolean; dropped: number } {
    const lines = this.list(scope)
    if (lines.includes(note)) return { added: false, dropped: 0 }
    lines.push(note)
    let dropped = 0
    while (lines.length > 1 && Buffer.byteLength(lines.join('\n') + '\n') > NOTES_MAX_BYTES) {
      lines.shift()
      dropped++
    }
    this.save(scope, lines)
    return { added: true, dropped }
  }

  /** Empties the scope; returns how many notes there were. */
  clear(scope: string): number {
    const n = this.list(scope).length
    rmSync(this.file(scope), { force: true })
    return n
  }
}
