#!/usr/bin/env bun
/**
 * vokko-ai-bridge: a Vokko bot answered by the Claude API (VOKKO_AI_BACKEND=claude-api) or by the
 * host's Codex login (VOKKO_AI_BACKEND=codex). See README.md.
 *
 * claude-api defaults to the channel plugin's state dir and token (~/.claude/channels/vokko) and
 * takes exactly what the plugin hands off: guild messages when access.json says guilds false,
 * DMs when dmBackend is "api". codex defaults to its own dir (~/.vokko/codex) and bot, and
 * answers everything its access.json allows.
 */

import { homedir } from 'os'
import { join } from 'path'
import { VokkoBot, loadConfig } from '../claude-channel/vokko.ts'
import { Bridge, type Backend } from './core.ts'
import { claudeApiBackend } from './claude-api.ts'
import { codexBackend } from './codex.ts'

const log = (line: string) => void process.stderr.write(line)
const backendName = process.env.VOKKO_AI_BACKEND ?? 'claude-api'
if (backendName !== 'claude-api' && backendName !== 'codex') {
  log(`vokko bridge: VOKKO_AI_BACKEND must be claude-api or codex, not ${backendName}\n`)
  process.exit(1)
}
// Read before loadConfig: the key comes from the host environment only, never from the state dir's .env.
const apiKey = process.env.ANTHROPIC_API_KEY ?? ''

const codex = backendName === 'codex'
const stateDir = process.env.VOKKO_STATE_DIR ?? (codex ? join(homedir(), '.vokko', 'codex') : join(homedir(), '.claude', 'channels', 'vokko'))
const shared = (process.env.VOKKO_BRIDGE_ROLE ?? (codex ? 'standalone' : 'shared')) === 'shared'
if (codex) process.env.VOKKO_BOT_NAME ||= 'Codex'
const cfg = loadConfig(stateDir, '/vokko:access pair', log, shared ? 'bridge-shared' : 'bridge')

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

process.on('unhandledRejection', err => log(`vokko bridge: unhandled rejection: ${err}\n`))
process.on('uncaughtException', err => log(`vokko bridge: uncaught exception: ${err}\n`))

let bridge: Bridge | null = null
const bot = new VokkoBot(cfg, msg => {
  bridge?.handle(msg).catch(e => log(`vokko bridge: handle failed: ${e}\n`))
})

let backend: Backend
if (codex) {
  backend = codexBackend({ workDir: join(stateDir, 'codex-work'), botName: cfg.botName, model: process.env.VOKKO_AI_MODEL || undefined, codexPath: process.env.VOKKO_CODEX_PATH || undefined })
} else {
  if (!apiKey) {
    const inFile = process.env.ANTHROPIC_API_KEY ? ' (the one in the state dir .env is ignored)' : ''
    log(`vokko bridge: ANTHROPIC_API_KEY must be set in this process's environment for the claude-api backend${inFile}\n`)
    process.exit(1)
  }
  backend = claudeApiBackend({
    apiKey,
    model: process.env.VOKKO_AI_MODEL || 'claude-sonnet-5-5',
    maxOutputTokens: num('VOKKO_AI_MAX_OUTPUT_TOKENS', 1024),
    maxReplyUsd: num('VOKKO_AI_MAX_REPLY_USD', 0.5),
    workDir: join(stateDir, 'api-work'),
    configDir: join(stateDir, 'api-claude'),
    botName: cfg.botName,
    ownerId: () => bot.ownerId,
    webSearch: process.env.VOKKO_AI_WEB_SEARCH === '1',
  })
}

bridge = new Bridge(bot, backend, { perHour: num('VOKKO_AI_RATE_PER_HOUR', 20), monthlyUsd: num('VOKKO_AI_MONTHLY_USD', 150) })
// A shared bridge leaves /vokko:access approvals to the plugin (one "Paired!" message, not two).
bot.start(!shared)
log(`vokko bridge: ${backend.name}, ${shared ? 'sharing the plugin token' : 'own token'}, state ${stateDir}\n`)

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log('vokko bridge: shutting down\n')
  bot.stop()
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
