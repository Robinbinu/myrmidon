import type { EvalCase } from './report.ts'
import { confirmation, formSite, shopSite, tableSite } from './sites.ts'

const SUM_TEST = `import { expect, test } from 'bun:test'
import { median } from './stats.ts'

test('median of an odd list', () => expect(median([3, 1, 2])).toBe(2))
test('median of an even list', () => expect(median([4, 1, 3, 2])).toBe(2.5))
test('median of one number', () => expect(median([7])).toBe(7))
`

const DATES_TEST = `import { expect, test } from 'bun:test'
import { daysBetween } from './dates.ts'

test('one day', () => expect(daysBetween('2026-01-01', '2026-01-02')).toBe(1))
test('across a month', () => expect(daysBetween('2026-01-30', '2026-02-02')).toBe(3))
test('backwards is negative', () => expect(daysBetween('2026-03-10', '2026-03-01')).toBe(-9))
`

const MONEY_TEST = `import { expect, test } from 'bun:test'
import { formatCents } from './money.ts'

test('thousands and cents', () => expect(formatCents(123456)).toBe('$1,234.56'))
test('whole dollars keep two decimals', () => expect(formatCents(500)).toBe('$5.00'))
test('negative amounts', () => expect(formatCents(-2599)).toBe('-$25.99'))
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
    id: 'coding-team-git',
    pillar: 'coding',
    prompt:
      'This project has two independent modules with failing tests: src/dates.ts and src/money.ts. Have two people fix them in parallel, one module each, without changing any test, and make sure the whole test suite passes.',
    tiers: ['team'],
    modes: ['orchestrated', 'swarm'],
    budget: { seconds: 480, tokens: 1_500_000 },
    git: true,
    project: {
      'package.json': '{ "name": "two-modules", "private": true, "type": "module" }\n',
      'src/dates.ts':
        "/** Days from a to b, both 'YYYY-MM-DD'. */\nexport function daysBetween(a: string, b: string): number {\n  return (Date.parse(b) - Date.parse(a)) / 3_600_000\n}\n",
      'src/dates.test.ts': DATES_TEST,
      'src/money.ts':
        '/** Formats cents as dollars, e.g. 123456 -> "$1,234.56". */\nexport function formatCents(cents: number): string {\n  return `$${cents / 100}`\n}\n',
      'src/money.test.ts': MONEY_TEST,
    },
    checks: [
      { kind: 'command', label: 'bun test passes', run: ['bun', 'test'] },
      { kind: 'unchanged', label: 'dates test left alone', file: 'src/dates.test.ts' },
      { kind: 'unchanged', label: 'money test left alone', file: 'src/money.test.ts' },
      {
        kind: 'command',
        label: 'repo still on main, nothing committed',
        run: [
          'sh',
          '-c',
          'test "$(git rev-parse --abbrev-ref HEAD)" = main && test "$(git rev-list --count HEAD)" = 1',
        ],
      },
      { kind: 'event', label: 'worker changes merged from worktrees', type: /^worktree\/merged$/ },
    ],
  },
  {
    id: 'browser-shop',
    pillar: 'browser',
    prompt: 'On {url}, find the cheapest lamp and tell me its SKU.',
    tiers: ['answer', 'solo'],
    modes: ['orchestrated'],
    budget: { seconds: 240, tokens: 300_000 },
    site: shopSite,
    checks: [
      { kind: 'tool', label: 'uses the browser', used: /^browser_/ },
      { kind: 'reply', label: "names the cheapest lamp's SKU", matches: /LMP-912/ },
    ],
  },
  {
    id: 'browser-form',
    pillar: 'browser',
    prompt:
      'Fill in the contact form at {url} as Ada Lovelace (ada@example.com), topic Support, send it, and tell me the confirmation code.',
    tiers: ['answer', 'solo'],
    modes: ['orchestrated'],
    budget: { seconds: 240, tokens: 300_000 },
    site: formSite,
    checks: [
      { kind: 'tool', label: 'uses the browser', used: /^browser_/ },
      {
        kind: 'reply',
        label: 'reports the confirmation code',
        matches: new RegExp(confirmation('Ada Lovelace', 'ada@example.com', 'Support')),
      },
    ],
  },
  {
    id: 'browser-table',
    pillar: 'browser',
    prompt: 'Which country had the highest 2025 revenue in the report at {url}, and how much was it?',
    tiers: ['answer', 'solo'],
    modes: ['orchestrated'],
    budget: { seconds: 180, tokens: 200_000 },
    site: () => tableSite(),
    checks: [
      { kind: 'reply', label: 'Chile with 512', matches: /Chile[\s\S]{0,80}512|512[\s\S]{0,80}Chile/ },
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
