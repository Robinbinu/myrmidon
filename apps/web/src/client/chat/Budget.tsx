import type { Budget } from '@myrmidon/protocol'
import { useEffect, useState } from 'react'
import { api, getSpend, type Project, setProjectBudget } from '../api.ts'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Button, SectionHeader, TextInput } from '../ui/primitives.tsx'
import { Sheet } from '../ui/Sheet.tsx'
import { useToast } from '../ui/Toast.tsx'
import { BUDGET_MAX_USD } from '../ui-config.ts'
import { Row } from './TeamControls.tsx'

const t = copy.budget

/** The global caps (Settings → Crew & budget): what a chat's or project's empty per-run cap falls back to. */
export function useGlobalBudget(): Budget | undefined {
  const [global, setGlobal] = useState<Budget>()
  useEffect(() => {
    api<{ settings: { team?: { costUsd?: number; monthlyUsd?: number } } }>('/api/settings')
      .then(({ settings }) =>
        setGlobal({
          ...(settings.team?.costUsd ? { runUsd: settings.team.costUsd } : {}),
          ...(settings.team?.monthlyUsd ? { totalUsd: settings.team.monthlyUsd } : {}),
        }),
      )
      .catch(() => setGlobal({}))
  }, [])
  return global
}

/** What an empty per-run cap means here: the project's, else the global one, else no limit. */
export function runFallback(project: Budget | undefined, global: Budget | undefined): string {
  if (project?.runUsd) return t.inheritProject(project.runUsd)
  if (global?.runUsd) return t.inheritGlobal(global.runUsd)
  return t.inheritNone
}

/**
 * A cap in dollars; empty sets none at this level. Typing keeps a draft, and leaving the box or Enter saves it, so a
 * cap is saved once rather than at every keystroke.
 */
export function DollarField(props: {
  label: string
  value?: number | undefined
  onChange(v?: number): void
}) {
  const [draft, setDraft] = useState<string>()
  const text = draft ?? (props.value ? String(props.value) : '')
  const n = Number(text)
  const ok = !text.trim() || (Number.isFinite(n) && n >= 0 && n <= BUDGET_MAX_USD)
  const commit = () => {
    if (draft === undefined) return
    setDraft(undefined)
    if (!ok) return
    const next = draft.trim() && n > 0 ? Math.round(n * 100) / 100 : undefined
    if (next !== props.value) props.onChange(next)
  }
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-callout text-muted">$</span>
      <TextInput
        type="number"
        min={0}
        max={BUDGET_MAX_USD}
        step={0.5}
        value={text}
        placeholder={t.none}
        aria-label={t.field(props.label)}
        aria-invalid={!ok}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        className="w-24 text-right tabular-nums"
      />
    </div>
  )
}

/** A level's caps, per run and in total, with what was spent toward the total. */
function BudgetRows(props: {
  value: Budget
  totalLabel: string
  totalHint: string
  /** What an empty per-run cap falls back to, in words. */
  fallback: string
  spentLine: string
  onChange(b: Budget): void
}) {
  const set = (key: keyof Budget, v?: number) => {
    const { [key]: _, ...rest } = props.value
    props.onChange(v ? { ...rest, [key]: v } : rest)
  }
  return (
    <>
      <div className="divide-y divide-line overflow-visible rounded-base border border-line bg-surface">
        <Row label={t.perRun} hint={t.perRunHint(props.fallback)}>
          <DollarField label={t.perRun} value={props.value.runUsd} onChange={(v) => set('runUsd', v)} />
        </Row>
        <Row label={props.totalLabel} hint={props.totalHint}>
          <DollarField
            label={props.totalLabel}
            value={props.value.totalUsd}
            onChange={(v) => set('totalUsd', v)}
          />
        </Row>
      </div>
      <p className="-mt-1 px-1 text-footnote leading-snug text-muted" data-budget-spent>
        {props.spentLine} {t.unpriced}
      </p>
    </>
  )
}

/** A chat's own caps in the composer's crew panel, with what it has spent so far. */
export function ChatBudget(props: {
  value: Budget
  spent: number
  /** The chat's project's caps, which an empty per-run cap falls back to. */
  project?: Budget | undefined
  onChange(b: Budget): void
}) {
  const global = useGlobalBudget()
  return (
    <div className="flex flex-col gap-3">
      <SectionHeader
        as="h3"
        className="px-1"
        icon={<FEATURE_ICONS.budget className="size-4 text-muted" />}
        title={t.chatTitle}
      />
      <BudgetRows
        value={props.value}
        totalLabel={t.chatTotal}
        totalHint={t.chatTotalHint}
        fallback={runFallback(props.project, global)}
        spentLine={t.spent(props.spent, props.value.totalUsd)}
        onChange={props.onChange}
      />
    </div>
  )
}

/** A project's caps, per run and per calendar month of its chats, with this month's spend; saved together. */
export function ProjectBudget(props: {
  project: Project
  onClose(): void
  onSaved(projects: Project[]): void
}) {
  const toast = useToast()
  const global = useGlobalBudget()
  const [value, setValue] = useState<Budget>(props.project.budget ?? {})
  const [spent, setSpent] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    getSpend()
      .then((s) => setSpent(s.projects[props.project.id] ?? 0))
      .catch(() => {})
  }, [props.project.id])
  const save = async () => {
    setBusy(true)
    try {
      const r = await setProjectBudget(props.project.id, value)
      props.onSaved(r.projects)
      toast(t.saved(props.project.name), 'success')
      props.onClose()
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      title={t.sheetTitle(props.project.name)}
      onClose={props.onClose}
      size="sm"
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => void save()}
          icon={<FEATURE_ICONS.budget className="size-3.5" />}
        >
          {t.save}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <BudgetRows
          value={value}
          totalLabel={t.projectTotal}
          totalHint={t.projectTotalHint}
          fallback={runFallback(undefined, global)}
          spentLine={t.monthSpent(spent, value.totalUsd)}
          onChange={setValue}
        />
      </div>
    </Sheet>
  )
}
