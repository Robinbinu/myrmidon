import { AnimatePresence } from 'motion/react'
import { useEffect, useState } from 'react'
import { api, post } from './api.ts'
import { copy } from './copy.ts'
import type { SkillScanView } from './installs.tsx'
import { settingRow } from './settings/Setting.tsx'
import { ConfirmButton } from './ui/ConfirmButton.tsx'
import { FEATURE_ICONS } from './ui/icons.ts'
import { Badge, Banner, Button, Empty, SectionHeader, Skeleton } from './ui/primitives.tsx'
import { Sheet } from './ui/Sheet.tsx'
import { useToast } from './ui/Toast.tsx'

const t = copy.skillImports

type Origin = keyof typeof t.origins

/** A Claude Code or Codex skill as the server lists it (packages/runtime/src/skill-import.ts ImportableSkill). */
export interface ImportableSkillView {
  id: string
  origin: Origin
  name: string
  importAs: string
  description: string
  dir: string
  plugin?: string
  displayName?: string
  requires?: string[]
  license?: string
  alreadyImported: boolean
  importedAs?: string
  disabledThere?: boolean
  scan: SkillScanView
}

interface ImportResult {
  imported: { id: string; name: string }[]
  skipped: { id: string; name?: string; reason: string; error?: string }[]
}

const VERDICT_TONE = { clean: 'ok', warn: 'warn', block: 'bad' } as const

