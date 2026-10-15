import { expect, test } from 'bun:test'
import { foldColony, type MyrEvent, type QuestionAnswers, type QuestionChoice } from '@myrmidon/protocol'
import { act } from 'react'
import { copy } from '../src/client/copy.ts'
import { mount, withDom } from './dom.ts'

withDom()

const audience: QuestionChoice = {
  question: 'Who is the site for?',
  header: 'Audience',
  options: [{ label: 'Me' }, { label: 'A studio' }],
}
const pages: QuestionChoice = {
  question: 'Which pages?',
  options: [{ label: 'Work' }, { label: 'About' }, { label: 'Contact' }],
  multiSelect: true,
}

/** A chat round's log as the runtime writes it, from the request up to `rest`. */
function log(rest: [type: string, payload: unknown, kind?: string][]): MyrEvent[] {
  const all: [string, unknown, string?][] = [
    [
      'colony/created',
      {
        name: 'build me a site',
        mission: 'build me a site',
        pattern: 'lead-workers',
        agents: [{ name: 'lead', role: 'lead', model: 'mock/lead', tools: ['ask_user', 'reply_user'] }],
        chat: { chatId: 'chat-q', round: 1, request: 'build me a site' },
        tier: 'solo',
      },
    ],
    ['chat/user', { text: 'build me a site' }, 'user'],
    ['colony/started', { pid: 1, hostname: 'test', models: {}, rules: [] }],
    ...rest,
  ]
  return all.map(
    ([type, payload, kind = 'system'], i) =>
      ({
        colonyId: 'colony-q',
        seq: i + 1,
        id: `e${i + 1}`,
        time: new Date((i + 1) * 1000).toISOString(),
        type,
        actor: { kind, id: kind === 'user' ? 'user' : 'lead' },
        trace: { traceId: 't', spanId: 's' },
        schema: 1,
        payload,
      }) as MyrEvent,
  )
}

const asked = (choices: QuestionChoice[]): [string, unknown] => [
  'chat/reply',
  { agent: 'lead', text: 'A few choices before I start:', final: false, question: true, choices },
]
const awaiting: [string, unknown] = ['colony/stopped', { reason: 'awaiting your reply' }]

/** Renders the round the way the chat does, sending answers to `onAnswer`. */
async function round(
  events: MyrEvent[],
  onAnswer: (text: string, answers?: QuestionAnswers) => Promise<unknown> = async () => {},
) {
  const { RoundView } = await import('../src/client/chat/RoundView.tsx')
  const { LiveReplies } = await import('../src/client/use-colony.ts')
  const state = foldColony('colony-q', events)
  const head = events.at(-1)?.seq ?? 0
  const colony = {
    events,
    state,
    cursor: head,
    head,
    live: true,
    setCursor() {},
    setLive() {},
    streams: new LiveReplies(),
  }
  const view = await mount(
    <RoundView
      colonyId="colony-q"
      colony={colony}
      round={1}
      onOpenColony={() => {}}
      onRetry={() => {}}
      onLearn={() => {}}
      onAnswer={onAnswer}
      onResume={async () => {}}
      models={[]}
      retry="hidden"
    />,
  )
  const buttons = () => [...view.host.querySelectorAll('button')]
  const button = (label: string) => {
    const found = buttons().find(
      (b) => b.textContent?.trim().endsWith(label) || b.textContent?.trim() === label,
    )
    if (!found) throw new Error(`no button "${label}" in ${view.host.textContent}`)
    return found
  }
  return {
    ...view,
    button,
    /** Whether an option can be clicked: not disabled by itself or by its fieldset. */
    clickable: (label: string) => {
      const b = button(label)
      return !b.disabled && !b.closest('fieldset')?.disabled
    },
    click: (label: string) => act(async () => button(label).click()),
    text: () => view.host.textContent ?? '',
  }
}

test('a single-choice question can be answered as soon as it is asked, before the asking turn ends', async () => {
  const sent: [string, QuestionAnswers | undefined][] = []
  // The lead asked and is still finishing its turn: the round has not paused yet.
  const view = await round(log([asked([audience])]), async (text, answers) => {
    sent.push([text, answers])
  })
  expect(view.clickable('Me')).toBe(true)
  await view.click('Me')
  // A second pick of a single choice replaces the first.
  await view.click('A studio')
  await view.click(copy.questions.send(1))
  expect(sent).toEqual([
    ['Who is the site for? → A studio', { seq: 4, picks: [{ picked: ['A studio'], skipped: false }] }],
  ])
  await view.unmount()
})

