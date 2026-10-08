import type { ColonyState, Review, ReviewField } from '@myrmidon/protocol'
import {
  BookmarkPlus,
  Check,
  GraduationCap,
  KeyRound,
  MonitorSmartphone,
  PencilLine,
  ShieldQuestion,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { send } from '../api.ts'
import { copy } from '../copy.ts'
import { type DiffLine, diffLines } from '../diff.ts'
import { Button, cn, TextArea, TextInput } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import { spring } from '../ui-config.ts'
import { Markdown } from './Markdown.tsx'

/** What an agent asked to do, as a verb for the card. */
const action = (tool: string) =>
  tool === 'shell' || tool === 'start_server'
    ? copy.approvals.actions.shell
    : tool === 'fs_write' || tool === 'fs_edit'
      ? copy.approvals.actions.file
      : copy.approvals.actions.use(tool.replace(/^mcp__/, '').replaceAll('_', ' '))

import type { Pending } from './approvals.ts'

/**
 * A call that waited for the person (an "Ask first" project, tools set to Ask, MCP tools that change things, and
 * changes an agent proposes), where it came up in the chat. While it waits it shows what it would do in full, where
 * there is a change to show, with Approve or Deny; text fields can be rewritten first and what runs is the person's
 * version. Once decided it stays as one line saying what was decided.
 */
export function Approval({ colonyId, request }: { colonyId: string; request: Pending }) {
  return request.decided ? (
    <ApprovalRecord request={request} decided={request.decided} />
  ) : (
    <ApprovalCard colonyId={colonyId} request={request} />
  )
}

function ApprovalRecord({
  request: a,
  decided,
}: {
  request: Pending
  decided: NonNullable<Pending['decided']>
}) {
  const t = copy.approvals.decided
  const what = a.review?.title ?? a.summary
  const line = decided.approved
    ? decided.edits && Object.keys(decided.edits).length
      ? t.approvedEdited(what)
      : t.approved(what)
    : decided.by === 'timeout'
      ? t.timedOut(what)
      : decided.by === 'stopped'
        ? t.stopped(what)
        : t.denied(what)
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={spring}
      className="flex min-w-0 items-center gap-1.5 pl-11 text-callout text-muted"
    >
      {decided.approved ? (
        <Check className="size-3.5 shrink-0 text-ok-ink" />
      ) : (
        <X className="size-3.5 shrink-0 text-bad-ink" />
      )}
      <span className="min-w-0 truncate" title={decided.note ? t.withNote(line, decided.note) : line}>
        {line}
        {decided.note && <span className="text-fg-2"> · {decided.note}</span>}
      </span>
    </motion.div>
  )
}

function ApprovalCard({ colonyId, request: a }: { colonyId: string; request: Pending }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const changed = Object.entries(edits).filter(
    ([key, value]) => a.review?.fields.find((f) => f.key === key)?.value !== value,
  )
  const decide = async (approved: boolean) => {
    setBusy(true)
    try {
      await send('POST', `/api/colonies/${colonyId}/approvals/${a.id}`, {
        approved,
        ...(approved && changed.length ? { edits: Object.fromEntries(changed) } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      })
    } catch (err) {
      toast(String((err as Error).message), 'error')
      setBusy(false)
    }
  }
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={spring}
      role="alert"
      className="flex flex-col gap-2.5 rounded-2xl border border-warn/40 bg-warn-soft/40 px-4 py-3"
    >
      <div className="flex items-center gap-2 text-reading">
        <ShieldQuestion className="size-4 shrink-0 text-warn-ink" />
        <span className="min-w-0">
          <span className="font-semibold">{a.agent}</span>{' '}
          {a.review ? (
            <span className="font-medium">{a.review.title}</span>
          ) : (
            copy.approvals.approval.wantsTo(action(a.tool))
          )}
        </span>
      </div>
      {a.review ? (
        <ReviewBody
          review={a.review}
          summary={a.tool === 'propose' ? a.summary : undefined}
          edits={edits}
          onEdit={(key, value) => setEdits((e) => ({ ...e, [key]: value }))}
        />
      ) : (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-surface px-3 py-2 font-mono text-callout">
          {a.summary}
        </pre>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {a.review && (
          <TextInput
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={copy.approvals.review.note(a.agent)}
            aria-label={copy.approvals.review.noteLabel}
            maxLength={2000}
            className="h-8 min-w-0 flex-1"
          />
        )}
        {/* The card's decision is the point of it, so its buttons get a full-size target, not the compact one. */}
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void decide(false)}
          icon={<X className="size-3.5" />}
        >
          {copy.approvals.approval.deny}
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => void decide(true)}
          icon={<Check className="size-3.5" />}
        >
          {changed.length ? copy.approvals.review.approveEdited : copy.approvals.approval.approve}
        </Button>
      </div>
    </motion.div>
  )
}

