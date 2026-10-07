import type { QuestionChoice } from '@myrmidon/protocol'
import { Check, SkipForward } from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'
import { copy } from '../copy.ts'
import { Button, cn } from '../ui/primitives.tsx'
import { softSpring } from '../ui-config.ts'

interface Answer {
  picked: string[]
  other: string
  skipped: boolean
}

const blank: Answer = { picked: [], other: '', skipped: false }

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
 * stays as a read-only record of what was asked.
 */
export function QuestionCard(props: {
  choices: readonly QuestionChoice[]
  /** The round is waiting on these questions; otherwise they were answered or set aside. */
  open: boolean
  onAnswer(text: string): void
}) {
  const [answers, setAnswers] = useState<Answer[]>(() => props.choices.map(() => blank))
  const [sent, setSent] = useState(false)
  const live = props.open && !sent
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
  }
  const done = answers.every((a) => a.skipped || a.picked.length > 0 || a.other.trim())
  const send = (all: readonly Answer[]) => {
    setSent(true)
    props.onAnswer(answerText(props.choices, all))
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
      {props.choices.map((q, i) => {
        const a = answers[i] ?? blank
        const multi = q.multiSelect === true
        return (
          <fieldset
            key={q.question}
            disabled={!live}
            className={cn('flex flex-col gap-1.5', a.skipped && 'opacity-50')}
          >
            <legend className="mb-1.5 flex w-full items-center gap-2">
              {q.header && (
                <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent-fg">
                  {q.header}
                </span>
              )}
              <span className="min-w-0 flex-1 text-[13.5px] font-medium text-fg">{q.question}</span>
              {live && (
                <button
                  type="button"
                  onClick={() => set(i, { skipped: !a.skipped, picked: [], other: '' })}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-muted transition-colors hover:bg-fill hover:text-fg-2"
                >
                  {a.skipped ? copy.questions.unskip : copy.questions.skip}
                </button>
              )}
            </legend>
            {multi && <span className="-mt-1 text-[11.5px] text-muted">{copy.questions.pickAny}</span>}
            {q.options.map((o) => {
              const on = a.picked.includes(o.label)
              return (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => pick(i, o.label, multi)}
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors',
                    on ? 'border-accent bg-accent-soft/60' : 'border-line hover:bg-surface-2',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 grid size-4 shrink-0 place-items-center border',
                      multi ? 'rounded-[5px]' : 'rounded-full',
                      on ? 'border-accent bg-accent text-on-accent' : 'border-line-strong',
                    )}
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-fg">{o.label}</span>
                    {o.description && (
                      <span className="block text-[12px] leading-snug text-muted">{o.description}</span>
                    )}
                  </span>
                </button>
              )
            })}
            {live && (
              <input
                value={a.other}
                onChange={(e) =>
                  set(i, { other: e.target.value, skipped: false, ...(multi ? {} : { picked: [] }) })
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && done) send(answers)
                }}
                placeholder={copy.questions.other}
                aria-label={copy.questions.otherFor(q.question)}
                className="h-9 rounded-xl border border-line bg-surface-2/50 px-3 text-[13px] outline-none placeholder:text-muted focus:border-accent/60 focus:ring-2 focus:ring-accent-soft"
              />
            )}
          </fieldset>
        )
      })}
      {live && (
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => send(props.choices.map(() => ({ ...blank, skipped: true })))}
            icon={<SkipForward className="size-3.5" />}
          >
            {copy.questions.skipAll}
          </Button>
          <Button size="sm" variant="primary" disabled={!done} onClick={() => send(answers)}>
            {copy.questions.send}
          </Button>
        </div>
      )}
    </motion.div>
  )
}
