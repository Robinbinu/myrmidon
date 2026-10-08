import type { QuestionChoice } from '@myrmidon/protocol'
import { Check, SkipForward } from 'lucide-react'
import { motion } from 'motion/react'
import { useRef, useState } from 'react'
import { copy } from '../copy.ts'
import { Button, cn } from '../ui/primitives.tsx'
import { softSpring } from '../ui-config.ts'
import { Markdown } from './Markdown.tsx'

interface Answer {
  picked: string[]
  other: string
  skipped: boolean
}

const blank: Answer = { picked: [], other: '', skipped: false }

/** An option that means "I'll type it": picking it hands over to the text box rather than answering. */
export const typesOwn = (o: QuestionChoice['options'][number]) => copy.questions.typesOwn.test(o.label.trim())

/** What the agent reads back: one "question → answer" line per question. */
export function answerText(choices: readonly QuestionChoice[], answers: readonly Answer[]): string {
  return choices
    .map((q, i) => {
      const a = answers[i] ?? blank
      const said = [...a.picked, ...(a.other.trim() ? [a.other.trim()] : [])]
      return `${q.question} → ${a.skipped || said.length === 0 ? copy.questions.skippedAnswer : said.join(', ')}`
    })
    .join('\n')
}

/**
 * Questions an agent asked with options, as Claude Code asks them: click an option (several where allowed), type
 * your own answer, or skip a question to leave it to the agent. One send answers them all. Once answered, the card
 * stays as a read-only record of what was asked. A plan the agent asks to have approved sits above the questions.
 */
