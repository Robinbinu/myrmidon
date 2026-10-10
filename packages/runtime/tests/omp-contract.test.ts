import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_COMPACTION_SETTINGS,
  resolveBudgetReserveTokens,
  resolveThresholdTokens,
} from '../src/omp/agent-core.ts'
import { AssistantMessageEventStream, isContextOverflow, type } from '../src/omp/ai.ts'
import { parseMetricLines } from '../src/omp/autoresearch.ts'
import { getBundledModel, getBundledProviders } from '../src/omp/catalog.ts'
import { loadComputerSupervisor } from '../src/omp/computer.ts'
import { loadDap } from '../src/omp/dap.ts'
import { loadPythonPrelude, loadPythonRunner } from '../src/omp/eval.ts'
import { loadGithub } from '../src/omp/github.ts'
import { loadJfind } from '../src/omp/jfind.ts'
import { loadLsp } from '../src/omp/lsp.ts'
import { loadMcp } from '../src/omp/mcp.ts'
import { hasSubstantiveContent, redactMemorySecrets, stripMemoryTags } from '../src/omp/memory.ts'
import { createMockModel } from '../src/omp/mock.ts'
import * as natives from '../src/omp/natives.ts'
import { classifySource, isValidNameSegment, parseGitUrl, readTar, writeTar } from '../src/omp/plugins.ts'
import { loadImageResize, loadMarkit, loadSqliteReader, loadToolsManager } from '../src/omp/readers.ts'
import {
  parseRuleAgents,
  parseRuleConditionAndScope,
  sanitizeRuleName,
  TtsrManager,
} from '../src/omp/rules.ts'
import { pointOmpAt } from '../src/omp/runtime.ts'
import { CREDENTIAL_PATTERNS } from '../src/omp/security.ts'
import { ClaudeSessionStore, CodexSessionStore } from '../src/omp/sessions.ts'
import * as snapcompact from '../src/omp/snapcompact.ts'
import { buildSshTarget, quotePosixArgument, validateHostName, wrapInPosixShell } from '../src/omp/ssh.ts'
import { BINARY_SNIFF_BYTES, loadArchives, parseFrontmatter, parseImageMetadata } from '../src/omp/utils.ts'

// What Myrmidon relies on from each part of omp it uses, checked at the facade (src/omp/), so an omp upgrade that
// changes a shape fails here by name before it fails somewhere in a round. Types catch renames; these catch what
// types cannot: modules that no longer load, objects Myrmidon casts, and behaviour it builds on.

const home = mkdtempSync(join(tmpdir(), 'myr-omp-contract-'))
pointOmpAt(home)
afterAll(() => rmSync(home, { recursive: true, force: true }))

/** The names in `module` that are not functions (or constructors). */
const notFunctions = (module: object, names: readonly string[]) =>
  names.filter((n) => typeof (module as Record<string, unknown>)[n] !== 'function')

describe('pi-ai', () => {
  test("the scripted model answers in the message shape rounds read: text, then tool calls with 'toolUse'", async () => {
    const mock = createMockModel({
      responses: [
        { content: ['hello'] },
        { content: [{ type: 'toolCall', name: 'reply_user', arguments: { text: 'hi' } }] },
      ],
    })
    const context = { messages: [{ role: 'user' as const, content: 'hi', timestamp: 0 }] }
    const text = await mock.stream(mock.model, context).result()
    expect(text).toMatchObject({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'hello' }],
    })
    const call = await mock.stream(mock.model, context).result()
    expect(call.stopReason).toBe('toolUse')
    expect(call.content[0]).toMatchObject({ type: 'toolCall', name: 'reply_user', arguments: { text: 'hi' } })
  })

  test('an event stream Myrmidon fills itself ends with the message it is given', async () => {
    const out = new AssistantMessageEventStream()
    const message = { role: 'assistant', content: [], stopReason: 'stop' } as never
    out.push({ type: 'done', reason: 'stop', message })
    out.end()
    expect(await out.result()).toBe(message)
  })

  test("a provider's 'prompt is too long' reads as a context overflow", () => {
    const failed = { role: 'assistant', stopReason: 'error', content: [], errorMessage: 'prompt is too long' }
    expect(isContextOverflow(failed as never, 200_000)).toBe(true)
    expect(isContextOverflow({ ...failed, errorMessage: 'rate limited' } as never, 200_000)).toBe(false)
  })

  test("tool parameters are declared with omp's schema builder, which gives providers JSON Schema", () => {
    const params = type({ text: 'string', 'limit?': 'number' })
    expect(params.toJsonSchema()).toEqual({
      type: 'object',
      properties: { text: { type: 'string' }, limit: { type: 'number' } },
      required: ['text'],
    })
  })
})

