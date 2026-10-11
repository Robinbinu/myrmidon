import { useEffect, useState } from 'react'
import { api, post, send } from './api.ts'
import { copy } from './copy.ts'
import { settingRow } from './settings/Setting.tsx'
import { ConfirmButton } from './ui/ConfirmButton.tsx'
import { FEATURE_ICONS } from './ui/icons.ts'
import { Badge, Banner, Button, Card, CardRow, cn, SectionHeader, TextInput } from './ui/primitives.tsx'
import { Sheet } from './ui/Sheet.tsx'
import { useToast } from './ui/Toast.tsx'

/**
 * Installing plugins and skills from elsewhere: Claude Code marketplaces, omp's skills registry, and the review the
 * person confirms before anything is installed. The server fetches and describes; nothing installs until the
 * Install button in the review is pressed.
 */

/** What a fetched plugin holds (packages/runtime/src/plugins.ts PluginPreview). */
export interface PluginPreviewView {
  id: string
  name: string
  description?: string
  author?: string
  version?: string
  source: string
  kind: string
  commit?: string
  integrity?: string
  server?: string
  ui?: string
  hooks: number
  mcpServers: string[]
  skills: string[]
  commands: string[]
  dependencies: string[]
  /** None when it brings no skills. */
  scan?: SkillScanView
  replaces?: { version?: string; commit?: string }
  expiresAt: string
}

/** One thing the skill scanner found (packages/runtime/src/skill-scan.ts SkillFinding). */
export interface SkillFindingView {
  rule: string
  category: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  file: string
  line: number
  excerpt: string
  why: string
}

/** What the skill scanner found in a skill (packages/runtime/src/skill-scan.ts SkillScan). */
export interface SkillScanView {
  verdict: 'clean' | 'warn' | 'block'
  findings: SkillFindingView[]
  scannedFiles: number
  skippedFiles: number
  hash: string
}

/** What fetched skills hold (packages/runtime/src/skill-installs.ts SkillPreview). */
export interface SkillPreviewView {
  id: string
  skills: { name: string; description: string }[]
  source: string
  kind: string
  version?: string
  commit?: string
  integrity?: string
  files: number
  scripts: string[]
  warnings: string[]
  scan: SkillScanView
  replaces?: { version?: string; commit?: string }
  expiresAt: string
}

export type Review =
  | { kind: 'plugin'; preview: PluginPreviewView }
  | { kind: 'skill'; preview: SkillPreviewView }

/** Where an installed plugin or skill came from (packages/runtime/src/install-sources.ts InstalledFrom). */
export interface InstalledFromView {
  source: string
  version?: string
  commit?: string
  installedAt: string
}

/** One line under an installed plugin or skill: where it came from and the commit it is pinned to. */
export function InstalledLine(props: { from: InstalledFromView; label: (source: string) => string }) {
  const { from } = props
  return (
    <p className="mt-1 truncate font-mono text-footnote text-muted" title={from.source}>
      {props.label(from.source)}
      {from.commit && ` · ${copy.settings.plugins.commit(from.commit)}`}
    </p>
  )
}

const t = copy.settings.installReview
const sc = copy.settings.skillScan

const SEVERITY_TONE = { critical: 'bad', high: 'warn', medium: 'neutral', low: 'neutral' } as const

function Finding(props: { finding: SkillFindingView }) {
  const f = props.finding
  return (
    <li className="flex flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={SEVERITY_TONE[f.severity]}>{sc.severity[f.severity]}</Badge>
        <span className="break-all font-mono text-footnote text-muted">{sc.at(f.file, f.line)}</span>
      </div>
      <p className="text-fg-2">{f.why}</p>
      {f.excerpt && (
        <code
          className="block truncate rounded-md bg-fill/60 px-2 py-1 font-mono text-footnote"
          title={f.excerpt}
        >
          {f.excerpt}
        </code>
      )}
    </li>
  )
}