/** Settings → Skills: the way in to importing Claude Code and Codex skills. */
export function ImportSkills(props: { onImported(): void }) {
  const [open, setOpen] = useState(false)
  const Icon = FEATURE_ICONS.skillImport
  return (
    <div {...settingRow('skills.import')} className="mb-6">
      <SectionHeader icon={<Icon className="size-4 text-muted" />} title={t.title} />
      <p className="mb-3 mt-1 text-footnote text-muted">{t.intro}</p>
      <Button onClick={() => setOpen(true)}>{t.open}</Button>
      <AnimatePresence>
        {open && (
          <ImportSkillsSheet
            onClose={() => setOpen(false)}
            onImported={() => {
              setOpen(false)
              props.onImported()
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * The picker: the person's Claude Code and Codex skills by where they are, each with its scan's verdict. Those already
 * here cannot be picked; one the scan blocks is imported only by its own "Import anyway".
 */
export function ImportSkillsSheet(props: { onClose(): void; onImported(): void }) {
  const toast = useToast()
  const [skills, setSkills] = useState<ImportableSkillView[]>()
  const [error, setError] = useState<string>()
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    api<{ skills: ImportableSkillView[] }>('/api/skill-imports')
      .then((r) => live && setSkills(r.skills))
      .catch((err: Error) => live && setError(err.message))
    return () => {
      live = false
    }
  }, [])
  const pickable = (s: ImportableSkillView) => !s.alreadyImported && s.scan.verdict !== 'block'
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const run = async (ids: string[], override: string[] = []) => {
    setBusy(true)
    try {
      const r = await post<ImportResult>('/api/skill-imports', {
        ids,
        ...(override.length ? { override } : {}),
      })
      if (r.imported.length)
        toast(
          `${t.imported(r.imported.map((x) => x.name))}${r.skipped.length ? `. ${t.skipped(r.skipped.length)}` : ''}`,
          'success',
        )
      for (const s of r.skipped.filter((x) => x.error)) toast(`${s.name}: ${s.error}`, 'error')
      props.onImported()
    } catch (err) {
      toast((err as Error).message, 'error')
      setBusy(false)
    }
  }
  const groups = (Object.keys(t.origins) as Origin[])
    .map((origin) => ({ origin, skills: (skills ?? []).filter((s) => s.origin === origin) }))
    .filter((g) => g.skills.length)
  return (
    <Sheet
      title={t.sheetTitle}
      onClose={() => !busy && props.onClose()}
      size="md"
      // In the title bar, so it stays in reach however long the list is.
      actions={
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          disabled={!picked.size}
          onClick={() => void run([...picked])}
        >
          {busy ? t.importing : t.import(picked.size)}
        </Button>
      }
    >
      {!skills && !error ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <p className="text-callout text-muted">{t.loading}</p>
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : !skills ? (
        <Banner tone="bad" role="alert">
          {t.failed}: {error}
        </Banner>
      ) : !skills.length ? (
        <Empty icon={<FEATURE_ICONS.skillImport className="size-5" />} title={t.empty}>
          {t.emptyHint}
        </Empty>
      ) : (
        <div {...settingRow('skills.import')} className="flex flex-col gap-5">
          <p className="text-callout text-muted">{t.footnote}</p>
          {groups.map((g) => (
            <section key={g.origin} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <h3 className="flex-1 text-small font-semibold uppercase tracking-wide text-muted">
                  {t.origins[g.origin]}
                </h3>
                {g.skills.some(pickable) && (
                  <Button
                    size="sm"
                    variant="borderless"
                    disabled={busy}
                    onClick={() =>
                      setPicked((p) => new Set([...p, ...g.skills.filter(pickable).map((s) => s.id)]))
                    }
                  >
                    {t.selectAll}
                  </Button>
                )}
              </div>
              <ul className="flex flex-col overflow-hidden rounded-lg border border-line">
                {g.skills.map((s) => (
                  <li key={s.id} className="border-line border-t first:border-t-0">
                    <SkillRow
                      skill={s}
                      picked={picked.has(s.id)}
                      disabled={busy}
                      onToggle={() => toggle(s.id)}
                      onAnyway={() => void run([s.id], [s.id])}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Sheet>
  )
}

function SkillRow(props: {
  skill: ImportableSkillView
  picked: boolean
  disabled: boolean
  onToggle(): void
  onAnyway(): void
}) {
  const s = props.skill
  const blocked = s.scan.verdict === 'block'
  const off = s.disabledThere && (s.origin.startsWith('claude') ? t.offThere.claude : t.offThere.codex)
  return (
    <div className="flex items-start gap-3 px-3 py-2">
      {/* The label is the 24px target; the box itself is the browser's 13px. */}
      <label className="-m-1 grid size-6 shrink-0 cursor-pointer place-items-center">
        <input
          type="checkbox"
          aria-label={t.pick(s.name)}
          checked={props.picked || s.alreadyImported}
          disabled={props.disabled || s.alreadyImported || blocked}
          onChange={props.onToggle}
        />
      </label>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-body font-medium" title={s.dir}>
            {s.name}
          </span>
          {s.displayName && <span className="text-small text-muted">{s.displayName}</span>}
          {s.plugin && <Badge>{t.plugin(s.plugin)}</Badge>}
          <Badge tone={VERDICT_TONE[s.scan.verdict]}>{t.verdict[s.scan.verdict]}</Badge>
          {s.alreadyImported ? (
            <Badge tone="ok">
              {s.importedAs && s.importedAs !== s.name ? t.alreadyAs(s.importedAs) : t.already}
            </Badge>
          ) : (
            s.importAs !== s.name && (
              <span title={t.renamedHint}>
                <Badge tone="accent">{t.renamed(s.importAs)}</Badge>
              </span>
            )
          )}
          {off && <Badge tone="warn">{off}</Badge>}
        </div>
        <p className="mt-0.5 line-clamp-2 text-callout text-fg-2">{s.description}</p>
        {!!s.requires?.length && <p className="mt-0.5 text-footnote text-muted">{t.needs(s.requires)}</p>}
      </div>
      {blocked && !s.alreadyImported && (
        <ConfirmButton
          label={t.importAnyway}
          name={`${t.importAnyway} ${s.name}`}
          confirm={t.confirmAnyway}
          warning={t.anywayWarning}
          disabled={props.disabled}
          onConfirm={props.onAnyway}
        />
      )}
    </div>
  )
}