describe('pi-agent-core', () => {
  test('compaction by default starts below the window and keeps a reserve for the summary', () => {
    const threshold = resolveThresholdTokens(200_000, DEFAULT_COMPACTION_SETTINGS)
    expect(threshold).toBeGreaterThan(100_000)
    expect(threshold).toBeLessThan(200_000)
    expect(resolveBudgetReserveTokens(200_000, DEFAULT_COMPACTION_SETTINGS)).toBeGreaterThan(0)
  })
})

describe('pi-catalog', () => {
  test('the bundled catalog knows the providers and their models, with context windows', () => {
    expect(getBundledProviders()).toContain('anthropic')
    const model = getBundledModel('anthropic' as never, 'claude-sonnet-4-5' as never)
    expect(model).toMatchObject({ provider: 'anthropic', api: 'anthropic-messages' })
    expect(model?.contextWindow).toBeGreaterThan(0)
  })
})

describe('pi-natives', () => {
  test('glob and grep find files and lines', async () => {
    const dir = join(home, 'natives')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.ts'), 'const needle = 1\n')
    const found = await natives.glob({ pattern: '**/*.ts', path: dir, fileType: natives.FileType.File })
    expect(found.matches.map((m) => m.path)).toEqual(['a.ts'])
    const lines = await natives.grep({ pattern: 'needle', path: dir, mode: natives.GrepOutputMode.Content })
    expect(lines.matches[0]).toMatchObject({ line: expect.stringContaining('needle') })
  })

  test('processes and terminals are there', () => {
    expect(notFunctions(natives, ['astEdit', 'astGrep', 'notebookToEditableText', 'pdfToMarkdown'])).toEqual(
      [],
    )
    expect(typeof natives.Process.fromPid).toBe('function')
    expect(typeof natives.PtySession).toBe('function')
  })
})

describe('snapcompact', () => {
  test('its budgets are numbers and its pieces are functions', () => {
    for (const n of [
      snapcompact.FRAME_DATA_BYTES_BUDGET,
      snapcompact.FRAME_TOKEN_ESTIMATE,
      snapcompact.MAX_FRAMES_DEFAULT,
    ])
      expect(n).toBeGreaterThan(0)
    const used = ['archiveSourceText', 'compact', 'createFileOps', 'frameDataBytes', 'getPreservedArchive']
    expect(
      notFunctions(snapcompact, [...used, 'historyBlocks', 'maxFramesForDataBudget', 'providerFrameBudget']),
    ).toEqual([])
    expect(
      notFunctions(snapcompact, ['resolveShapeForText', 'scanRenderability', 'serializeConversation']),
    ).toEqual([])
  })
})

