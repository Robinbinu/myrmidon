import type { EvalCase } from './report.ts'

const SUM_TEST = `import { expect, test } from 'bun:test'
import { median } from './stats.ts'

test('median of an odd list', () => expect(median([3, 1, 2])).toBe(2))
test('median of an even list', () => expect(median([4, 1, 3, 2])).toBe(2.5))
test('median of one number', () => expect(median([7])).toBe(7))
`

/**
 * The standard prompts, one or more per pillar. Budgets are generous ceilings that flag runaways, not targets;
 * compare medians across reports to see whether a change made Myrmidon faster or slower.
 */
export const CASES: EvalCase[] = [
  {
    id: 'answer-life',
    pillar: 'answer',
    prompt: 'what is life',
    tiers: ['answer'],
    budget: { seconds: 120, tokens: 80_000 },
    checks: [{ kind: 'reply', label: 'answers in the chat', matches: /\b(living|organism|biolog|cell)/i }],
  },
  {
    id: 'answer-plugins',
    pillar: 'answer',
    prompt: 'can you create plugins and tools?',
    tiers: ['answer'],
    budget: { seconds: 120, tokens: 80_000 },
    checks: [{ kind: 'reply', label: 'describes its tools honestly', matches: /\b(tool|mcp|plugin)/i }],
  },
  {
    id: 'build-snake',
    pillar: 'build',
    prompt: 'build a snake game I can play in the browser',
    tiers: ['solo', 'team'],
    budget: { seconds: 600, tokens: 1_500_000 },
    checks: [
      {
        kind: 'artifact',
        label: 'publishes a playable page',
        name: /\.html?$/i,
        contains: /<canvas|requestAnimationFrame|setInterval/i,
      },
      { kind: 'judge', label: 'judge passes it' },
    ],
  },
  {
    id: 'research-rust',
    pillar: 'research',
    prompt: 'compare Rust web frameworks with sources',
    tiers: ['solo', 'team'],
    budget: { seconds: 900, tokens: 2_000_000 },
    checks: [
      { kind: 'tool', label: 'searches the web', used: /^web_(search|fetch)$|^browser_/ },
      {
        kind: 'reply',
        label: 'cites at least three sources',
        matches: /(https?:\/\/[^\s)]+[\s\S]*){3}/,
      },
      { kind: 'judge', label: 'judge passes it' },
    ],
  },
  {
    id: 'coding-fix-test',
    pillar: 'coding',
    prompt: 'The tests in this project fail. Find the bug and fix it without changing the tests.',
    tiers: ['solo', 'team'],
    modes: ['orchestrated'],
    budget: { seconds: 400, tokens: 800_000 },
    project: {
      'package.json': '{ "name": "stats-fixture", "private": true, "type": "module" }\n',
      'stats.ts':
        'export function median(xs: number[]): number {\n  const s = [...xs].sort()\n  const mid = Math.floor(s.length / 2)\n  return s.length % 2 ? s[mid]! : s[mid]!\n}\n',
      'stats.test.ts': SUM_TEST,
    },
    checks: [
      { kind: 'command', label: 'bun test passes', run: ['bun', 'test'] },
      { kind: 'unchanged', label: 'tests left alone', file: 'stats.test.ts' },
    ],
  },
  {
    id: 'browser-heading',
    pillar: 'browser',
    prompt: 'Open https://example.com in the browser and tell me the exact main heading on the page.',
    tiers: ['answer', 'solo'],
    modes: ['orchestrated'],
    budget: { seconds: 180, tokens: 150_000 },
    checks: [
      { kind: 'tool', label: 'uses the browser', used: /^browser_/ },
      { kind: 'reply', label: 'reports the heading', matches: /Example Domain/ },
    ],
  },
]
