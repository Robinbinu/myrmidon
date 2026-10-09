import { expect, test } from 'bun:test'
import type { MyrEvent } from '@myrmidon/protocol'
import { prompts } from '../src/prompts.ts'
import { citedUrls, doneWhen, relevantExcerpt, workKinds } from '../src/verifier.ts'

const call = (tool: string): MyrEvent => ({ type: 'tool/call', payload: { tool } }) as unknown as MyrEvent

test('the kind of work comes from the tools used and the files delivered', () => {
  expect(workKinds([call('web_search'), call('web_fetch')], ['report.md'], false)).toEqual([
    'research',
    'writing',
  ])
  expect(workKinds([call('fs_edit')], [], true)).toEqual(['code'])
  // A scratch edit outside a project is not code; a delivered script is.
  expect(workKinds([call('fs_write')], [], false)).toEqual(['writing'])
  expect(workKinds([], ['game/index.html'], false)).toEqual(['code'])
  expect(workKinds([call('browser_open'), call('browser_click')], [], false)).toEqual(['browser'])
  // Inputs the person or a fetch put in the workspace are not deliverables.
  expect(workKinds([], ['uploads/data.py', 'web/page.html'], false)).toEqual(['writing'])
})

test('cited URLs are public, deduplicated, and stripped of trailing punctuation', () => {
  const text =
    'See [the docs](https://example.org/guide). Also https://example.org/guide#intro and ' +
    'https://news.example.com/a?id=2, plus http://localhost:3000/x and https://example.org/guide/.'
  expect(citedUrls(text)).toEqual(['https://example.org/guide', 'https://news.example.com/a?id=2'])
})

test('a long page is cut to its opening and the passages matching the claim', () => {
  const page = `Title: Rocket crate\n${'filler text '.repeat(400)}Downloads: 14,203,511 total, version 0.5.1 released May 2024.${' more filler'.repeat(400)}`
  const excerpt = relevantExcerpt(
    page,
    'Rocket 0.5.1 has 14,203,511 downloads (https://crates.io/crates/rocket)',
    1_500,
  )
  expect(excerpt.length).toBeLessThan(1_700)
  expect(excerpt).toStartWith('Title: Rocket crate')
  expect(excerpt).toContain('14,203,511')
  expect(relevantExcerpt('short page', 'anything')).toBe('short page')
})

test("a task's review checks it against its own Done when, and the judge knows the pass mark", () => {
  const brief = [
    'Goal: a pricing section.',
    'Context: prices are in notes/pricing.md.',
    'Done when: three cards show the prices;',
    '  the page opens with no console errors.',
    'Not yours: the header.',
  ].join('\n')
  expect(doneWhen(brief)).toBe('three cards show the prices;\n  the page opens with no console errors.')
  // Written on one line, as in create_task's example.
  expect(doneWhen('Goal: x. Done when: it builds and the test passes. Not yours: docs.')).toBe(
    'it builds and the test passes.',
  )
  expect(doneWhen('Done when: last head.')).toBe('last head.')
  expect(doneWhen('Write the report.')).toBeUndefined()
  const task = prompts.judge.task('Pricing', brief, doneWhen(brief))
  expect(task).toContain('Its "Done when" is your checklist')
  expect(prompts.judge.task('Pricing', 'Write it.')).not.toContain('checklist')
  expect(prompts.judge.threshold(0.7)).toStartWith('Passing is 0.70 or more.')
  expect(prompts.judge.threshold(0.7)).toContain('about 0.3 when')
  expect(prompts.judge.role).toContain('the replies sent to the person')
})
