import { LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ApiError, post } from '../api.ts'
import { copy } from '../copy.ts'
import { Banner, Button, TextArea } from '../ui/primitives.tsx'
import { Sheet } from '../ui/Sheet.tsx'

/** What the server drafted from the complaint (runtime rule-draft.ts `RuleDraft`). */
interface RuleDraft {
  readonly name: string
  readonly description: string
  readonly condition: readonly string[]
  readonly scope: readonly string[]
  readonly body: string
  readonly text: string
  readonly matched: boolean
  readonly note?: string
}

type Where = 'person' | 'project'

/**
 * `/rule`: the lead's model drafts a stream rule from the person's complaint about the last reply, and the person
 * saves it (for every chat, or the chat's project), asks for a change, or drops it, as omp's `/omfg` panel offers.
 * A rule of the same name is replaced only once the person says so.
 */
export function RuleSheet(props: {
  chatId: string
  complaint: string
  /** The chat works in a project, so the rule can be saved there. */
  project: boolean
  onClose(): void
  onSaved(name: string, where: Where): void
}) {
  const t = copy.rules.sheet
  const [draft, setDraft] = useState<RuleDraft>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(true)
  const [change, setChange] = useState('')
  const [exists, setExists] = useState<{ name: string; where: Where }>()
  const asked = useRef(false)

  const write = async (amend?: { previous: string; change: string }) => {
    setBusy(true)
    setError(undefined)
    setExists(undefined)
    try {
      const r = await post<{ draft: RuleDraft }>(`/api/chats/${props.chatId}/rule`, {
        complaint: props.complaint,
        ...(amend ? { amend } : {}),
      })
      setDraft(r.draft)
      setChange('')
    } catch (err) {
      setError(t.failed(String((err as Error).message ?? err)))
    } finally {
      setBusy(false)
    }
  }

  // Drafting starts once the sheet is open; a second mount in development must not ask twice.
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void write()
  })

  const save = async (where: Where, replace = false) => {
    if (!draft) return
    setBusy(true)
    setError(undefined)
    try {
      const r = await post<{ name: string }>('/api/rules', {
        name: draft.name,
        text: draft.text,
        where,
        chatId: props.chatId,
        ...(replace ? { replace: true } : {}),
      })
      props.onSaved(r.name, where)
    } catch (err) {
      const taken =
        err instanceof ApiError && typeof err.body?.exists === 'string' ? err.body.exists : undefined
      if (taken) setExists({ name: taken, where })
      else setError(String((err as Error).message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title={t.title} onClose={props.onClose} size="md">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-small font-medium text-muted">{t.complaint}</p>
          <p className="text-body text-fg">{props.complaint}</p>
        </div>
        {busy && !draft && (
          <p className="flex items-center gap-2 text-callout text-muted" role="status">
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
            {t.drafting}
          </p>
        )}
        {error && (
          <Banner tone="bad" role="alert">
            {error}
          </Banner>
        )}
        {draft && (
          <>
            <Banner tone={draft.matched ? 'ok' : 'warn'} role="status">
              {draft.matched ? t.matched : `${t.unconfirmed} ${draft.note ?? ''}`}
            </Banner>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-callout">
              <dt className="text-muted">{t.name}</dt>
              <dd className="min-w-0">
                <span className="font-medium text-fg">{draft.name}</span>
                {draft.description && <span className="text-fg-2"> · {draft.description}</span>}
              </dd>
              <dt className="text-muted">{t.pattern}</dt>
              <dd className="min-w-0 break-all font-mono text-fg">{draft.condition.join('  |  ')}</dd>
              <dt className="text-muted">{t.scope}</dt>
              <dd className="min-w-0 font-mono text-fg">{draft.scope.join(', ')}</dd>
              <dt className="text-muted">{t.guidance}</dt>
              <dd className="min-w-0 whitespace-pre-wrap text-fg">{draft.body}</dd>
            </dl>
            <details className="text-callout text-muted">
              <summary className="cursor-default">{t.file}</summary>
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-code px-3 py-2 font-mono text-callout text-fg">
                {draft.text}
              </pre>
            </details>
            <div className="flex items-end gap-2">
              <TextArea
                aria-label={t.amend}
                className="min-h-0 flex-1"
                rows={2}
                value={change}
                placeholder={t.amendPlaceholder}
                onChange={(e) => setChange(e.target.value)}
              />
              <Button
                disabled={busy || !change.trim()}
                onClick={() => void write({ previous: draft.text, change: change.trim() })}
              >
                {t.redraft}
              </Button>
            </div>
          </>
        )}
        {exists && (
          <Banner tone="warn" role="alert">
            {t.exists(exists.name)}
          </Banner>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="borderless" onClick={props.onClose}>
            {t.cancel}
          </Button>
          {error && !draft && (
            <Button disabled={busy} onClick={() => void write()}>
              {t.tryAgain}
            </Button>
          )}
          {exists ? (
            <Button variant="primary" disabled={busy} onClick={() => void save(exists.where, true)}>
              {t.replace(exists.name)}
            </Button>
          ) : (
            draft && (
              <>
                {props.project && (
                  <Button disabled={busy} onClick={() => void save('project')}>
                    {t.saveProject}
                  </Button>
                )}
                <Button variant="primary" disabled={busy} loading={busy} onClick={() => void save('person')}>
                  {t.saveMine}
                </Button>
              </>
            )
          )}
        </div>
      </div>
    </Sheet>
  )
}
