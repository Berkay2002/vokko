import { Codex } from '@openai/codex-sdk'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MEDIA_TOOLS } from '../../claude-channel/media.ts'
import { CLAUDE_EFFORTS, claudeApiBackend } from '../claude-api.ts'
import { CODEX_EFFORTS, LEAN, NOT_SIGNED_IN, cliListers, codexBackend, leanOverrides, type Listers } from '../codex.ts'
import { BackendError, UserFacingError, childEnv, parseEffort, type TurnContext } from '../core.ts'

const ctx: TurnContext = { scope: 'server', pause: async () => 'paused', unpause: async () => 'unpaused' }
const dmCtx: TurnContext = { ...ctx, scope: 'dm' }
const dir = () => mkdtempSync(join(tmpdir(), 'vokko-backend-'))

describe('claude-api backend (Agent SDK stubbed at the module boundary)', () => {
  function stubbed(results: object[], extra: { model?: string; effort?: string; dmModel?: string; dmEffort?: string; media?: boolean } = {}) {
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
      ...extra,
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
    expect(o.effort).toBe('low') // chat needs little reasoning: low unless told otherwise
    expect(o.resume).toBeUndefined()
    expect(o.cwd).toBe(join(d, 'work'))
    expect(o.env.ANTHROPIC_API_KEY).toBe('sk-test')
    expect(o.env.CLAUDE_CONFIG_DIR).toBe(join(d, 'cfg'))
    expect(o.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('777')
    expect(o.env.SOME_HOST_SECRET).toBeUndefined()
    expect(o.systemPrompt).toContain('pause_user')
  })

  test('Spotify and Stremio tools: offered (and allowed by name) only with the bridge hook and VOKKO_AI_MEDIA not off', async () => {
    const withMedia: TurnContext = { ...ctx, media: async () => 'ok' }
    const on = stubbed([ok])
    await on.backend.ask(undefined, 'x', withMedia)
    const o = on.seen[0].options
    const names = MEDIA_TOOLS.map(t => `mcp__vokko__${t.name}`)
    expect(names).toContain('mcp__vokko__spotify_play')
    expect(names).toContain('mcp__vokko__stremio_play')
    expect(o.allowedTools).toEqual(['mcp__vokko__pause_user', 'mcp__vokko__unpause_user', ...names])
    expect(o.tools).toEqual([]) // still no built-in tools
    for (const n of names) expect(await o.canUseTool(n, {}, {})).toMatchObject({ behavior: 'allow' })
    expect(await o.canUseTool('mcp__vokko__spotify_wipe', {}, {})).toMatchObject({ behavior: 'deny' })
    expect(o.systemPrompt).toContain('confirm with the member first')
    for (const [label, s, c] of [['option off', stubbed([ok], { media: false }), withMedia], ['no hook', stubbed([ok]), ctx]] as const) {
      await s.backend.ask(undefined, 'x', c)
      expect([label, s.seen[0].options.allowedTools]).toEqual([label, ['mcp__vokko__pause_user', 'mcp__vokko__unpause_user']])
      expect(s.seen[0].options.systemPrompt).not.toContain('Spotify')
    }
  })

  test('remember: offered (and allowed by name, with a prompt line) only when the bridge gives the turn the hook', async () => {
    const saved: string[] = []
    const on = stubbed([ok])
    await on.backend.ask(undefined, 'x', { ...ctx, remember: async n => (saved.push(n), 'Saved.') })
    const o = on.seen[0].options
    expect(o.allowedTools).toEqual(['mcp__vokko__pause_user', 'mcp__vokko__unpause_user', 'mcp__vokko__remember'])
    expect(await o.canUseTool('mcp__vokko__remember', {}, {})).toMatchObject({ behavior: 'allow' })
    expect(o.systemPrompt).toContain('remember tool')
    expect(on.backend.notes).toBe(true)
    const off = stubbed([ok])
    await off.backend.ask(undefined, 'x', ctx)
    expect(off.seen[0].options.allowedTools).not.toContain('mcp__vokko__remember')
    expect(off.seen[0].options.systemPrompt).not.toContain('remember tool')
  })

  test('effort and model: aliases, per turn, and only values the SDK accepts', async () => {
    const { backend, seen } = stubbed([ok], { model: 'haiku', effort: 'medium' })
    await backend.ask(undefined, 'x', ctx)
    expect(seen[0].options).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
    backend.tune!.set('server', { model: backend.tune!.resolveModel('SONNET'), effort: 'high' })
    await backend.ask('sess-1', 'x', ctx) // a resumed session reads them too
    expect(seen[1].options).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', resume: 'sess-1' })
    expect(backend.tune!.resolveModel('claude-opus-5-5')).toBe('claude-opus-5-5')
    expect(() => backend.tune!.resolveModel('gpt-5')).toThrow(UserFacingError)
    expect(CLAUDE_EFFORTS).toEqual(['low', 'medium', 'high'])
  })

  test('DM turns use the DM model and effort, which follow the server values until set apart', async () => {
    const same = stubbed([ok], { model: 'haiku', effort: 'medium' })
    await same.backend.ask(undefined, 'x', dmCtx)
    expect(same.seen[0].options).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
    const apart = stubbed([ok], { effort: 'medium', dmModel: 'haiku', dmEffort: 'high' })
    await apart.backend.ask(undefined, 'x', dmCtx)
    await apart.backend.ask(undefined, 'x', ctx)
    expect(apart.seen[0].options).toMatchObject({ model: 'claude-haiku-5-5', effort: 'high' })
    expect(apart.seen[1].options).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
  })

  test('VOKKO_AI_EFFORT: unset is low, a listed value passes, anything else is refused with the choices', () => {
    expect(parseEffort(undefined, CLAUDE_EFFORTS)).toBe('low')
    expect(parseEffort(' High ', CLAUDE_EFFORTS)).toBe('high')
    expect(() => parseEffort('turbo', CLAUDE_EFFORTS)).toThrow('VOKKO_AI_EFFORT must be one of low, medium, high, not turbo')
    expect(() => parseEffort('minimal', CODEX_EFFORTS)).toThrow('VOKKO_AI_EFFORT')
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
  function stubbed(run: (input: string, codexOpts: any) => Promise<any>, model?: string, effort?: string, extra: { media?: boolean; listers?: Partial<Listers> } = {}) {
    const made: any[] = []
    const threads: { kind: string; id?: string; options: any; inputs: string[] }[] = []
    class FakeCodex {
      constructor(readonly o: any) {
        made.push(o)
      }
      startThread(options: any) {
        return thread('start', undefined, options, this.o)
      }
      resumeThread(id: string, options: any) {
        return thread('resume', id, options, this.o)
      }
    }
    function thread(kind: string, id: string | undefined, options: any, codexOpts: any): any {
      const t = { kind, id, options, inputs: [] as string[] }
      threads.push(t)
      return {
        get id() {
          return t.id ?? null
        },
        run: async (input: string) => {
          t.inputs.push(input)
          const r = await run(input, codexOpts)
          t.id ??= 'thread-1'
          return r
        },
      }
    }
    const listers: Listers = {
      mcp: o => [
        { name: 'github', enabled: !o.includes('mcp_servers.github.enabled=false') },
        ...(o.some(x => x.startsWith('mcp_servers.vokko_media.url=')) ? [{ name: 'vokko_media', enabled: true }] : []),
      ],
      features: o => [{ name: 'code_mode_host', enabled: !o.includes('features.code_mode_host=false') }],
      models: () => JSON.stringify({ models: [{ slug: 'm', tool_mode: 'code_mode_only', multi_agent_version: 'v2', apply_patch_tool_type: 'freeform', experimental_supported_tools: ['clock'] }] }),
      ...extra.listers,
    }
    const backend = codexBackend({ workDir: join(dir(), 'work'), botName: 'Codex', Codex: FakeCodex as any, listers, model, effort, media: extra.media })
    return { backend, made, threads }
  }

  /** One JSON-RPC call to a turn's media endpoint, as the codex CLI would make it. */
  async function mcpCall(codexOpts: any, method: string, params: object = {}): Promise<{ status: number; body: any }> {
    const url = JSON.parse(codexOpts.configOverrides.find((o: string) => o.startsWith('mcp_servers.vokko_media.url=')).split('=').slice(1).join('='))
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${codexOpts.env.VOKKO_MEDIA_BEARER}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  test('media tools: each turn gets its own endpoint, bound to that turn\'s asker, refused after the turn', async () => {
    const calls: { who: string; name: string; args: object }[] = []
    const asked = (who: string): TurnContext => ({ ...ctx, media: async (name, args) => (calls.push({ who, name, args }), `played for ${who}`) })
    let firstTurn: any
    const seen: any[] = []
    const { backend, made, threads } = stubbed(async (_input, o) => {
      // During the turn: the CLI (here, this fetch) lists the tools and calls one; the earlier turn's bearer is dead.
      seen.push(await mcpCall(o, 'tools/list'), await mcpCall(o, 'tools/call', { name: 'spotify_search', arguments: { q: 'nice' } }))
      if (firstTurn) seen.push(await mcpCall(firstTurn, 'tools/list'))
      else expect((await mcpCall(o, 'resources/list')).body.error.code).toBe(-32601) // nothing for Codex's resource readers
      firstTurn ??= o
      return { finalResponse: 'ok', items: [] }
    })
    await backend.ask(undefined, 'play something nice', asked('alice'))
    const o = made[1]
    expect(made[0].configOverrides.some((x: string) => x.includes('vokko_media'))).toBe(false) // the shared runner has no MCP server
    expect(made[0].env.VOKKO_MEDIA_BEARER).toBeUndefined()
    expect(o.configOverrides).toEqual(expect.arrayContaining(['mcp_servers.github.enabled=false', 'features.shell_tool=false', 'mcp_servers.vokko_media.enabled=true', 'mcp_servers.vokko_media.default_tools_approval_mode="approve"']))
    expect(o.configOverrides).toContain(`mcp_servers.vokko_media.enabled_tools=${JSON.stringify(MEDIA_TOOLS.map(t => t.name))}`)
    expect(o.env.VOKKO_MEDIA_BEARER).toMatch(/^[\w-]{43}$/)
    expect(JSON.stringify(o)).not.toContain('VOKKO_BOT_TOKEN')
    expect(threads[0].inputs[0]).toContain('spotify_* and stremio_* tools')
    expect(seen[0].body.result.tools.map((t: any) => t.name)).toEqual(MEDIA_TOOLS.map(t => t.name))
    expect(seen[0].body.result.tools.find((t: any) => t.name === 'spotify_search').inputSchema).toMatchObject({ type: 'object', required: ['q'] })
    expect(seen[0].body.result.tools.find((t: any) => t.name === 'spotify_play').inputSchema.properties.uris).toMatchObject({ type: 'array', items: { type: 'string' }, maxItems: 50 })
    expect(seen[1].body.result.content).toEqual([{ type: 'text', text: 'played for alice' }])
    expect(calls).toEqual([{ who: 'alice', name: 'spotify_search', args: { q: 'nice' } }])
    expect((await mcpCall(firstTurn, 'tools/list')).status).toBe(401) // turn over
    await backend.ask('thread-1', 'and for me', asked('bob'))
    expect(made[2].env.VOKKO_MEDIA_BEARER).not.toBe(o.env.VOKKO_MEDIA_BEARER)
    expect(seen[4].status).toBe(401) // the first turn's URL and bearer can't reach the second turn
    expect(calls.map(c => c.who)).toEqual(['alice', 'bob'])
  })

  test('media off (VOKKO_AI_MEDIA=off) or no hook: no MCP server, no extra runner, no media rules', async () => {
    for (const [label, s, c] of [
      ['option off', stubbed(async () => ({ finalResponse: '', items: [] }), undefined, undefined, { media: false }), { ...ctx, media: async () => 'x' }],
      ['no hook', stubbed(async () => ({ finalResponse: '', items: [] })), ctx],
    ] as const) {
      await s.backend.ask(undefined, 'x', c)
      expect([label, s.made.length]).toEqual([label, 1])
      expect(s.made[0].configOverrides.some((x: string) => x.includes('vokko_media'))).toBe(false)
      if (label === 'option off') expect(s.threads[0].inputs[0]).not.toContain('Spotify')
    }
  })

  test('media on: refuses to start when the host has a vokko_media server or another server stays on next to it', () => {
    const run = async () => ({})
    expect(() => stubbed(run, undefined, undefined, { listers: { mcp: () => [{ name: 'vokko_media', enabled: false }] } })).toThrow('already has an MCP server named vokko_media')
    const sticky = (o: string[]) => [{ name: 'vokko_media', enabled: true }, { name: 'sneaky', enabled: o.some(x => x.includes('vokko_media')) }].filter(s => s.enabled || !o.some(x => x.includes('vokko_media')))
    expect(() => stubbed(run, undefined, undefined, { listers: { mcp: o => (o.some(x => x.includes('vokko_media')) ? sticky(o) : []) } })).toThrow('not only vokko_media')
    expect(stubbed(run, undefined, undefined, { media: false, listers: { mcp: () => [{ name: 'vokko_media', enabled: false }] } }).backend).toBeDefined()
  })

  test('a model the catalog does not list: refuses to start; no model: the catalog\'s first', () => {
    expect(() => stubbed(async () => ({}), 'gpt-unknown')).toThrow('not in the CLI\'s model catalog')
    expect(stubbed(async () => ({ finalResponse: '', items: [] })).backend).toBeDefined()
  })

  test('effort defaults to low, the env value wins, model and effort changes reach resumed threads, !model only takes a catalog model', async () => {
    const run = async () => ({ finalResponse: 'done', items: [] })
    const d = stubbed(run)
    await d.backend.ask(undefined, 'a', ctx)
    expect(d.threads[0].options).toMatchObject({ model: 'm', modelReasoningEffort: 'low' })
    const e = stubbed(run, undefined, 'high')
    await e.backend.ask(undefined, 'a', ctx)
    expect(e.threads[0].options.modelReasoningEffort).toBe('high')
    e.backend.tune!.set('server', { effort: 'medium' })
    await e.backend.ask('thread-1', 'b', ctx)
    expect(e.threads[1]).toMatchObject({ kind: 'resume', options: { model: 'm', modelReasoningEffort: 'medium' } })
    await e.backend.ask('thread-1', 'c', dmCtx) // DMs keep their own effort
    expect(e.threads[2].options.modelReasoningEffort).toBe('high')
    expect(e.backend.tune!.resolveModel(' m ')).toBe('m')
    expect(() => e.backend.tune!.resolveModel('sonnet')).toThrow(/doesn't list "sonnet".*Listed: m/)
  })

  test('read-only, no network, approvals never, minimal env, house rules on a new thread only', async () => {
    process.env.OPENAI_API_KEY = 'should-not-pass'
    const { backend, made, threads } = stubbed(async () => ({ finalResponse: 'done', items: [], usage: { input_tokens: 5, output_tokens: 2 } }))
    const a = await backend.ask(undefined, 'hello', ctx)
    expect(a).toEqual({ text: 'done', sessionId: 'thread-1', inputTokens: 5, outputTokens: 2 })
    expect(threads[0].options).toMatchObject({ model: 'm', sandboxMode: 'read-only', networkAccessEnabled: false, approvalPolicy: 'never', webSearchMode: 'disabled', skipGitRepoCheck: true })
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

  /** The real SDK and CLI for one turn, the model provider pointed at a local capture endpoint (no login involved). */
  async function captured(c: TurnContext, respond: (n: number) => Response | null = () => null): Promise<any[]> {
    const bodies: any[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        bodies.push(await req.json().catch(() => null))
        return respond(bodies.length) ?? Response.json({ error: { message: 'capture only', type: 'invalid_request_error' } }, { status: 400 })
      },
    })
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
      await backend.ask(undefined, 'hi', c).catch(() => {})
    } finally {
      server.stop(true)
    }
    return bodies.filter(b => b?.input)
  }
  const offeredIn = (body: any): string[] => {
    const names = (tools: any[], pre = ''): string[] => tools.flatMap(t => (t.type === 'namespace' ? names(t.tools ?? [], `${pre}${t.name}.`) : [`${pre}${t.name ?? t.type}`]))
    return names([...(body.tools ?? []), ...body.input.filter((i: any) => i.type === 'additional_tools').flatMap((i: any) => i.tools)])
  }
  const sse = (events: object[]) => new Response(events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })

  test('live, no login needed: the real SDK and CLI offer the model no tool but request_user_input (Plan mode only)', async () => {
    const [body] = await captured(ctx)
    expect(body).toBeDefined()
    expect(offeredIn(body)).toEqual(['functions.request_user_input'])
  }, 120_000)

  test('live, no login needed: with the media hook, the model gets the media tools too (and Codex\'s MCP resource readers), and a call reaches ctx.media', async () => {
    const calls: [string, object][] = []
    const bodies = await captured({ ...ctx, media: async (name, args) => (calls.push([name, args]), 'Nothing is playing (test).') }, n =>
      // The "model" asks for spotify_now once, then the capture ends the turn.
      n === 1
        ? sse([
            { type: 'response.created', response: { id: 'r1' } },
            { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'c1', namespace: 'mcp__vokko_media', name: 'spotify_now', arguments: '{}' } },
            { type: 'response.completed', response: { id: 'r1', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
          ])
        : null,
    )
    // list/read_mcp_resource(s) come with any MCP server; the only one is ours, which has no resources (method not found).
    const resources = ['functions.list_mcp_resources', 'functions.list_mcp_resource_templates', 'functions.read_mcp_resource']
    expect(offeredIn(bodies[0]).sort()).toEqual([...resources, 'functions.request_user_input', ...MEDIA_TOOLS.map(t => `mcp__vokko_media.${t.name}`)].sort())
    expect(calls).toEqual([['spotify_now', {}]])
    expect(JSON.stringify(bodies[1]?.input)).toContain('Nothing is playing (test).')
  }, 120_000)
})
