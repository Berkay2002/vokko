import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeApiBackend } from '../claude-api.ts'
import { LEAN, NOT_SIGNED_IN, codexBackend, leanOverrides, type McpServer } from '../codex.ts'
import { UserFacingError, type TurnContext } from '../core.ts'

const ctx: TurnContext = { pause: async () => 'paused', unpause: async () => 'unpaused' }
const dir = () => mkdtempSync(join(tmpdir(), 'vokko-backend-'))

describe('claude-api backend (Agent SDK stubbed at the module boundary)', () => {
  function stubbed(results: object[]) {
    const seen: { prompt: string; options: any }[] = []
    const query = ((p: { prompt: string; options: any }) => {
      seen.push(p)
      return (async function* () {
        yield { type: 'system', subtype: 'init' }
        for (const r of results) yield r
      })()
    }) as any
    const d = dir()
    process.env.SOME_HOST_SECRET = 'nope'
    const backend = claudeApiBackend({
      apiKey: 'sk-test',
      model: 'claude-sonnet-5-5',
      maxOutputTokens: 777,
      workDir: join(d, 'work'),
      configDir: join(d, 'cfg'),
      botName: 'Claude',
      ownerId: () => '100',
      webSearch: false,
      maxReplyUsd: 0.5,
      query,
    })
    return { backend, seen, d }
  }
  const ok = { type: 'result', subtype: 'success', is_error: false, result: 'hi!', session_id: 'sess-1', total_cost_usd: 0.012, usage: { input_tokens: 50, output_tokens: 9 } }

  test('no host access: no built-in tools, no host settings/MCP, only the two pause tools, own config dir, API key from options', async () => {
    const { backend, seen, d } = stubbed([ok])
    const a = await backend.ask(undefined, '<vokko-message ...>hi</vokko-message>', ctx)
    expect(a).toEqual({ text: 'hi!', sessionId: 'sess-1', costUsd: 0.012, inputTokens: 50, outputTokens: 9 })
    const o = seen[0].options
    expect(o.tools).toEqual([])
    expect(o.settingSources).toEqual([])
    expect(o.strictMcpConfig).toBe(true)
    expect(o.skills).toEqual([])
    expect(o.plugins).toEqual([])
    expect(Object.keys(o.mcpServers)).toEqual(['vokko'])
    expect(o.allowedTools).toEqual(['mcp__vokko__pause_user', 'mcp__vokko__unpause_user'])
    expect(o.permissionMode).toBe('dontAsk')
    expect(await o.canUseTool('Bash', {}, {})).toMatchObject({ behavior: 'deny' })
    expect(await o.canUseTool('mcp__vokko__pause_user', {}, {})).toMatchObject({ behavior: 'allow' })
    expect(o.model).toBe('claude-sonnet-5-5')
    expect(o.resume).toBeUndefined()
    expect(o.cwd).toBe(join(d, 'work'))
    expect(o.env.ANTHROPIC_API_KEY).toBe('sk-test')
    expect(o.env.CLAUDE_CONFIG_DIR).toBe(join(d, 'cfg'))
    expect(o.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('777')
    expect(o.env.SOME_HOST_SECRET).toBeUndefined()
    expect(o.systemPrompt).toContain('pause_user')
  })

  test('resumes the stored session and reports budget/turn overruns as a short reply', async () => {
    const { backend, seen } = stubbed([{ ...ok, subtype: 'error_max_budget_usd', is_error: true, errors: [] }])
    const a = await backend.ask('sess-1', 'x', ctx)
    expect(seen[0].options.resume).toBe('sess-1')
    expect(a.sessionId).toBe('sess-1')
    expect(a.costUsd).toBe(0.012)
    expect(a.text).toContain('too long')
  })

  test('an execution error throws (the bridge apologises and may start a new session)', async () => {
    const { backend } = stubbed([{ ...ok, subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: x'] }])
    await expect(backend.ask('x', 'y', ctx)).rejects.toThrow('No conversation found')
  })
})

describe('codex backend (Codex SDK stubbed at the module boundary)', () => {
  function stubbed(run: (input: string) => Promise<any>) {
    const made: any[] = []
    const threads: { kind: string; id?: string; options: any; inputs: string[] }[] = []
    class FakeCodex {
      constructor(o: any) {
        made.push(o)
      }
      startThread(options: any) {
        return thread('start', undefined, options)
      }
      resumeThread(id: string, options: any) {
        return thread('resume', id, options)
      }
    }
    function thread(kind: string, id: string | undefined, options: any): any {
      const t = { kind, id, options, inputs: [] as string[] }
      threads.push(t)
      return {
        get id() {
          return t.id ?? null
        },
        run: async (input: string) => {
          t.inputs.push(input)
          const r = await run(input)
          t.id ??= 'thread-1'
          return r
        },
      }
    }
    const listMcp = (o: string[]): McpServer[] => [{ name: 'github', enabled: !o.includes('mcp_servers.github.enabled=false') }]
    const backend = codexBackend({ workDir: join(dir(), 'work'), botName: 'Codex', Codex: FakeCodex as any, listMcp })
    return { backend, made, threads }
  }

  test('read-only, no network, approvals never, minimal env, house rules on a new thread only', async () => {
    process.env.OPENAI_API_KEY = 'should-not-pass'
    const { backend, made, threads } = stubbed(async () => ({ finalResponse: 'done', items: [], usage: { input_tokens: 5, output_tokens: 2 } }))
    const a = await backend.ask(undefined, 'hello', ctx)
    expect(a).toEqual({ text: 'done', sessionId: 'thread-1', inputTokens: 5, outputTokens: 2 })
    expect(threads[0].options).toMatchObject({ sandboxMode: 'read-only', networkAccessEnabled: false, approvalPolicy: 'never', webSearchMode: 'disabled', skipGitRepoCheck: true })
    expect(made[0].apiKey).toBeUndefined()
    expect(made[0].env.OPENAI_API_KEY).toBeUndefined()
    expect(made[0].env.CODEX_HOME).toBeUndefined()
    expect(made[0].configOverrides).toContain('features.hooks=false')
    expect(made[0].configOverrides).toContain('features.shell_tool=false')
    expect(made[0].configOverrides).toContain('mcp_servers.github.enabled=false')
    expect(backend.allowlistedOnly).toBe(true)
    expect(threads[0].inputs[0]).toStartWith('You are Codex')
    await backend.ask('thread-1', 'again', ctx)
    expect(threads[1]).toMatchObject({ kind: 'resume', id: 'thread-1' })
    expect(threads[1].inputs[0]).toBe('again')
  })

  test('not signed in → a user-facing "run codex login" error', async () => {
    const { backend } = stubbed(async () => {
      throw new Error('unexpected status 401 Unauthorized: Missing bearer or basic authentication in header')
    })
    const err = await backend.ask(undefined, 'hi', ctx).catch(e => e)
    expect(err).toBeInstanceOf(UserFacingError)
    expect(err.message).toBe(NOT_SIGNED_IN)
  })

  test('every MCP server the CLI reports is switched off, or the backend refuses to start', () => {
    const off = (o: string[], n: string) => o.includes(`mcp_servers.${n}.enabled=false`)
    expect(leanOverrides(o => [{ name: 'a', enabled: !off(o, 'a') }, { name: 'b', enabled: false }])).toEqual([...LEAN, 'mcp_servers.a.enabled=false'])
    expect(() => leanOverrides(() => [{ name: 'sticky', enabled: true }])).toThrow('still enabled')
    expect(() => leanOverrides(() => [{ name: 'my.server', enabled: true }])).toThrow('unusual name')
  })
})