/** A review's fields: each as a diff, a patch, code or text, and the editable ones as a text box on demand. */
function ReviewBody(props: {
  review: Review
  /** The agent's own line on what the change is for. */
  summary?: string | undefined
  edits: Record<string, string>
  onEdit(key: string, value: string): void
}) {
  const [editing, setEditing] = useState<string>()
  return (
    <div className="flex flex-col gap-2">
      {props.summary && <p className="text-body text-fg-2">{props.summary}</p>}
      {props.review.fields.map((f) => {
        const value = props.edits[f.key] ?? f.value
        const isEditing = editing === f.key
        return (
          <div key={f.key} className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-small">
              <span className="min-w-0 truncate font-mono text-fg-2">{f.label}</span>
              {value !== f.value && <span className="text-accent-fg">{copy.approvals.review.edited}</span>}
              {f.editable && (
                <button
                  type="button"
                  onClick={() => setEditing(isEditing ? undefined : f.key)}
                  aria-pressed={isEditing}
                  aria-label={copy.approvals.review.editLabel(f.label)}
                  className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
                >
                  <PencilLine className="size-3.5" />
                  {isEditing ? copy.approvals.review.preview : copy.approvals.review.edit}
                </button>
              )}
            </div>
            {isEditing ? (
              <TextArea
                value={value}
                onChange={(e) => props.onEdit(f.key, e.target.value)}
                rows={Math.min(18, Math.max(3, value.split('\n').length + 1))}
                aria-label={copy.approvals.review.editLabel(f.label)}
                className={cn(
                  'rounded-none border-0 focus-visible:ring-0',
                  f.format !== 'text' && 'font-mono',
                )}
              />
            ) : (
              <FieldView field={f} value={value} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function FieldView({ field, value }: { field: ReviewField; value: string }) {
  const lines = useMemo<DiffLine[] | undefined>(
    () =>
      field.before !== undefined
        ? diffLines(field.before, value)
        : field.format === 'patch'
          ? patchLines(value)
          : undefined,
    [field.before, field.format, value],
  )
  if (lines) return <DiffLines lines={lines} />
  return field.format === 'text' ? (
    <p className="max-h-72 overflow-auto whitespace-pre-wrap px-3 py-2 text-body">{value}</p>
  ) : (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-callout">
      {value}
    </pre>
  )
}

/** A unified diff's lines as added, removed or context, with its file headers kept as context. */
function patchLines(patch: string): DiffLine[] {
  return patch
    .split('\n')
    .filter((l) => !/^(index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l))
    .map((l) =>
      l.startsWith('+')
        ? { kind: 'add' as const, text: l.slice(1) }
        : l.startsWith('-')
          ? { kind: 'del' as const, text: l.slice(1) }
          : { kind: 'same' as const, text: l.startsWith(' ') ? l.slice(1) : l },
    )
}

/** Changed lines with a little context; long unchanged stretches fold to a count. */
function DiffLines({ lines }: { lines: readonly DiffLine[] }) {
  const near = (i: number) =>
    lines.slice(Math.max(0, i - 3), i + 4).some((l) => l.kind !== 'same') || lines.length <= 12
  if (!lines.some((l) => l.kind !== 'same'))
    return <p className="px-3 py-2 text-callout text-muted">{copy.approvals.review.unchanged}</p>
  const rows: ({ line: DiffLine; i: number } | { fold: number; i: number })[] = []
  for (const [i, line] of lines.entries()) {
    if (near(i)) rows.push({ line, i })
    else {
      const last = rows.at(-1)
      if (last && 'fold' in last) last.fold += 1
      else rows.push({ fold: 1, i })
    }
  }
  return (
    <div className="max-h-80 overflow-auto font-mono text-small leading-[1.55]">
      {rows.map((r) =>
        'fold' in r ? (
          <div key={`f${r.i}`} className="bg-surface-2/60 px-3 py-0.5 text-footnote text-muted">
            {copy.approvals.review.moreLines(r.fold)}
          </div>
        ) : (
          <div
            key={r.i}
            className={cn(
              'whitespace-pre-wrap break-all px-3',
              r.line.kind === 'add' && 'bg-ok-soft',
              r.line.kind === 'del' && 'bg-bad-soft',
            )}
          >
            <span
              className={cn(
                'mr-2 select-none',
                r.line.kind === 'add' ? 'text-ok-ink' : r.line.kind === 'del' ? 'text-bad-ink' : 'text-muted',
              )}
            >
              {r.line.kind === 'add' ? '+' : r.line.kind === 'del' ? '−' : ' '}
            </span>
            {r.line.text || ' '}
          </div>
        ),
      )}
    </div>
  )
}

/**
 * Sign-ins an agent is waiting for: the person opens that agent's browser in the Computer view, takes control,
 * signs in themselves, and hands it back. Agents never see or type the credentials.
 */
export function LoginCards({ state }: { state: ColonyState }) {
  const waiting = Object.values(state.logins).filter((l) => !l.finished)
  return (
    <AnimatePresence initial={false}>
      {waiting.map((l) => (
        <motion.div
          key={l.agent}
          layout
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={spring}
          role="alert"
          className="flex flex-col gap-2.5 rounded-2xl border border-accent/40 bg-accent-soft/40 px-4 py-3"
        >
          <div className="flex items-center gap-2 text-reading">
            <KeyRound className="size-4 shrink-0 text-accent-fg" />
            <span>
              <span className="font-semibold">{l.agent}</span> {copy.approvals.login.needsSignIn}{' '}
              <span className="font-semibold">{l.site}</span>
            </span>
          </div>
          <p className="text-callout leading-relaxed text-fg-2">
            {l.reason} {copy.approvals.login.instructions(l.agent)}
          </p>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="primary"
              icon={<MonitorSmartphone className="size-3.5" />}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('myr:open-view', { detail: { view: 'computer', agent: l.agent } }),
                )
              }
            >
              {copy.approvals.login.openBrowser(l.agent)}
            </Button>
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  )
}

/**
 * Memories an agent proposed this round: the person keeps or discards each. Kept ones reach every later chat
 * (or every chat in the project); Settings → Memory lists and edits them.
 */
export function MemoryCards({ state }: { state: ColonyState }) {
  const toast = useToast()
  const [busy, setBusy] = useState<string>()
  const pending = Object.values(state.memories).filter((m) => m.kept === undefined)
  const decide = async (id: string, keep: boolean) => {
    setBusy(id)
    try {
      await send('POST', `/api/memory/${id}/decide`, { keep })
      if (keep) toast(copy.approvals.memory.kept, 'success')
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <AnimatePresence initial={false}>
      {pending.map((m) => (
        <motion.div
          key={m.id}
          layout
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98 }}
          transition={spring}
          className="flex flex-col gap-2.5 rounded-2xl border border-accent/30 bg-accent-soft/40 px-4 py-3"
        >
          <div className="flex items-center gap-2 text-reading">
            <BookmarkPlus className="size-4 shrink-0 text-accent-fg" />
            <span>
              <span className="font-semibold">{m.agent}</span> {copy.approvals.memory.wantsToRemember}
              {m.project ? copy.approvals.memory.forProject : copy.approvals.memory.everyChat}
            </span>
          </div>
          <p className="rounded-lg bg-surface px-3 py-2 text-reading">
            <span className="mr-1.5 font-mono text-caption uppercase tracking-[0.12em] text-muted">
              {m.kind}
            </span>
            {m.text}
          </p>
          {m.why && <p className="text-small text-muted">{copy.approvals.memory.why(m.why)}</p>}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === m.id}
              onClick={() => void decide(m.id, false)}
              icon={<X className="size-3.5" />}
            >
              {copy.approvals.memory.discard}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy === m.id}
              onClick={() => void decide(m.id, true)}
              icon={<Check className="size-3.5" />}
            >
              {copy.approvals.memory.keep}
            </Button>
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  )
}

/** A proposed skill as the page gets it: from a chat's log, or from the list in Settings. */
export interface SkillProposalView {
  id: string
  name: string
  description: string
  body: string
  why: string
  update?: { description: string; body: string }
}

/**
 * A skill a reviewer proposed from finished work: what it is for, why it is worth keeping, and its instructions in
 * full (an update as a diff against what the skill says now). The person may rewrite it, then keep or discard it.
 */
export function SkillProposalCard(props: { proposal: SkillProposalView; onDecided?(kept: boolean): void }) {
  const t = copy.approvals.skill
  const p = props.proposal
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [description, setDescription] = useState(p.description)
  const [body, setBody] = useState(p.body)
  const lines = useMemo(() => (p.update ? diffLines(p.update.body, body) : undefined), [p.update, body])
  const decide = async (keep: boolean) => {
    setBusy(true)
    try {
      await send('POST', `/api/skill-proposals/${encodeURIComponent(p.id)}/decide`, {
        keep,
        ...(keep && description !== p.description ? { description } : {}),
        ...(keep && body !== p.body ? { body } : {}),
      })
      toast(keep ? t.kept(p.name) : t.discarded, keep ? 'success' : 'info')
      props.onDecided?.(keep)
    } catch (err) {
      toast(String((err as Error).message), 'error')
      setBusy(false)
    }
  }
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={spring}
      className="flex flex-col gap-2.5 rounded-2xl border border-accent/30 bg-accent-soft/40 px-4 py-3"
    >
      <div className="flex items-center gap-2 text-reading">
        <GraduationCap className="size-4 shrink-0 text-accent-fg" />
        <span className="min-w-0">
          {p.update ? t.improve : t.learned} <span className="font-mono font-semibold">{p.name}</span>
        </span>
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          aria-pressed={editing}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-small text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <PencilLine className="size-3.5" />
          {editing ? t.preview : t.edit}
        </button>
      </div>
      {p.why && <p className="text-callout text-fg-2">{t.why(p.why)}</p>}
      {editing ? (
        <div className="flex flex-col gap-2">
          <TextArea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            aria-label={t.description}
            className="text-body"
          />
          <TextArea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={Math.min(18, body.split('\n').length + 2)}
            aria-label={t.instructions}
            className="font-mono"
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <p className="border-b border-line px-3 py-2 text-body">{description}</p>
          {lines ? (
            <DiffLines lines={lines} />
          ) : (
            <div className="max-h-72 overflow-auto px-3 py-2 text-body">
              <Markdown text={body} />
            </div>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void decide(false)}
          icon={<X className="size-3.5" />}
        >
          {t.discard}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          onClick={() => void decide(true)}
          icon={<Check className="size-3.5" />}
        >
          {t.keep}
        </Button>
      </div>
    </motion.div>
  )
}

/** Skills proposed from this chat's work that the person has not decided on yet. */
export function SkillCards({ state }: { state: ColonyState }) {
  const pending = Object.values(state.skillProposals).filter((p) => p.kept === undefined)
  return (
    <AnimatePresence initial={false}>
      {pending.map((p) => (
        <SkillProposalCard key={p.id} proposal={p} />
      ))}
    </AnimatePresence>
  )
}