test('a multi-choice question keeps every pick, also when the agent spoke after asking', async () => {
  const sent: [string, QuestionAnswers | undefined][] = []
  const view = await round(
    log([
      asked([audience, pages]),
      ['chat/reply', { agent: 'lead', text: 'Pick what fits; I will wait.', final: false }],
      awaiting,
    ]),
    async (text, answers) => {
      sent.push([text, answers])
    },
  )
  expect(view.clickable('Work')).toBe(true)
  await view.click('Me')
  await view.click('Work')
  await view.click('Contact')
  await view.click('About')
  // Clicking a picked option of a multi-choice question takes it back.
  await view.click('About')
  await view.click(copy.questions.send(2))
  expect(sent).toEqual([
    [
      'Who is the site for? → Me\nWhich pages? → Work, Contact',
      {
        seq: 4,
        picks: [
          { picked: ['Me'], skipped: false },
          { picked: ['Work', 'Contact'], skipped: false },
        ],
      },
    ],
  ])
  await view.unmount()
})

test('an answer that does not get through says why, and the card stays answerable', async () => {
  let fail = true
  const sent: string[] = []
  const view = await round(log([asked([audience]), awaiting]), async (text) => {
    if (fail) throw new Error('the server is not reachable')
    sent.push(text)
  })
  await view.click('Me')
  await view.click(copy.questions.send(1))
  expect(view.text()).toContain(copy.questions.failed('the server is not reachable'))
  expect(view.host.querySelector('[role="alert"]')).not.toBeNull()
  // What was picked is kept, and sending again works.
  expect(view.button('Me').getAttribute('aria-pressed')).toBe('true')
  expect(view.clickable('A studio')).toBe(true)
  expect(view.button(copy.questions.send(1)).disabled).toBe(false)
  fail = false
  await view.click(copy.questions.send(1))
  expect(sent).toEqual(['Who is the site for? → Me'])
  expect(view.text()).not.toContain(copy.questions.failed('the server is not reachable'))
  await view.unmount()
})

test('a card that can no longer be answered says why instead of looking clickable', async () => {
  const closed = async (events: MyrEvent[], why: string) => {
    const view = await round(events)
    expect(view.clickable('Me')).toBe(false)
    // The first card (a newer question has its own).
    const card = view.button('Me').closest('fieldset')?.parentElement?.textContent ?? ''
    expect(card).toContain(why)
    expect(card).not.toContain(copy.questions.send(1))
    expect(card).not.toContain(copy.questions.skipAll(1))
    await view.unmount()
  }
  // The person stopped the round before answering.
  await closed(
    log([asked([audience]), ['colony/stopped', { reason: 'stopped by user' }]]),
    copy.questions.ended,
  )
  // They wrote in the message box instead.
  await closed(
    log([asked([audience]), ['chat/user', { text: 'just pick one', mode: 'steer' }, 'user'], awaiting]),
    copy.questions.replied,
  )
  // The agent asked again since.
  await closed(
    log([
      asked([audience]),
      ['chat/user', { text: 'hmm', mode: 'steer' }, 'user'],
      ['chat/reply', { agent: 'lead', text: 'Then this:', final: false, question: true, choices: [pages] }],
      awaiting,
    ]),
    copy.questions.replied,
  )
  // It asked again after saying more, with nothing from the person in between.
  await closed(
    log([
      asked([audience]),
      ['chat/reply', { agent: 'lead', text: 'One more thing first.', final: false }],
      ['chat/reply', { agent: 'lead', text: 'Then this:', final: false, question: true, choices: [pages] }],
      awaiting,
    ]),
    copy.questions.newer,
  )
  // Answered on the card: the picks show, with the footer saying so.
  await closed(
    log([
      asked([audience]),
      awaiting,
      [
        'chat/user',
        {
          text: 'Who is the site for? → Me',
          answers: { seq: 4, picks: [{ picked: ['Me'], skipped: false }] },
        },
        'user',
      ],
    ]),
    copy.questions.answered,
  )
})
