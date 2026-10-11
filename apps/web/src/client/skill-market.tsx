import { AnimatePresence } from 'motion/react'
import { useEffect, useState } from 'react'
import { api, post, send } from './api.ts'
import { copy } from './copy.ts'
import type { Review, SkillPreviewView } from './installs.tsx'
import type { SettingId } from './settings/registry.ts'
import { settingRow } from './settings/Setting.tsx'
import { FEATURE_ICONS } from './ui/icons.ts'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardRow,
  SectionHeader,
  Segmented,
  Switch,
  Tabs,
  TextInput,
  tabPanel,
} from './ui/primitives.tsx'
import { Sheet } from './ui/Sheet.tsx'
import { useToast } from './ui/Toast.tsx'

/**
 * Browse skills (Settings → Skills): the public skill catalogs the server's SkillMarketplace reads
 * (packages/runtime/src/skill-market.ts), searched together or listed one at a time. "Review & install" fetches the
 * skill into the same review as every install, where the skill scan and the source's own audit are shown.
 */

/** A source's or a third party's check of a skill (packages/runtime/src/skill-installs.ts SkillAudit). */
export interface SkillAuditView {
  by: string
  status: 'pass' | 'warn' | 'fail' | 'unknown'
  summary?: string
  url?: string
  checks: { name: string; status: SkillAuditView['status']; summary?: string }[]
}

interface SourceView {
  id: string
  name: string
  url: string
  enabled: boolean
  optIn: boolean
  views: string[]
}

interface HitView {
  source: string
  id: string
  name: string
  description: string
  author?: string
  license?: string
  version?: string
  installs?: number
  weeklyDownloads?: number
  stars?: number
  url?: string
  audit?: SkillAuditView
  flagged?: boolean
  installRef: string
}

interface ResultsView {
  hits?: HitView[]
  errors?: { source: string; error: string }[]
}

const t = copy.settings.skills.market

const AUDIT_TONE = { pass: 'ok', warn: 'warn', fail: 'bad', unknown: 'neutral' } as const

const sourceName = (id: string, sources?: SourceView[]) =>
  t.sources[id]?.name ?? sources?.find((s) => s.id === id)?.name ?? id

/** A source's audit as one badge: who checked it and how it went. */
export function AuditBadge(props: { audit: SkillAuditView }) {
  const { audit } = props
  return (
    <span title={audit.checks.map((c) => `${c.name}: ${t.audit[c.status]}`).join('\n')}>
      <Badge tone={AUDIT_TONE[audit.status]}>{t.auditBadge(audit.by, t.audit[audit.status])}</Badge>
    </span>
  )
}