export function QuestionCard(props: {
  choices: readonly QuestionChoice[]
  plan?: string
  /** The round is waiting on these questions; otherwise they were answered or set aside. */
  open: boolean
  /** Settles once the answer reached the server; a rejection leaves the questions open to send again. */
  onAnswer(text: string): Promise<unknown>
}) {
  const [answers, setAnswers] = useState<Answer[]>(() => props.choices.map(() => blank))
  const [sending, setSending] = useState<'no' | 'yes' | 'sent'>('no')
  const others = useRef<(HTMLInputElement | null)[]>([])
  const live = props.open && sending !== 'sent'
  const several = props.choices.length > 1
  const set = (i: number, patch: Partial<Answer>) =>
    setAnswers((all) => all.map((a, j) => (j === i ? { ...a, ...patch } : a)))
  const pick = (i: number, label: string, multi: boolean) => {
    const a = answers[i] ?? blank
    const picked = multi
      ? a.picked.includes(label)
        ? a.picked.filter((x) => x !== label)
        : [...a.picked, label]
      : a.picked[0] === label
        ? []
        : [label]
    set(i, { picked, skipped: false, ...(multi ? {} : { other: '' }) })
    const option = props.choices[i]?.options.find((o) => o.label === label)
    if (option && typesOwn(option) && picked.includes(label)) others.current[i]?.focus()
  }
  // Picking "I'll type it" is not an answer until something is typed.
  const done = answers.every(
    (a, i) =>
      a.skipped ||
      a.other.trim() ||
      a.picked.some((label) => {
        const option = props.choices[i]?.options.find((o) => o.label === label)
        return option && !typesOwn(option)
      }),
  )
  const send = (text: string) => {
    if (sending !== 'no') return
    setSending('yes')
    props.onAnswer(text).then(
      () => setSending('sent'),
      () => setSending('no'),
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={softSpring}
      className={cn(
        'mt-2 flex flex-col gap-4 rounded-2xl border bg-surface p-4 shadow-soft',
        live ? 'border-accent/40' : 'border-line opacity-80',
      )}
    >
      {props.plan && (
        <section aria-label={copy.questions.plan} className="flex flex-col gap-1.5">
          <span className="section-label text-muted">{copy.questions.plan}</span>
          <div className="max-h-[420px] overflow-y-auto rounded-lg border border-line bg-surface-2/40 px-3.5 py-2.5 text-reading">
            <Markdown text={props.plan} />
          </div>
        </section>
      )}
      {props.choices.map((q, i) => {
        const a = answers[i] ?? blank
        const multi = q.multiSelect === true
        // Typing alongside an "I'll type it" option adds to it rather than replacing the pick.
        const typing = a.picked.some((label) => q.options.some((o) => o.label === label && typesOwn(o)))
        return (
          <fieldset
            key={q.question}
            disabled={!live || sending === 'yes'}
            className={cn('flex flex-col gap-1.5', a.skipped && 'opacity-50')}
          >
            <legend className="mb-1.5 flex w-full items-center gap-2">
              {q.header && (
                <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-caption font-semibold uppercase tracking-wide text-accent-fg">
                  {q.header}
                </span>
              )}
              <span className="min-w-0 flex-1 text-reading font-medium text-fg">{q.question}</span>
              {live && several && (
                <button
                  type="button"
                  onClick={() => set(i, { skipped: !a.skipped, picked: [], other: '' })}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-small text-muted transition-colors hover:bg-fill hover:text-fg-2"
                >
                  {a.skipped ? copy.questions.unskip : copy.questions.skip}
                </button>
              )}
            </legend>
            {multi && <span className="-mt-1 text-footnote text-muted">{copy.questions.pickAny}</span>}
            {q.options.map((o) => {
              const on = a.picked.includes(o.label)
              return (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => pick(i, o.label, multi)}
                  className={cn(
                    'flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                    on ? 'border-accent bg-accent-soft/60' : 'border-line hover:bg-surface-2',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 grid size-4 shrink-0 place-items-center border',
                      multi ? 'rounded-sm' : 'rounded-full',
                      on ? 'border-accent bg-accent text-on-accent' : 'border-line-strong',
                    )}
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-body font-medium text-fg">{o.label}</span>
                    {o.description && (
                      <span className="block text-small leading-snug text-muted">{o.description}</span>
                    )}
                  </span>
                </button>
              )
            })}
            {live && (
              <input
                ref={(el) => {
                  others.current[i] = el
                }}
                value={a.other}
                onChange={(e) =>
                  set(i, {
                    other: e.target.value,
                    skipped: false,
                    ...(multi || typing ? {} : { picked: [] }),
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && done) send(answerText(props.choices, answers))
                }}
                placeholder={typing ? copy.questions.typeHere : copy.questions.other}
                aria-label={copy.questions.otherFor(q.question)}
                className="h-9 rounded-lg border border-line bg-surface-2/50 px-3 text-body outline-none placeholder:text-muted focus:border-accent/60 focus:ring-2 focus:ring-accent-soft"
              />
            )}
          </fieldset>
        )
      })}
      {live && props.choices.length > 0 && (
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={sending === 'yes'}
            onClick={() =>
              send(
                answerText(
                  props.choices,
                  props.choices.map(() => ({ ...blank, skipped: true })),
                ),
              )
            }
            icon={<SkipForward className="size-3.5" />}
          >
            {copy.questions.skipAll(props.choices.length)}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!done || sending === 'yes'}
            onClick={() => send(answerText(props.choices, answers))}
          >
            {sending === 'yes' ? copy.questions.sending : copy.questions.send(props.choices.length)}
          </Button>
        </div>
      )}
      {live && props.plan && props.choices.length === 0 && (
        <div className="flex items-center justify-end gap-3 border-t border-line pt-3">
          <span className="min-w-0 flex-1 text-small text-muted">{copy.questions.approvePlan.hint}</span>
          <Button
            size="sm"
            variant="primary"
            disabled={sending === 'yes'}
            onClick={() => send(copy.questions.approvePlan.text)}
          >
            {sending === 'yes' ? copy.questions.sending : copy.questions.approvePlan.button}
          </Button>
        </div>
      )}
    </motion.div>
  )
}
