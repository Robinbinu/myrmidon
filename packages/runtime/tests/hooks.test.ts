import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookStore, hookToolInput, matches, runHooks } from '../src/hooks.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-hooks-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('matchers take tool names, globs and regexes, and Claude Code names', () => {
  expect(matches(undefined, 'shell')).toBe(true)
  expect(matches('*', 'fs_edit')).toBe(true)
  expect(matches('Bash', 'shell')).toBe(true)
  expect(matches('Edit|Write', 'fs_write')).toBe(true)
  expect(matches('Edit|Write', 'fs_read')).toBe(false)
  expect(matches('mcp__*', 'mcp__github_search')).toBe(true)
  expect(matches('browser_.*', 'browser_click')).toBe(true)
})

test('hooks block before a tool, ask, and tell the agent after it, as in Claude Code', async () => {
  const pre = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command' as const,
              command: 'grep -q "rm -rf" && { echo "no rm -rf" >&2; exit 2; } || exit 0',
            },
          ],
        },
        {
          matcher: 'Write',
          hooks: [
            {
              type: 'command' as const,
              command: `echo '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"writes need a look"}}'`,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Edit',
          hooks: [
            { type: 'command' as const, command: 'cat > input.json; echo "lint: 2 errors" >&2; exit 2' },
          ],
        },
      ],
    },
  }
  const blocked = await runHooks(pre, 'PreToolUse', 'shell', { tool_input: { command: 'rm -rf /' } }, dir, {})
  expect(blocked.blocked).toBe('no rm -rf')
  const fine = await runHooks(pre, 'PreToolUse', 'shell', { tool_input: { command: 'ls' } }, dir, {})
  expect(fine.blocked).toBeUndefined()
  expect(fine.runs).toHaveLength(1)
  expect((await runHooks(pre, 'PreToolUse', 'fs_write', {}, dir, {})).ask).toBe('writes need a look')
  // Tools nothing matches run no hooks.
  expect((await runHooks(pre, 'PreToolUse', 'web_search', {}, dir, {})).runs).toHaveLength(0)

  const after = await runHooks(pre, 'PostToolUse', 'fs_edit', { tool_name: 'fs_edit' }, dir, {})
  expect(after.feedback).toEqual(['lint: 2 errors'])
  expect(JSON.parse(readFileSync(join(dir, 'input.json'), 'utf8'))).toEqual({ tool_name: 'fs_edit' })
})

test('a slow hook times out without hanging the tool', async () => {
  const config = {
    hooks: { PreToolUse: [{ hooks: [{ type: 'command' as const, command: 'sleep 5', timeout: 0.3 }] }] },
  }
  const r = await runHooks(config, 'PreToolUse', 'shell', {}, dir, {})
  expect(r.runs[0]?.timedOut).toBe(true)
  expect(r.blocked).toBeUndefined()
})

test('the store keeps only well-formed hooks, and file tools get a file_path', () => {
  const store = new HookStore(dir)
  expect(store.read()).toEqual({ hooks: {} })
  const saved = store.write({
    hooks: {
      PostToolUse: [
        {
          matcher: 'Edit|Write',
          hooks: [{ type: 'command', command: 'prettier --write "$FILE"' }, { type: 'prompt' }],
        },
        { matcher: 'x', hooks: [] },
      ],
      Nonsense: [{ hooks: [{ type: 'command', command: 'echo' }] }],
    },
  })
  expect(saved).toEqual({
    hooks: {
      PostToolUse: [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'prettier --write "$FILE"' }] },
      ],
    },
  })
  expect(store.read()).toEqual(saved)
  expect(store.has('PostToolUse')).toBe(true)
  expect(store.has('PreToolUse')).toBe(false)
  expect(hookToolInput({ path: 'src/a.ts', old: 'x' }, '/proj')).toEqual({
    path: 'src/a.ts',
    old: 'x',
    file_path: '/proj/src/a.ts',
  })
})
