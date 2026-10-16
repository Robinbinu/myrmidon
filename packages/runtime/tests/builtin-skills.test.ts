import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foldColony } from '@myrmidon/protocol'
import { BUILTIN_SKILLS_DIR, WORKFLOW_SKILLS } from '../src/config.ts'
import { prompts } from '../src/prompts.ts'
import { scanSkill } from '../src/skill-scan.ts'
import { parseSkillFile, SkillLibrary, writeBuiltinSkills } from '../src/skills.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myr-builtin-skills-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NAMES = ['investigate', 'qa', 'retro', 'review', 'ship']

/**
 * The report each skill ends with: the lines the person (and anything reading the reply) can rely on. A skill whose text
 * loses one of these no longer promises that shape.
 */
const CONTRACTS: Record<string, readonly string[]> = {
  review: [
    'Review: <target> against <base>',
    'Verdict: SHIP | FIX FIRST | BLOCK',
    '[P1] (confidence 8/10)',
    'Gate changes:',
    'Not covered:',
  ],
  ship: [
    'Ship: <branch> -> <base>',
    'Status: SHIPPED | READY | BLOCKED',
    'Tests:',
    'Review:',
    'Version:',
    'Changelog:',
    'Pull request:',
  ],
  qa: [
    'QA: <target> (<surface>)',
    'Health: GOOD | ISSUES | BROKEN',
    '| Contract (source) | Probe | Expected -> observed | Outcome |',
    'ISSUE-001 [P1]',
    'Not covered:',
  ],
  investigate: [
    'Debug report',
    'Root cause:',
    'Regression test:',
    'Status: DONE | DONE_WITH_CONCERNS | BLOCKED',
  ],
  retro: ['Retro: <repo> <start> to <end>', 'Summary:', '| Metric | Value |', 'Three things to improve:'],
}

test('Myrmidon writes the skills it comes with as ordinary skill folders the scan passes', () => {
  const home = join(dir, 'home')
  const written = writeBuiltinSkills(home)
  expect(written).toBe(join(home, BUILTIN_SKILLS_DIR))
  for (const name of NAMES) {
    const text = readFileSync(join(written, name, 'SKILL.md'), 'utf8')
    const parsed = parseSkillFile(text)
    expect(parsed?.name).toBe(name)
    // The whole description reaches agents: the library cuts at 1024 characters.
    expect(parsed?.description.length).toBeLessThan(1024)
    expect(parsed?.body).toContain('```')
    expect(text).toContain('\nsource: builtin\n')
    // A skill the scan held would never reach an agent.
    expect(scanSkill(join(written, name)).verdict).toBe('clean')
  }
})

test("each skill promises its report's shape and holds agents to the configured limits", () => {
  const skills = prompts.builtinSkills as Record<string, { description: string; body: string }>
  expect(Object.keys(skills).sort()).toEqual(NAMES)
  for (const [name, lines] of Object.entries(CONTRACTS))
    for (const line of lines) expect(skills[name]?.body).toContain(line)
  expect(skills.review?.body).toContain(`At ${WORKFLOW_SKILLS.freshEyesLines} or more changed lines`)
  expect(skills.investigate?.body).toContain(`After ${WORKFLOW_SKILLS.hypotheses} failed hypotheses STOP`)
  expect(skills.investigate?.body).toContain(`more than ${WORKFLOW_SKILLS.blastRadiusFiles} files`)
  expect(skills.retro?.body).toContain(`${WORKFLOW_SKILLS.sessionGapMinutes} minutes apart`)
  // Shipping never goes around the person: no push to the default branch, no force-push, no blind staging.
  expect(skills.ship?.body).toContain('never force-push')
  expect(skills.ship?.body).toContain('never `git add -A`')
  // The review hands committing to ship, and retro and QA write nothing unasked.
  expect(skills.review?.body).toContain('Never commit, push or open a pull request here')
  expect(skills.retro?.body).toContain('Read-only')
  expect(skills.qa?.body).toContain('Report-only by default')
})

test('a file is rewritten only when its text changed, and only folders Myrmidon wrote are removed', () => {
  const home = join(dir, 'home')
  const at = writeBuiltinSkills(home)
  const review = join(at, 'review', 'SKILL.md')
  const before = statSync(review).mtimeMs
  Bun.sleepSync(20)
  writeBuiltinSkills(home)
  expect(statSync(review).mtimeMs).toBe(before)

  writeFileSync(review, 'edited by hand')
  // A skill this version no longer comes with, and a folder someone else put there.
  mkdirSync(join(at, 'old-workflow'))
  writeFileSync(
    join(at, 'old-workflow', 'SKILL.md'),
    '---\nname: old-workflow\ndescription: gone\nsource: builtin\n---\n\nx\n',
  )
  mkdirSync(join(at, 'mine'))
  writeFileSync(
    join(at, 'mine', 'SKILL.md'),
    '---\nname: mine\ndescription: the person put this here\n---\n\nx\n',
  )
  writeBuiltinSkills(home)
  expect(parseSkillFile(readFileSync(review, 'utf8'))?.name).toBe('review')
  expect(existsSync(join(at, 'old-workflow'))).toBe(false)
  expect(existsSync(join(at, 'mine', 'SKILL.md'))).toBe(true)
})