/**
 * What the skill scanner found: critical and high findings in full, the rest folded away, and a line saying a scan is
 * advice, not a guarantee.
 */
export function ScanFindings(props: { scan: SkillScanView; verdictLine?: boolean }) {
  const { scan } = props
  const major = scan.findings.filter((f) => f.severity === 'critical' || f.severity === 'high')
  const minor = scan.findings.filter((f) => f.severity === 'medium' || f.severity === 'low')
  const Icon = FEATURE_ICONS.skillScan
  return (
    <div className="flex flex-col gap-2">
      {props.verdictLine !== false && (
        <>
          <SectionHeader icon={<Icon className="size-4 text-muted" />} title={sc.title} />
          <p className={cn(scan.verdict === 'block' ? 'text-bad-ink' : 'text-fg-2')}>
            {scan.verdict === 'block'
              ? sc.block
              : scan.verdict === 'warn'
                ? sc.warn
                : sc.clean(scan.scannedFiles)}
          </p>
        </>
      )}
      {major.length > 0 && (
        <ul className="flex flex-col gap-2">
          {major.map((f) => (
            <Finding key={`${f.rule}:${f.file}:${f.line}`} finding={f} />
          ))}
        </ul>
      )}
      {minor.length > 0 && (
        <details className="text-callout">
          <summary className="cursor-default text-muted">{sc.lesser(minor.length)}</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {minor.map((f) => (
              <Finding key={`${f.rule}:${f.file}:${f.line}`} finding={f} />
            ))}
          </ul>
        </details>
      )}
      {scan.skippedFiles > 0 && <p className="text-footnote text-muted">{sc.skipped(scan.skippedFiles)}</p>}
      <p className="text-footnote text-muted">{sc.advisory}</p>
    </div>
  )
}