describe('pi-utils', () => {
  test('frontmatter, binary sniffing and image headers', () => {
    expect(parseFrontmatter('---\nglobs: ["*.ts"]\n---\nbody\n', { source: 'a.md', level: 'off' })).toEqual({
      frontmatter: { globs: ['*.ts'] },
      body: 'body',
    })
    expect(BINARY_SNIFF_BYTES).toBeGreaterThan(0)
    const png = [
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
    ]
    expect(parseImageMetadata(new Uint8Array(png))).toMatchObject({
      mimeType: 'image/png',
      width: 1,
      height: 1,
    })
  })

  test('archives written are read back', async () => {
    const ar = await loadArchives()
    const zip = await ar.encodeArchive('zip', [['a.txt', 'one']])
    expect(ar.archiveFormatFromPath('x.zip')).toBe('zip')
    expect(notFunctions(ar, ['encodeArchive', 'archiveFormatFromPath'])).toEqual([])
    expect(zip.byteLength).toBeGreaterThan(0)
  })
})

describe('coding agent: tools loaded on first use', () => {
  test('lsp', async () => {
    const lsp = await loadLsp()
    expect(notFunctions(lsp.config, ['getConfig', 'getServersForFile', 'resolveCommand'])).toEqual([])
    const client = [
      'getOrCreateClient',
      'reconcileFileFromDisk',
      'refreshFile',
      'sendRequest',
      'setIdleTimeout',
    ]
    expect(notFunctions(lsp.client, [...client, 'waitForProjectLoaded'])).toEqual([])
    expect(notFunctions(lsp.diagnostics, ['normalizeLocationResult', 'waitForDiagnostics'])).toEqual([])
    expect(notFunctions(lsp.edits, ['applyTextEditsToString', 'flattenWorkspaceTextEdits'])).toEqual([])
    const file = join(home, 'a.ts')
    expect(lsp.utils.uriToFile(lsp.utils.fileToUri(file))).toBe(file)
  })

  test('dap', async () => {
    const dap = await loadDap()
    expect(typeof dap.client.DapClient).toBe('function')
    const config = [
      'getAdapterConfigs',
      'getAvailableAdapters',
      'resolveLaunchOverrides',
      'selectAttachAdapter',
    ]
    expect(notFunctions(dap.config, [...config, 'selectLaunchAdapter'])).toEqual([])
  })

  test('find', async () => {
    const j = await loadJfind()
    expect(notFunctions(j.lexical, ['fileScore', 'grepIndex', 'idf'])).toEqual([])
    const passages = ['mergeHeat', 'plainContent', 'rankedHeat', 'selectWindows', 'sketch', 'windows']
    expect(notFunctions(j.passages, passages)).toEqual([])
    const questions = ['entryKey', 'nameBatch', 'passageBatch', 'passageKey', 'sketchBatch']
    expect(notFunctions(j.questions, questions)).toEqual([])
    expect(notFunctions(j.text, ['lines', 'readText', 'takeChars'])).toEqual([])
    expect(notFunctions(j.tree, ['eligibleFile'])).toEqual([])
    expect(j.keywords.keywords('where are sessions saved', ['store'])).toEqual(
      expect.arrayContaining(['session', 'store']),
    )
  })

  test('github', async () => {
    const gh = await loadGithub()
    expect(gh.common.parseRepoRef('acme/tools')).toBeDefined()
    expect(
      notFunctions(gh.search, ['buildGhApiSearchArgs', 'composeSearchQuery', 'formatSearchResults']),
    ).toEqual([])
    expect(notFunctions(gh.view, ['formatIssueView', 'formatPrView', 'formatRepoView'])).toEqual([])
    const watch = ['formatRunWatchResult', 'normalizeRunSnapshot', 'parseRunReference', 'tailLogLines']
    expect(notFunctions(gh.watch, watch)).toEqual([])
  })

  test('mcp: the manager has every method Myrmidon calls on it (it is cast, so types do not check this)', async () => {
    const { MCPManager, CustomToolAdapter } = await loadMcp()
    const methods = [
      'connectServers',
      'getTools',
      'setOnToolsChanged',
      'waitForStartup',
      'getConnectionStatus',
    ]
    expect(notFunctions(MCPManager.prototype, [...methods, 'disconnectServer', 'disconnectAll'])).toEqual([])
    expect(typeof CustomToolAdapter).toBe('function')
  })

  test('readers', async () => {
    expect(typeof (await loadImageResize()).resizeImage).toBe('function')
    expect(typeof (await loadMarkit()).Markit).toBe('function')
    expect(
      notFunctions(await loadSqliteReader(), ['getTableSchema', 'listTables', 'renderTableList']),
    ).toEqual([])
    expect(typeof (await loadToolsManager()).getToolPath).toBe('function')
  })

  test('computer use', async () => {
    expect(typeof (await loadComputerSupervisor()).ComputerSupervisor).toBe('function')
  })

  test("Python cells: the prelude and omp's runner.py", async () => {
    expect((await loadPythonPrelude()).length).toBeGreaterThan(0)
    expect(await loadPythonRunner()).toContain('def ')
  })
})