/** A source's audit in an install's review, each check listed, beside (not instead of) Myrmidon's own scan. */
export function AuditSummary(props: { audit: SkillAuditView }) {
  const { audit } = props
  return (
    <div className="flex flex-col gap-1.5">
      <SectionHeader title={t.auditTitle(audit.by)} />
      <div className="flex flex-wrap items-center gap-2">
        <AuditBadge audit={audit} />
        {audit.summary && <span className="text-fg-2">{audit.summary}</span>}
      </div>
      {audit.checks.length > 0 && (
        <ul className="flex flex-col gap-1 text-footnote">
          {audit.checks.map((c) => (
            <li key={c.name} className="flex flex-wrap items-baseline gap-2">
              <Badge tone={AUDIT_TONE[c.status]}>{t.audit[c.status]}</Badge>
              <span className="font-medium">{c.name}</span>
              {c.summary && <span className="line-clamp-2 text-muted">{c.summary}</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-footnote text-muted">{t.auditNote}</p>
    </div>
  )
}

function HitRow(props: {
  hit: HitView
  sources?: SourceView[]
  installed: boolean
  fetching?: string
  onReview(hit: HitView): void
}) {
  const h = props.hit
  const meta = [
    h.author && t.by(h.author),
    h.version && `v${h.version}`,
    h.installs !== undefined
      ? t.installs(h.installs)
      : h.weeklyDownloads !== undefined && t.weekly(h.weeklyDownloads),
    h.stars !== undefined && t.stars(h.stars),
  ].filter((x): x is string => !!x)
  return (
    <CardRow className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-body font-medium" title={h.id}>
            {h.name}
          </span>
          <Badge>{sourceName(h.source, props.sources)}</Badge>
          {h.license && (
            <span className="max-w-[16rem] truncate text-small text-muted" title={h.license}>
              {h.license}
            </span>
          )}
          {h.audit ? (
            <AuditBadge audit={h.audit} />
          ) : (
            h.source === 'clawhub' && <span className="text-small text-muted">{t.verdictAtReview}</span>
          )}
          {h.flagged && <Badge tone="bad">{t.flagged}</Badge>}
          {props.installed && <Badge tone="ok">{t.installed}</Badge>}
        </div>
        {h.description && <p className="mt-0.5 line-clamp-2 text-callout text-fg-2">{h.description}</p>}
        <p className="mt-0.5 truncate text-footnote text-muted">
          {meta.join(' · ')}
          {h.url && (
            <>
              {meta.length > 0 && ' · '}
              <a href={h.url} target="_blank" rel="noreferrer" className="hover:underline">
                {t.page}
              </a>
            </>
          )}
        </p>
      </div>
      {!props.installed && (
        <Button
          size="sm"
          loading={props.fetching === h.installRef}
          disabled={!!props.fetching}
          onClick={() => props.onReview(h)}
        >
          {t.review}
        </Button>
      )}
    </CardRow>
  )
}

/** The browser: source tabs, a search across them, a source's lists, and a card per skill. */
function BrowseSheet(props: {
  sources: SourceView[]
  installed: readonly string[]
  onClose(): void
  onReview(review: Review): void
}) {
  const toast = useToast()
  const enabled = props.sources.filter((s) => s.enabled)
  const [tab, setTab] = useState('all')
  const [view, setView] = useState<string>()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ResultsView>()
  const [busy, setBusy] = useState(false)
  const [fetching, setFetching] = useState<string>()
  const source = enabled.find((s) => s.id === tab)
  const run = async (path: string) => {
    setBusy(true)
    try {
      setResults(await api<ResultsView>(path))
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }
  const search = (q: string, where = tab) =>
    run(
      `/api/skill-market/search?q=${encodeURIComponent(q)}${where === 'all' ? '' : `&sources=${encodeURIComponent(where)}`}`,
    )
  const browse = (id: string, v: string) =>
    run(`/api/skill-market/browse?source=${encodeURIComponent(id)}&view=${encodeURIComponent(v)}`)
  const pick = (id: string) => {
    setTab(id)
    setResults(undefined)
    const s = enabled.find((x) => x.id === id)
    const first = s?.views[0]
    setView(first)
    if (query.trim()) void search(query.trim(), id)
    else if (s && first) void browse(s.id, first)
  }
  const review = async (hit: HitView) => {
    setFetching(hit.installRef)
    try {
      const r = await post<{ preview: SkillPreviewView }>('/api/skill-market/install', {
        ref: hit.installRef,
      })
      props.onReview({ kind: 'skill', preview: r.preview })
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setFetching(undefined)
    }
  }
  const hits = results?.hits ?? []
  return (
    <Sheet title={t.title} onClose={props.onClose} size="lg" flush>
      <Tabs
        id="skill-market"
        value={tab}
        onChange={pick}
        tabs={[{ value: 'all', label: t.all }, ...enabled.map((s) => ({ value: s.id, label: s.name }))]}
      />
      <div
        {...tabPanel('skill-market', tab)}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        <form
          {...settingRow('skills.market.search')}
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            const q = query.trim()
            if (busy) return
            if (q) void search(q)
            else if (source && view) void browse(source.id, view)
          }}
        >
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.searchPlaceholder}
            aria-label={t.searchLabel}
            className="flex-1"
          />
          <Button type="submit" loading={busy}>
            {busy ? t.searching : t.search}
          </Button>
        </form>
        {source && !query.trim() && view && source.views.length > 0 && (
          <fieldset {...settingRow('skills.market.view')} aria-label={t.viewLabel}>
            <Segmented
              id="skill-market-view"
              value={view}
              options={source.views.map((v) => ({ value: v, label: t.views[v] ?? v }))}
              onChange={(v) => {
                setView(v)
                void browse(source.id, v)
              }}
            />
          </fieldset>
        )}
        {source && source.views.length === 0 && !results && (
          <p className="text-callout text-muted">{t.searchOnly(source.name)}</p>
        )}
        {tab === 'all' && !results && <p className="text-callout text-muted">{t.searchFirst}</p>}
        {results?.errors?.map((e) => (
          <Banner key={e.source} tone="warn">
            {t.failed(sourceName(e.source, props.sources), e.error)}
          </Banner>
        ))}
        {results && hits.length === 0 && !results.errors?.length && (
          <p className="text-callout text-muted">{t.noHits}</p>
        )}
        {hits.length > 0 && (
          <Card>
            {hits.map((h) => (
              <HitRow
                key={h.installRef}
                hit={h}
                sources={props.sources}
                installed={props.installed.includes(h.name)}
                {...(fetching ? { fetching } : {})}
                onReview={(x) => void review(x)}
              />
            ))}
          </Card>
        )}
      </div>
    </Sheet>
  )
}

/** Browse skills on Settings → Skills: the button that opens the browser, and the sources it reads. */
export function SkillMarket(props: { installed: readonly string[]; onReview(review: Review): void }) {
  const toast = useToast()
  const [sources, setSources] = useState<SourceView[]>()
  const [open, setOpen] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once
  useEffect(() => {
    api<{ sources?: SourceView[] }>('/api/skill-market')
      .then((r) => setSources(r.sources ?? []))
      .catch((err: Error) => toast(err.message, 'error'))
  }, [])
  const toggle = (id: string, enabled: boolean) =>
    void send<{ sources: SourceView[] }>('PUT', `/api/skill-market/sources/${encodeURIComponent(id)}`, {
      enabled,
    })
      .then((r) => setSources(r.sources))
      .catch((err: Error) => toast(err.message, 'error'))
  const Icon = FEATURE_ICONS.skillMarket
  return (
    <div className="mb-6">
      <SectionHeader icon={<Icon className="size-4 text-muted" />} title={t.title} />
      <div {...settingRow('skills.market.browse')} className="mb-3 mt-1 flex items-start gap-3">
        <p className="flex-1 text-footnote text-muted">{t.intro}</p>
        <Button aria-label={t.openLabel} disabled={!sources?.length} onClick={() => setOpen(true)}>
          {t.open}
        </Button>
      </div>
      {!!sources?.length && (
        <Card title={t.sourcesTitle}>
          {sources.map((s) => {
            const name = sourceName(s.id, sources)
            return (
              <CardRow
                key={s.id}
                {...settingRow(`skills.market.${s.id}` as SettingId)}
                className="flex items-start gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-body font-medium">{name}</div>
                  <p className="text-footnote text-muted">{t.sources[s.id]?.hint ?? s.url}</p>
                  {s.id === 'clawhub' && (
                    <p className="mt-1 text-footnote text-warn-ink">{t.clawhubWarning}</p>
                  )}
                </div>
                <Switch checked={s.enabled} label={t.sourceLabel(name)} onChange={(on) => toggle(s.id, on)} />
              </CardRow>
            )
          })}
        </Card>
      )}
      <AnimatePresence>
        {open && sources && (
          <BrowseSheet
            sources={sources}
            installed={props.installed}
            onClose={() => setOpen(false)}
            onReview={(review) => {
              setOpen(false)
              props.onReview(review)
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