/** The review: what will be installed, from where, and what of it runs as the person; Install is their yes. */
export function InstallReview(props: { review: Review; onClose(): void; onInstalled(): void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const { review } = props
  const p = review.preview
  const scan = review.preview.scan
  const cancel = () => {
    if (busy) return
    void send('DELETE', `/api/${review.kind}-installs/${p.id}`).catch(() => {})
    props.onClose()
  }
  const install = async (override = false) => {
    setBusy(true)
    const body = override ? { override: true } : {}
    try {
      if (review.kind === 'plugin') {
        const r = await post<{ plugin: { name: string } }>(`/api/plugin-installs/${p.id}`, body)
        toast(
          review.preview.replaces
            ? copy.settings.plugins.updated(r.plugin.name)
            : copy.settings.plugins.added(r.plugin.name),
          'success',
        )
      } else {
        const r = await post<{ names: string[] }>(`/api/skill-installs/${p.id}`, body)
        toast(
          review.preview.replaces
            ? copy.settings.skills.updated(r.names)
            : copy.settings.skills.add.installed(r.names),
          'success',
        )
      }
      props.onInstalled()
    } catch (err) {
      toast((err as Error).message, 'error')
      setBusy(false)
    }
  }
  const title =
    review.kind === 'plugin'
      ? review.preview.replaces
        ? t.updateTitle(review.preview.name)
        : t.pluginTitle(review.preview.name)
      : review.preview.replaces
        ? t.updateTitle(review.preview.skills.map((s) => s.name).join(', '))
        : t.skillTitle(review.preview.skills.length)
  const runs =
    review.kind === 'plugin'
      ? [
          review.preview.server && t.code(review.preview.server),
          review.preview.ui && t.ui,
          review.preview.hooks > 0 && t.hooks(review.preview.hooks),
          review.preview.mcpServers.length > 0 && t.servers(review.preview.mcpServers),
        ].filter((x): x is string => !!x)
      : review.preview.scripts.length
        ? [t.scripts(review.preview.scripts)]
        : []
  const adds =
    review.kind === 'plugin'
      ? [
          review.preview.skills.length > 0 && t.skills(review.preview.skills),
          review.preview.commands.length > 0 && t.commands(review.preview.commands),
          review.preview.dependencies.length > 0 && t.dependencies(review.preview.dependencies),
        ].filter((x): x is string => !!x)
      : [t.files(review.preview.files)]
  return (
    <Sheet title={title} onClose={cancel} size="sm">
      <div className="flex flex-col gap-3 text-callout">
        {review.kind === 'plugin' ? (
          review.preview.description && <p className="text-reading text-fg-2">{review.preview.description}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {review.preview.skills.map((s) => (
              <li key={s.name}>
                <span className="font-mono font-medium">{s.name}</span>
                <span className="text-fg-2"> — {s.description}</span>
              </li>
            ))}
          </ul>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted">{t.source}</dt>
          <dd className="break-all font-mono text-footnote">{p.source}</dd>
          {p.version && (
            <>
              <dt className="text-muted">{t.version}</dt>
              <dd>{p.version}</dd>
            </>
          )}
          {(p.commit || p.integrity) && (
            <>
              <dt className="text-muted">{t.pinned}</dt>
              <dd className="break-all font-mono text-footnote">{p.commit ?? p.integrity}</dd>
            </>
          )}
        </dl>
        {p.replaces && <p className="text-muted">{t.replaces(p.replaces.version, p.replaces.commit)}</p>}
        {review.kind === 'skill' &&
          review.preview.warnings.map((w) => (
            <Banner key={w} tone="warn">
              {w}
            </Banner>
          ))}
        <div>
          <SectionHeader title={t.runs} />
          {runs.length ? (
            <ul className="mt-1 list-disc pl-5 text-fg-2">
              {runs.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-fg-2">{t.nothingRuns}</p>
          )}
        </div>
        {adds.length > 0 && (
          <div>
            <SectionHeader title={t.adds} />
            <ul className="mt-1 list-disc pl-5 text-fg-2">
              {adds.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </div>
        )}
        {runs.length > 0 && (
          <Banner tone="warn" role="note">
            {t.warning}
          </Banner>
        )}
        {scan && <ScanFindings scan={scan} />}
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="borderless" onClick={cancel} disabled={busy}>
          {t.cancel}
        </Button>
        {busy ? (
          <Button variant="primary" loading>
            {t.installing}
          </Button>
        ) : scan?.verdict === 'block' ? (
          <ConfirmButton
            label={t.installAnyway}
            confirm={t.confirmAnyway}
            warning={t.anywayWarning}
            onConfirm={() => void install(true)}
          />
        ) : scan?.verdict === 'warn' ? (
          <ConfirmButton
            label={p.replaces ? t.update : t.install}
            confirm={t.confirmFlagged}
            warning={t.flaggedWarning}
            onConfirm={() => void install()}
          />
        ) : (
          <Button variant="primary" onClick={() => void install()}>
            {p.replaces ? t.update : t.install}
          </Button>
        )}
      </div>
    </Sheet>
  )
}

interface MarketplaceView {
  name: string
  source: string
  commit?: string
  owner?: string
  description?: string
  plugins: { name: string; description?: string; version?: string; source: string }[]
  error?: string
}

const m = copy.settings.plugins.marketplaces

/** Claude Code marketplaces: add one by repository, browse its plugins, and review one to install it. */
export function Marketplaces(props: { installed: readonly string[]; onReview(review: Review): void }) {
  const toast = useToast()
  const [list, setList] = useState<MarketplaceView[]>()
  const [source, setSource] = useState('')
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<string>()
  const [fetching, setFetching] = useState<string>()
  const load = () =>
    api<{ marketplaces?: MarketplaceView[] }>('/api/plugin-marketplaces')
      .then((r) => setList(r.marketplaces ?? []))
      .catch((err: Error) => toast(err.message, 'error'))
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once
  useEffect(() => {
    void load()
  }, [])
  const add = async () => {
    setAdding(true)
    try {
      const r = await post<{ marketplace: MarketplaceView; marketplaces: MarketplaceView[] }>(
        '/api/plugin-marketplaces',
        { source },
      )
      toast(m.added(r.marketplace.name, r.marketplace.plugins.length), 'success')
      setSource('')
      setList(r.marketplaces)
      setOpen(r.marketplace.name)
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setAdding(false)
    }
  }
  const review = async (marketplace: string, plugin: string) => {
    setFetching(`${plugin}@${marketplace}`)
    try {
      const r = await post<{ preview: PluginPreviewView }>('/api/plugins', { marketplace, plugin })
      props.onReview({ kind: 'plugin', preview: r.preview })
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setFetching(undefined)
    }
  }
  const Icon = FEATURE_ICONS.marketplaces
  return (
    <div className="mt-8">
      <SectionHeader icon={<Icon className="size-4 text-muted" />} title={m.title} />
      <p className="mb-3 mt-1 text-footnote text-muted">{m.intro}</p>
      <form
        {...settingRow('plugins.marketplaces')}
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (source.trim() && !adding) void add()
        }}
      >
        <TextInput
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder={m.sourcePlaceholder}
          aria-label={m.sourceLabel}
          className="flex-1 font-mono"
        />
        <Button type="submit" disabled={!source.trim()} loading={adding}>
          {adding ? m.adding : m.add}
        </Button>
      </form>
      {list && list.length === 0 && <p className="text-callout text-muted">{m.empty}</p>}
      {!!list?.length && (
        <Card>
          {list.map((mk) => (
            <CardRow key={mk.name}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-reading font-medium">{mk.name}</span>
                    {mk.owner && <span className="text-small text-muted">{m.by(mk.owner)}</span>}
                    <Badge>{m.plugins(mk.plugins.length)}</Badge>
                  </div>
                  {mk.description && <p className="mt-1 text-body text-fg-2">{mk.description}</p>}
                  <p className="mt-1 truncate font-mono text-footnote text-muted" title={mk.source}>
                    {mk.source}
                    {mk.commit && ` · ${copy.settings.plugins.commit(mk.commit)}`}
                  </p>
                  {mk.error && <p className="mt-1 text-callout text-bad-ink">{mk.error}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="borderless"
                    aria-expanded={open === mk.name}
                    onClick={() => setOpen(open === mk.name ? undefined : mk.name)}
                  >
                    {open === mk.name ? m.hide : m.browse}
                  </Button>
                  <Button
                    size="sm"
                    variant="borderless"
                    onClick={() =>
                      void send<{ marketplaces: MarketplaceView[] }>(
                        'POST',
                        `/api/plugin-marketplaces/${mk.name}`,
                      )
                        .then((r) => {
                          setList(r.marketplaces)
                          toast(m.refreshed(mk.name), 'success')
                        })
                        .catch((err: Error) => toast(err.message, 'error'))
                    }
                  >
                    {m.refresh}
                  </Button>
                  <ConfirmButton
                    label={m.remove}
                    confirm={m.confirmRemove}
                    onConfirm={() =>
                      void send<{ marketplaces: MarketplaceView[] }>(
                        'DELETE',
                        `/api/plugin-marketplaces/${mk.name}`,
                      )
                        .then((r) => {
                          setList(r.marketplaces)
                          toast(m.removed(mk.name), 'success')
                        })
                        .catch((err: Error) => toast(err.message, 'error'))
                    }
                  />
                </div>
              </div>
              {open === mk.name && (
                <ul className="mt-3 flex flex-col divide-y divide-line rounded-lg border border-line">
                  {mk.plugins.map((p) => {
                    const installed = props.installed.includes(p.name.toLowerCase())
                    return (
                      <li key={p.name} className="flex items-start gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={cn('font-mono text-body font-medium')}>{p.name}</span>
                            {p.version && <span className="text-small text-muted">v{p.version}</span>}
                            {installed && <Badge tone="ok">{m.installed}</Badge>}
                          </div>
                          {p.description && <p className="mt-0.5 text-callout text-fg-2">{p.description}</p>}
                          <p className="mt-0.5 truncate font-mono text-footnote text-muted">{p.source}</p>
                        </div>
                        {!installed && (
                          <Button
                            size="sm"
                            loading={fetching === `${p.name}@${mk.name}`}
                            disabled={!!fetching}
                            onClick={() => void review(mk.name, p.name)}
                          >
                            {m.install}
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardRow>
          ))}
        </Card>
      )}
    </div>
  )
}

interface RegistryHit {
  scope: string
  name: string
  description: string
  version: string
  weeklyDownloads: number
  deprecated?: string
}

const a = copy.settings.skills.add

/** omp's skills registry and git: search, then review a skill to install it. */
export function AddSkills(props: { installed: readonly string[]; onReview(review: Review): void }) {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState('')
  const [hits, setHits] = useState<RegistryHit[]>()
  const [searching, setSearching] = useState(false)
  const [source, setSource] = useState('')
  const [fetching, setFetching] = useState<string>()
  const search = async (q: string) => {
    setSearching(true)
    try {
      const r = await api<{ hits?: RegistryHit[] }>(`/api/skill-registry?q=${encodeURIComponent(q)}`)
      setHits(r.hits ?? [])
      setSearched(q)
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setSearching(false)
    }
  }
  const review = async (from: string) => {
    setFetching(from)
    try {
      const r = await post<{ preview: SkillPreviewView }>('/api/skill-installs', { source: from })
      props.onReview({ kind: 'skill', preview: r.preview })
      if (from === source) setSource('')
    } catch (err) {
      toast((err as Error).message, 'error')
    } finally {
      setFetching(undefined)
    }
  }
  const Icon = FEATURE_ICONS.skillRegistry
  return (
    <div className="mb-6">
      <SectionHeader icon={<Icon className="size-4 text-muted" />} title={a.title} />
      <p className="mb-3 mt-1 text-footnote text-muted">{a.intro}</p>
      <form
        {...settingRow('skills.registry')}
        className="mb-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (!searching) void search(query.trim())
        }}
      >
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={a.searchPlaceholder}
          aria-label={a.searchLabel}
          className="flex-1"
        />
        <Button type="submit" loading={searching}>
          {searching ? a.searching : a.search}
        </Button>
      </form>
      {hits && (
        <div className="mb-3">
          {!searched && <p className="mb-1 text-footnote text-muted">{a.popular}</p>}
          {hits.length === 0 ? (
            <p className="text-callout text-muted">{a.noHits}</p>
          ) : (
            <Card>
              {hits.map((h) => {
                const id = `@${h.scope}/${h.name}`
                const installed = props.installed.includes(h.name)
                return (
                  <CardRow key={id} className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-body font-medium">{id}</span>
                        <span className="text-small text-muted">v{h.version}</span>
                        <span className="text-small text-muted">{a.downloads(h.weeklyDownloads)}</span>
                        {installed && <Badge tone="ok">{m.installed}</Badge>}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-callout text-fg-2">{h.description}</p>
                      {h.deprecated && <p className="mt-0.5 text-callout text-warn-ink">{h.deprecated}</p>}
                    </div>
                    {!installed && (
                      <Button
                        size="sm"
                        loading={fetching === id}
                        disabled={!!fetching}
                        onClick={() => void review(id)}
                      >
                        {a.install}
                      </Button>
                    )}
                  </CardRow>
                )
              })}
            </Card>
          )}
        </div>
      )}
      <form
        {...settingRow('skills.add')}
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (source.trim() && !fetching) void review(source.trim())
        }}
      >
        <TextInput
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder={a.sourcePlaceholder}
          aria-label={a.sourceLabel}
          className="flex-1 font-mono"
        />
        <Button type="submit" disabled={!source.trim()} loading={fetching === source.trim()}>
          {fetching === source.trim() ? a.fetching : a.review}
        </Button>
      </form>
    </div>
  )
}
