import type {
  ColonyState,
  PermissionOffer,
  PermissionRule,
  PermissionScope,
  Review,
  ReviewField,
} from '@myrmidon/protocol'
import { BookmarkPlus, Check, ChevronDown, Info, PencilLine, TriangleAlert, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { type ReactNode, useMemo, useRef, useState } from 'react'
import { send } from '../api.ts'
import { copy } from '../copy.ts'
import { useScope } from '../DeviceGate.tsx'
import { type DiffLine, diffLines } from '../diff.ts'
import { sourceText, targetText } from '../permissions/describe.ts'
import { useArmGuard } from '../ui/ConfirmButton.tsx'
import { MenuItem, MenuList, MenuSeparator, Popover } from '../ui/Popover.tsx'
import { Button, cn, TextArea, TextInput } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import { APPROVAL_MENU_PX, APPROVAL_MENU_ROOM_PX, spring } from '../ui-config.ts'
import { Markdown } from './Markdown.tsx'
import { useOpenProjectFile } from './ProjectFiles.tsx'

/** What an agent asked to do, as a verb for the card. */
const action = (tool: string) =>
  tool === 'shell' || tool === 'start_server'
    ? copy.approvals.actions.shell
    : tool === 'fs_write' || tool === 'fs_edit'
      ? copy.approvals.actions.file
      : tool === 'request_read'
        ? copy.approvals.actions.read
        : copy.approvals.actions.use(tool.replace(/^mcp__/, '').replaceAll('_', ' '))

import { FEATURE_ICONS } from '../ui/icons.ts'
import type { Pending } from './approvals.ts'

/**
 * A call that waited for the person (the preset or a rule asked, an MCP tool that changes things, a change an agent
 * proposes), where it came up in the chat. While it waits it shows what it would do in full, where there is a change
 * to show, why it asked, and Allow once or Deny, each with a menu to remember the answer for this chat, this project
 * or everywhere; text fields can be rewritten first and what runs is the person's version. Once decided it stays as
 * one line saying what was decided.
 */
export function Approval({
  colonyId,
  chatId,
  project,
  request,
}: {
  colonyId: string
  /** The chat the round belongs to: where "for this chat" applies. */
  chatId?: string | undefined
  /** The round's project, when it has one: where "for this project" applies. */
  project?: string | undefined
  request: Pending
}) {
  return request.decided ? (
    <ApprovalRecord request={request} decided={request.decided} />
  ) : (
    <ApprovalCard colonyId={colonyId} chatId={chatId} project={project} request={request} />
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
  const openFile = useOpenProjectFile()
  const [open, setOpen] = useState(false)
  const what = a.review?.title ?? a.summary
  // An allowed file change can still be opened: what it changed, and the file itself.
  const file = decided.approved && a.review?.kind === 'file' ? a.review.fields[0]?.label : undefined
  const line = decided.approved
    ? decided.edits && Object.keys(decided.edits).length
      ? t.approvedEdited(what)
      : t.approved(what)
    : decided.by === 'timeout'
      ? t.timedOut(what)
      : decided.by === 'stopped'
        ? t.stopped(what)
        : t.denied(what)
  const text = (
    <>
      {line}
      {decided.note && <span className="text-fg-2"> · {decided.note}</span>}
    </>
  )
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={spring}
      className="flex flex-col gap-1.5 pl-11"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-callout text-muted">
        {decided.approved ? (
          <Check className="size-3.5 shrink-0 text-ok-ink" />
        ) : (
          <X className="size-3.5 shrink-0 text-bad-ink" />
        )}
        {a.review ? (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            title={decided.note ? t.withNote(line, decided.note) : line}
            className="flex min-w-0 items-center gap-1 rounded-md text-left transition-colors hover:text-fg-2"
          >
            <span className="min-w-0 truncate">{text}</span>
            <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', !open && '-rotate-90')} />
          </button>
        ) : (
          <span className="min-w-0 truncate" title={decided.note ? t.withNote(line, decided.note) : line}>
            {text}
          </span>
        )}
        {file && openFile && (
          <button
            type="button"
            onClick={() => openFile(file)}
            title={copy.projectFile.open(file)}
            aria-label={copy.projectFile.open(file)}
            className="grid size-5 shrink-0 place-items-center rounded-md transition-colors hover:bg-fill hover:text-fg"
          >
            <FEATURE_ICONS.projectFile className="size-3.5" />
          </button>
        )}
      </div>
      {open && a.review && (
        <div className="flex flex-col gap-2">
          {a.review.fields.map((f) => (
            <div key={f.key} className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="border-b border-line px-3 py-1.5 font-mono text-small text-fg-2">{f.label}</div>
              <FieldView field={f} value={decided.edits?.[f.key] ?? f.value} />
            </div>
          ))}
        </div>
      )}
    </motion.div>
  )
}

function ApprovalCard({
  colonyId,
  chatId,
  project,
  request: a,
}: {
  colonyId: string
  chatId?: string | undefined
  project?: string | undefined
  request: Pending
}) {
  const toast = useToast()
  const full = useScope() === 'full'
  const [busy, setBusy] = useState(false)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const changed = Object.entries(edits).filter(
    ([key, value]) => a.review?.fields.find((f) => f.key === key)?.value !== value,
  )
  // Where an answer may be remembered: this chat, its project, everywhere. A chats-only device keeps to the chat. A
  // folder of keys or sign-ins is allowed once or for this chat (its own button), never remembered wider.
  const scopes: PermissionScope[] = a.sensitive
    ? []
    : [
        ...(chatId ? (['chat'] as const) : []),
        ...(project && full ? (['project'] as const) : []),
        ...(full ? (['global'] as const) : []),
      ]
  // The server lets a chats-only device remember only a named step, never every command, file change or tool.
  const offers = (a.offer ?? []).filter((o) => full || o.target !== '*')
  const choices = scopes.length ? choicesOf(offers) : []
  /** `remember`: the rules saved with the answer, and where. */
  const decide = async (
    approved: boolean,
    remember?: { scope: PermissionScope; rules: PermissionRule[] },
  ) => {
    setBusy(true)
    try {
      await send('POST', `/api/colonies/${colonyId}/approvals/${a.id}`, {
        approved,
        ...(approved && changed.length ? { edits: Object.fromEntries(changed) } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(remember ? { remember } : {}),
      })
      if (remember)
        toast(
          copy.permissions.card.remembered(
            remember.rules.map(targetText).join(copy.permissions.card.and),
            copy.permissions.card.scopes[remember.scope],
          ),
          'success',
        )
    } catch (err) {
      toast(String((err as Error).message), 'error')
      setBusy(false)
    }
  }
  // This request is answered first, so the note typed on it goes with it; allowing the folder for the chat then
  // answers the other requests to read it already waiting.
  const readForChat = async () => {
    if (!a.read || !chatId) return
    setBusy(true)
    try {
      await send('POST', `/api/colonies/${colonyId}/approvals/${a.id}`, {
        approved: true,
        ...(note.trim() ? { note: note.trim() } : {}),
      })
    } catch (err) {
      toast(String((err as Error).message), 'error')
      setBusy(false)
      return
    }
    // The read itself is allowed by now and its card is going; only the chat-wide part can still fail.
    try {
      await send('PUT', `/api/chats/${chatId}/readable`, { folder: a.read, allowed: true })
      toast(copy.approvals.reads.allowed(a.read), 'success')
    } catch (err) {
      toast(copy.approvals.reads.onceOnly(a.read, String((err as Error).message)), 'error')
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
        <FEATURE_ICONS.approvalAsk className="size-4 shrink-0 text-warn-ink" />
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
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-surface px-3 py-2 font-mono text-callout">
          {a.summary}
        </pre>
      )}
      {a.sensitive && (
        <p role="note" className="flex items-start gap-1.5 text-callout text-warn-ink">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {copy.approvals.reads.sensitive}
        </p>
      )}
      {a.why && (
        <p className="flex items-center gap-1.5 text-small text-muted">
          <Info className="size-3.5 shrink-0" aria-hidden />
          {sourceText(a.why, 'ask')}
        </p>
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
        <SplitButton
          variant="borderless"
          icon={<X className="size-3.5" />}
          label={copy.permissions.card.denyOnce}
          menuLabel={copy.permissions.card.moreDeny}
          busy={busy}
          onClick={() => void decide(false)}
          choices={choices}
          scopes={scopes}
          heading={copy.permissions.card.denyAlways}
          decision="deny"
          onRemember={(scope, rules) =>
            void decide(false, {
              scope,
              rules: rules.map(({ projectCode: _, ...r }) => ({ ...r, decision: 'deny' as const })),
            })
          }
        />
        {/* Opening a folder for the whole chat is a full-access device's call; on others the server refuses it. */}
        {a.read && chatId && full && (
          <Button
            variant="push"
            disabled={busy}
            onClick={() => void readForChat()}
            icon={<FEATURE_ICONS.readAccess className="size-3.5" />}
          >
            {copy.approvals.reads.approveAll}
          </Button>
        )}
        <SplitButton
          variant="primary"
          icon={<Check className="size-3.5" />}
          label={changed.length ? copy.approvals.review.approveEdited : copy.permissions.card.allowOnce}
          menuLabel={copy.permissions.card.moreAllow}
          busy={busy}
          onClick={() => void decide(true)}
          choices={choices}
          scopes={scopes}
          heading={copy.permissions.card.allowAlways}
          decision="allow"
          onRemember={(scope, rules) =>
            void decide(true, {
              scope,
              rules: rules.map(({ projectCode: _, ...r }) => ({ ...r, decision: 'allow' as const })),
            })
          }
        />
      </div>
    </motion.div>
  )
}

type Offer = PermissionOffer

/** A rule for every command or every MCP tool, rather than one of them. */
const wide = (o: Offer) => o.target === '*' && o.kind !== 'edit'

/**
 * What a card offers to remember, most specific first. A compound command's parts are one choice, remembered together
 * (as Claude Code saves a rule per part), so the same command runs next time; then every command.
 */
function choicesOf(offers: readonly Offer[]): { label: string; rules: Offer[] }[] {
  const parts = offers.filter((o) => o.kind === 'command' && o.target !== '*')
  if (parts.length < 2) return offers.map((o) => ({ label: targetText(o), rules: [o] }))
  return [
    { label: parts.map(targetText).join(copy.permissions.card.and), rules: parts },
    ...offers.filter((o) => !parts.includes(o)).map((o) => ({ label: targetText(o), rules: [o] })),
  ]
}

/**
 * A card's button with its menu beside it, as Claude Code's "Yes, and don't ask again for …": the button answers this
 * once; the chevron opens what to remember (the offers, most specific first) and where (this chat, this project,
 * everywhere), and choosing where answers and remembers in one go. Without offers it is a plain button.
 */
function SplitButton(props: {
  variant: 'primary' | 'borderless'
  icon: ReactNode
  label: string
  menuLabel: string
  heading: string
  busy: boolean
  onClick(): void
  choices: readonly { label: string; rules: Offer[] }[]
  scopes: readonly PermissionScope[]
  /** What remembering saves, for the confirmation of a wide one. */
  decision: 'allow' | 'deny'
  onRemember(scope: PermissionScope, rules: Offer[]): void
}) {
  const [open, setOpen] = useState(false)
  // A remembered answer for every chat, or for every command or MCP tool, waits for a second, spelled-out yes: one
  // stray click would otherwise stop agents asking about anything of its kind.
  const [confirming, setConfirming] = useState<PermissionScope>()
  const guard = useArmGuard()
  // A card near the top of the chat opens its menu downward, so the menu is never cut off under the title bar.
  const [up, setUp] = useState(true)
  const [pick, setPick] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const choice = props.choices[pick] ?? props.choices[0]
  const primary = props.variant === 'primary'
  if (!choice)
    return (
      <Button variant={props.variant} disabled={props.busy} onClick={props.onClick} icon={props.icon}>
        {props.label}
      </Button>
    )
  const t = copy.permissions.card
  return (
    <div ref={box} className="relative inline-flex">
      <Button
        variant={props.variant}
        disabled={props.busy}
        onClick={props.onClick}
        icon={props.icon}
        className="rounded-r-none"
      >
        {props.label}
      </Button>
      <Button
        variant={props.variant}
        disabled={props.busy}
        aria-label={props.menuLabel}
        title={props.menuLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setUp(
            (box.current?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY) > APPROVAL_MENU_ROOM_PX,
          )
          setOpen(!open)
        }}
        className={cn(
          'rounded-l-none px-1.5',
          primary ? 'border-l border-on-accent/25' : 'border-l border-line',
        )}
      >
        <ChevronDown className="size-3.5" />
      </Button>
      <AnimatePresence>
        {open && (
          <Popover
            role="dialog"
            label={props.menuLabel}
            onClose={() => {
              setOpen(false)
              setConfirming(undefined)
            }}
            within={box}
            up={up}
            style={{ width: APPROVAL_MENU_PX }}
            className={cn(
              'material-menu absolute right-0 z-40 rounded-lg border border-line p-1.5',
              up ? 'bottom-[calc(100%+6px)] origin-bottom-right' : 'top-[calc(100%+6px)] origin-top-right',
            )}
          >
            <div className="px-2 pb-1 pt-1 section-label text-muted">{props.heading}</div>
            {props.choices.length > 1 ? (
              <MenuList label={props.heading}>
                {props.choices.map((c, i) => (
                  <MenuItem
                    key={c.label}
                    checked={i === pick}
                    title={<span className={c.rules[0]?.target === '*' ? '' : 'font-mono'}>{c.label}</span>}
                    onSelect={() => {
                      setPick(i)
                      setConfirming(undefined)
                    }}
                  />
                ))}
              </MenuList>
            ) : (
              <p className="truncate px-2 pb-1.5 font-mono text-body text-fg">{choice.label}</p>
            )}
            {/* A test, script or build step runs what the crew writes: remembered beyond this chat, it covers that too. */}
            {choice.rules.some((r) => r.projectCode) && props.scopes.some((s) => s !== 'chat') && (
              <p className="px-2 pb-1.5 text-callout leading-snug text-warn-ink">{t.projectCode}</p>
            )}
            <MenuSeparator />
            {confirming ? (
              <div className="flex flex-col gap-2 px-2 pb-1 pt-1">
                <p role="alert" className="text-callout leading-snug text-bad-ink">
                  {t.confirm.warning[props.decision]}
                </p>
                <Button
                  size="sm"
                  variant="danger"
                  autoFocus
                  className="h-auto min-h-6 whitespace-normal py-1 text-left"
                  onKeyDown={(e) => guard.repeat(e)}
                  onClick={() => {
                    // The Enter held, or the double-click, that chose "Everywhere" must not also say yes here.
                    if (guard.tooSoon()) return
                    setOpen(false)
                    setConfirming(undefined)
                    props.onRemember(confirming, choice.rules)
                  }}
                >
                  {t.confirm[props.decision](
                    choice.rules.map(targetText).join(t.and),
                    t.confirm.where[confirming],
                  )}
                </Button>
                <Button size="sm" variant="borderless" onClick={() => setConfirming(undefined)}>
                  {t.confirm.back}
                </Button>
              </div>
            ) : (
              <>
                <div className="px-2 pb-1 pt-1 section-label text-muted">{t.rememberIn}</div>
                <MenuList label={t.rememberIn}>
                  {props.scopes.map((scope, i) => (
                    <MenuItem
                      key={scope}
                      tabStop={i === 0 && props.choices.length === 1}
                      title={t.scopes[scope]}
                      detail={t.scopeHint[scope]}
                      onSelect={() => {
                        if (scope === 'global' || choice.rules.some(wide)) {
                          guard.arm()
                          return setConfirming(scope)
                        }
                        setOpen(false)
                        props.onRemember(scope, choice.rules)
                      }}
                    />
                  ))}
                </MenuList>
              </>
            )}
          </Popover>
        )}
      </AnimatePresence>
    </div>
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
          <div key={f.key} className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-small">
              <span className="min-w-0 truncate font-mono text-fg-2">{f.label}</span>
              {value !== f.value && <span className="text-accent-fg">{copy.approvals.review.edited}</span>}
              {f.editable && (
                // Named by what it shows, then which field, so speech control finds it by its visible words.
                <button
                  type="button"
                  onClick={() => setEditing(isEditing ? undefined : f.key)}
                  className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted transition-colors hover:bg-fill hover:text-fg"
                >
                  <PencilLine className="size-3.5" />
                  {isEditing ? copy.approvals.review.preview : copy.approvals.review.edit}
                  <span className="sr-only"> {f.label}</span>
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
export function DiffLines({ lines }: { lines: readonly DiffLine[] }) {
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
          <div key={`f${r.i}`} className="bg-fill/60 px-3 py-0.5 text-footnote text-muted">
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

const CHIP =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl pr-1 pl-2 text-callout font-medium text-muted'
const CHIP_CLOSE =
  'inline-flex size-5 items-center justify-center rounded-md transition-colors hover:bg-fill hover:text-fg'

/**
 * Folders the person let agents read for the rest of a chat (from a read request's card), as chips beside the message
 * box. Removing one hides that folder again from the next read. Remembered rules are in the chat's permission control.
 */
export function ChatReadChips(props: { chatId: string; reads: readonly string[]; onChanged(): void }) {
  const toast = useToast()
  const r = copy.approvals.reads
  const take = async (folder: string) => {
    try {
      await send('PUT', `/api/chats/${props.chatId}/readable`, { folder, allowed: false })
      toast(r.revoked(folder), 'info')
      props.onChanged()
    } catch (err) {
      toast(String((err as Error).message), 'error')
    }
  }
  return props.reads.map((folder) => (
    <span key={`read:${folder}`} title={r.chipTitle(folder)} className={CHIP}>
      <FEATURE_ICONS.readAccess className="size-3.5 shrink-0 text-ok-ink" />
      <span className="max-w-48 truncate">{r.chip(folder.split('/').filter(Boolean).at(-1) ?? folder)}</span>
      <button
        type="button"
        onClick={() => void take(folder)}
        aria-label={r.revoke(folder)}
        className={CHIP_CLOSE}
      >
        <X className="size-3" />
      </button>
    </span>
  ))
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
            <FEATURE_ICONS.siteSignIn className="size-4 shrink-0 text-accent-fg" />
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
              icon={<FEATURE_ICONS.computer className="size-3.5" />}
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
          <p className="rounded-xl bg-surface px-3 py-2 text-reading">
            <span className="mr-1.5 section-label text-muted">{m.kind}</span>
            {m.text}
          </p>
          {m.why && <p className="text-small text-muted">{copy.approvals.memory.why(m.why)}</p>}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="borderless"
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
        <FEATURE_ICONS.skills className="size-4 shrink-0 text-accent-fg" />
        <span className="min-w-0">
          {p.update ? t.improve : t.learned} <span className="font-mono font-semibold">{p.name}</span>
        </span>
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          aria-pressed={editing}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-small text-muted transition-colors hover:bg-fill hover:text-fg"
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
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
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
          variant="borderless"
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