describe('coding agent: loaded with the runtime', () => {
  test('ssh', () => {
    expect(quotePosixArgument("it's")).toBe(`'it'\\''s'`)
    expect(wrapInPosixShell('sh', 'echo hi')).toBe(`sh -c 'echo hi'`)
    expect(buildSshTarget('me', 'box')).toBe('me@box')
    expect(validateHostName('build-box')).toBeUndefined()
    expect(validateHostName('a b')).toBeString()
  })

  test('stream rules', () => {
    expect(sanitizeRuleName('No Force Push!')).toBe('no-force-push')
    expect(parseRuleConditionAndScope({ condition: 'git push --force' } as never).condition).toEqual([
      'git push --force',
    ])
    expect(parseRuleAgents(['main'])).toEqual(['main'])
    expect(
      notFunctions(TtsrManager.prototype, ['addRule', 'checkDelta', 'checkSnapshot', 'hasRules']),
    ).toEqual([])
  })

  test('plugin sources: git URLs, marketplace names, tarballs', () => {
    expect(parseGitUrl('github:acme/tools#v1')).toMatchObject({
      repo: 'https://github.com/acme/tools',
      ref: 'v1',
    })
    expect(parseGitUrl('https://github.com/acme/tools')).toMatchObject({
      repo: 'https://github.com/acme/tools',
    })
    expect(classifySource('acme/market')).toBe('github')
    expect(isValidNameSegment('tools')).toBe(true)
    expect(isValidNameSegment('../x')).toBe(false)
    const tar = writeTar([{ path: 'a/run.sh', content: new TextEncoder().encode('echo'), executable: true }])
    expect(readTar(tar)).toMatchObject([{ path: 'a/run.sh', executable: true }])
  })

  test('memory: secrets are redacted, injected memories stripped', () => {
    expect(redactMemorySecrets(`key sk-ant-api03-${'a'.repeat(90)}`)).not.toContain('sk-ant')
    expect(stripMemoryTags('<memories>old</memories>hi')).toBe('hi')
    expect(hasSubstantiveContent('ok')).toBe(true)
    expect(hasSubstantiveContent('  ')).toBe(false)
  })

  test("security scan: omp's credential shapes", () => {
    expect(CREDENTIAL_PATTERNS.length).toBeGreaterThan(0)
    for (const p of CREDENTIAL_PATTERNS) {
      expect(p).toMatchObject({ name: expect.any(String), source: expect.any(String) })
      expect(() => new RegExp(p.source, p.flags ?? '')).not.toThrow()
    }
  })

  test('autoresearch: METRIC lines', () => {
    expect([...parseMetricLines('METRIC score=1.5\nnoise\nMETRIC t=2')]).toEqual([
      ['score', 1.5],
      ['t', 2],
    ])
  })

  test('session import: the stores list and load', () => {
    for (const Store of [ClaudeSessionStore, CodexSessionStore])
      expect(notFunctions(Store.prototype, ['list', 'load'])).toEqual([])
  })
})