test("the library offers them last: the person's own skill of the same name wins, and they switch off", () => {
  const home = join(dir, 'home')
  const claude = join(dir, 'claude')
  mkdirSync(join(claude, 'review'), { recursive: true })
  writeFileSync(
    join(claude, 'review', 'SKILL.md'),
    '---\nname: review\ndescription: My own review.\n---\n\nMine.\n',
  )
  const library = new SkillLibrary(home, claude, () => [], undefined, writeBuiltinSkills(home))
  expect(library.list().map((s) => [s.name, s.source])).toEqual([
    ['investigate', 'builtin'],
    ['qa', 'builtin'],
    ['retro', 'builtin'],
    ['review', 'claude'],
    ['ship', 'builtin'],
  ])
  expect(library.read('ship')).toContain(
    'Iron law: no "ready" or "shipped" without fresh verification evidence',
  )
  library.setEnabled('retro', false)
  expect(library.offered().map((s) => s.name)).not.toContain('retro')
  // Without the folder (tests, `myr run`) nothing changes.
  expect(new SkillLibrary(join(dir, 'other'), claude).list().map((s) => s.name)).toEqual(['review'])
})

test('a /review message has the agent load the built-in skill, and the round records it', async () => {
  const { bootRuntime, ChatService, ModelResolver } = await import('../src/index.ts')
  const { createMockModel } = await import('../src/omp/mock.ts')
  const home = join(dir, 'home')
  const runtime = await bootRuntime(home)
  try {
    const skills = new SkillLibrary(
      home,
      join(dir, 'no-claude'),
      () => [],
      undefined,
      writeBuiltinSkills(home),
    )
    const resolver = new ModelResolver()
    let prompt = ''
    let loaded = ''
    const lead = createMockModel({
      handler: (ctx) => {
        prompt = ctx.systemPrompt?.join('\n') ?? ''
        const seen = JSON.stringify(ctx.messages)
        if (!seen.includes('"use_skill"'))
          return { content: [{ type: 'toolCall', name: 'use_skill', arguments: { name: 'review' } }] }
        loaded = seen
        return {
          content: seen.includes('reply_user')
            ? ['done']
            : [
                {
                  type: 'toolCall',
                  name: 'reply_user',
                  arguments: {
                    text: 'Review: working tree against main\nVerdict: SHIP: nothing found',
                    final: true,
                  },
                },
              ],
        }
      },
    })
    resolver.register('mock/lead', { model: lead.model, streamFn: lead.stream })
    const judge = createMockModel({ handler: () => ({ content: ['{"score": 0.9, "reasons": "fine"}'] }) })
    resolver.register('mock/judge', { model: judge.model, streamFn: judge.stream })
    const chats = new ChatService(runtime, { resolver, classify: async () => 'solo', skills })
    // What the composer sends for "/review" with no argument (copy.commands.list.review.send).
    const { colonyId } = await chats.send('Use the review skill on the changes on this branch.', {
      mode: 'orchestrated',
      leadModel: 'mock/lead',
      roster: [],
      judgeModel: 'mock/judge',
    })
    for (let i = 0; i < 400; i++) {
      const s = foldColony(colonyId, await runtime.ctx.log.read(colonyId as never))
      if (s.status !== 'running' && s.status !== 'created') break
      await Bun.sleep(50)
    }
    // Offered in the system prompt like any other skill.
    expect(prompt).toMatch(/<skills>[\s\S]*\breview\b[\s\S]*<\/skills>/)
    expect(loaded).toContain('# Review: find what breaks before it lands')
    expect(loaded).toContain('Verdict: SHIP | FIX FIRST | BLOCK')
    const log = await runtime.ctx.log.read(colonyId as never)
    expect(log.find((e) => e.type === 'skill/used')?.payload).toEqual({ agent: 'lead', name: 'review' })
    await chats.stopAll()
  } finally {
    await runtime.dispose()
  }
})

/**
 * Real replies from the review and ship skills, recorded on 2026-10-16 with DeepSeek V4 Pro (ark) on a throwaway repo
 * whose branch added a coupon function with an inverted expiry check and its test committed as skipped. Models dress
 * the shape in Markdown (bold, code spans), so the check reads the text without it.
 */
const recorded = (name: string) =>
  readFileSync(join(import.meta.dir, 'fixtures', 'workflow-runs', `${name}.md`), 'utf8').replace(/[*`]/g, '')

test("a real review reply has the skill's shape: header, verdict, ranked findings with lines, gates, checks", () => {
  const text = recorded('review')
  expect(text).toMatch(/^Review: .+ against .+: \d+ files, \+\d+\/-\d+$/m)
  const verdict = /^Verdict: (SHIP|FIX FIRST|BLOCK):/m.exec(text)?.[1]
  const findings = [...text.matchAll(/^\d+\. \[(P[0-3])\] \(confidence (\d+)\/10\) /gm)]
  expect(findings.length).toBeGreaterThan(0)
  // The seeded defect is found, at the top, with the line it is on.
  expect(findings[0]?.[1]).toBe('P0')
  expect(text).toMatch(/src\/coupons\.js:1[23]/)
  // The verdict follows the rule: a P0 blocks.
  expect(verdict).toBe('BLOCK')
  // The skipped test reaches the person as a gate change.
  expect(text).toMatch(/^Gate changes:[\s\S]*test\.skip/m)
  expect(text).toMatch(/^Checks: /m)
  expect(text).toMatch(/^Not covered: /m)
})

test("a real ship reply has the skill's shape and a status the gates allow", () => {
  const text = recorded('ship')
  for (const field of [
    'Ship',
    'Status',
    'Tests',
    'Review',
    'Version',
    'Changelog',
    'Commits',
    'Pushed',
    'Pull request',
    'Left for you',
  ])
    expect(text).toMatch(new RegExp(`^${field}: .+`, 'm'))
  expect(text).toMatch(/^Status: (SHIPPED|READY|BLOCKED)$/m)
  expect(text).toMatch(/^Version: 0\.3\.0 -> 0\.4\.0$/m)
  // Without a remote it cannot be SHIPPED: READY, with the reason it was not pushed.
  expect(text).toMatch(/^Status: READY$/m)
  expect(text).toMatch(/^Pushed: not pushed: /m)
})
