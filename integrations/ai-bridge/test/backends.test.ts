import { Codex } from '@openai/codex-sdk'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { claudeApiBackend } from '../claude-api.ts'
import { LEAN, NOT_SIGNED_IN, cliListers, codexBackend, leanOverrides, type Listers } from '../codex.ts'
import { BackendError, UserFacingError, childEnv, type TurnContext } from '../core.ts'

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
  const ok = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'hi!',
    session_id: 'sess-1',
    total_cost_usd: 0.012,
    usage: { input_tokens: 50, output_tokens: 9 },
    modelUsage: {
      a: { inputTokens: 40, outputTokens: 9, cacheReadInputTokens: 300, cacheCreationInputTokens: 20, costUSD: 0.01 },
      b: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.002 },
    },
  }
  const totals = { sessionId: 'sess-1', cumulative: true, costUsd: 0.012, inputTokens: 50, outputTokens: 10, cacheReadTokens: 300, cacheWriteTokens: 20 }

  test('no host access: no built-in tools, no host settings/MCP, only the two pause tools, own config dir, API key from options', async () => {
    const { backend, seen, d } = stubbed([ok])
    const a = await backend.ask(undefined, '<vokko-message ...>hi</vokko-message>', ctx)
    expect(a).toEqual({ ...totals, text: 'hi!' })
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

  test('resumes the stored session; a budget/turn overrun is a short reply and drops the session', async () => {
    const { backend, seen } = stubbed([{ ...ok, subtype: 'error_max_budget_usd', is_error: true, errors: [] }])
    const a = await backend.ask('sess-1', 'x', ctx)
    expect(seen[0].options.resume).toBe('sess-1')
    expect(a.sessionId).toBe('sess-1')
    expect(a.costUsd).toBe(0.012)
    expect(a.keepSession).toBe(false)
    expect(a.text).toContain('too long')
  })

  test('an execution error throws with what it cost (the bridge counts it and may start a new session)', async () => {
    const { backend } = stubbed([{ ...ok, subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: x'] }])
    const err = await backend.ask('x', 'y', ctx).catch(e => e)
    expect(err).toBeInstanceOf(BackendError)
    expect(err.message).toContain('No conversation found')
    expect(err.spent).toEqual(totals)
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
    const listers: Listers = {
      mcp: o => [{ name: 'github', enabled: !o.includes('mcp_servers.github.enabled=false') }],
      features: o => [{ name: 'code_mode_host', enabled: !o.includes('features.code_mode_host=false') }],
      models: () => JSON.stringify({ models: [{ slug: 'm', tool_mode: 'code_mode_only', multi_agent_version: 'v2', apply_patch_tool_type: 'freeform', experimental_supported_tools: ['clock'] }] }),
    }
    const backend = codexBackend({ workDir: join(dir(), 'work'), botName: 'Codex', Codex: FakeCodex as any, listers })
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
    for (const f of ['code_mode', 'code_mode_host', 'js_repl']) expect(made[0].configOverrides).toContain(`features.${f}=false`)
    expect(made[0].configOverrides).toContain('mcp_servers.github.enabled=false')
    const catalogOverride = made[0].configOverrides.find((o: string) => o.startsWith('model_catalog_json='))
    const [model] = JSON.parse(readFileSync(JSON.parse(catalogOverride.slice('model_catalog_json='.length)), 'utf8')).models
    expect(model).toEqual({ slug: 'm', multi_agent_version: null, apply_patch_tool_type: null, experimental_supported_tools: [], node_repl_disabled: true, supports_search_tool: false })
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

  test('every MCP server and risky feature the CLI reports is switched off, or the backend refuses to start', () => {
    const off = (o: string[], key: string) => o.includes(key)
    const listers: Listers = {
      mcp: o => [{ name: 'a', enabled: !off(o, 'mcp_servers.a.enabled=false') }, { name: 'b', enabled: false }],
      features: o => [
        { name: 'brand_new_exec_thing', enabled: !off(o, 'features.brand_new_exec_thing=false') },
        { name: 'fast_mode', enabled: true },
      ],
      models: () => '{"models":[]}',
    }
    expect(leanOverrides(listers)).toEqual([...LEAN, 'features.brand_new_exec_thing=false', 'mcp_servers.a.enabled=false'])
    expect(() => leanOverrides({ ...listers, mcp: () => [{ name: 'sticky', enabled: true }] })).toThrow('MCP server sticky')
    expect(() => leanOverrides({ ...listers, features: () => [{ name: 'shell_tool', enabled: true }] })).toThrow('feature shell_tool')
    expect(() => leanOverrides({ ...listers, mcp: () => [{ name: 'my server', enabled: true }] })).toThrow('unusual name')
  })

  test("live, no login needed: the bundled codex CLI's own listings end with every risky feature and MCP server off", () => {
    const listers = cliListers(undefined, childEnv(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}))
    const overrides = leanOverrides(listers)
    const features = listers.features(overrides)
    const on = (f: string) => features.find(x => x.name === f)?.enabled === true
    // js_repl is "removed" in 0.163 (not listed); unified_exec stays on but only shapes the shell tool, which is off
    expect(['code_mode', 'code_mode_host', 'js_repl', 'shell_tool', 'apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent'].filter(on)).toEqual([])
    expect(listers.mcp(overrides).filter(m => m.enabled)).toEqual([])
  }, 60_000)

  test('live, no login needed: the real SDK and CLI offer the model no tool but request_user_input (Plan mode only)', async () => {
    const bodies: any[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        bodies.push(await req.json().catch(() => null))
        return Response.json({ error: { message: 'capture only', type: 'invalid_request_error' } }, { status: 400 })
      },
    })
    // The real Codex class, pointed at this capture endpoint instead of OpenAI (no login involved).
    class Captured extends Codex {
      constructor(o: any) {
        super({
          ...o,
          env: { ...o.env, CAPTURE_KEY: 'x' },
          configOverrides: [
            ...o.configOverrides,
            `model_providers.capture={name="capture",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",env_key="CAPTURE_KEY",request_max_retries=0,stream_max_retries=0}`,
            'model_provider="capture"',
          ],
        })
      }
    }
    try {
      const backend = codexBackend({ workDir: join(dir(), 'work'), botName: 'Codex', Codex: Captured as any })
      await backend.ask(undefined, 'hi', ctx).catch(() => {})
    } finally {
      server.stop(true)
    }
    const names = (tools: any[], pre = ''): string[] => tools.flatMap(t => (t.type === 'namespace' ? names(t.tools ?? [], `${pre}${t.name}.`) : [`${pre}${t.name ?? t.type}`]))
    const body = bodies.find(b => b?.input)
    expect(body).toBeDefined()
    const offered = names([...(body.tools ?? []), ...body.input.filter((i: any) => i.type === 'additional_tools').flatMap((i: any) => i.tools)])
    expect(offered).toEqual(['functions.request_user_input'])
  }, 120_000)
})
