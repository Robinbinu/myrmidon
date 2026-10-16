import {
  COMPANY_ACCESS,
  COMPANY_STARTS,
  type Company,
  type CompanyBody,
  type CompanyRole,
  type CompanyStage,
  type CompanyVersion,
  MODEL_TIERS,
} from '@myrmidon/protocol'
import { Plus, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { apiText, type ModelOption, type TeamConfig } from './api.ts'
import { ModelPicker } from './chat/ModelPicker.tsx'
import {
  blankRole,
  CompanyError,
  type CompanyFinding,
  type CompanyProblem,
  companyHistory,
  createFromTemplate,
  draftCompany,
  exportUrl,
  previewImport,
  removeCompany,
  rollbackCompany,
  saveCompany,
  useCompanies,
} from './companies.ts'
import { copy } from './copy.ts'
import { settingItem, settingRow } from './settings/Setting.tsx'
import { ConfirmButton } from './ui/ConfirmButton.tsx'
import { FEATURE_ICONS } from './ui/icons.ts'
import {
  Button,
  Card,
  Empty,
  Field,
  PageHeader,
  Segmented,
  Select,
  TextArea,
  TextInput,
} from './ui/primitives.tsx'
import { useToast } from './ui/Toast.tsx'

const t = copy.settings.companies

/** What the editor is showing: a new company (blank, drafted or imported) or one being changed. */
type Open = { kind: 'new'; body: CompanyBody; findings?: CompanyFinding[] } | { kind: 'edit'; id: string }

const blank = (): CompanyBody => ({
  name: '',
  kind: 'other',
  description: '',
  head: 'lead-role',
  start: 'lead',
  roles: [{ ...blankRole(1), name: 'lead-role', title: '', tier: 'frontier', access: 'full' }],
  playbook: [],
})

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/yaml' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * Settings → Companies: the person's companies, each opened into its editor, with versions to roll back to and a file
 * to share; new ones from a template, from a description the lead drafts, or from an imported file.
 */
export function CompaniesSection(props: { models: readonly ModelOption[]; config?: TeamConfig | undefined }) {
  const toast = useToast()
  const { companies, templates, loaded } = useCompanies()
  const [open, setOpen] = useState<Open>()
  const [versions, setVersions] = useState<{ id: string; list: CompanyVersion[] }>()
  const [describe, setDescribe] = useState('')
  const [model, setModel] = useState(props.config?.leadModel ?? '')
  const [drafting, setDrafting] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const fail = (err: unknown) => toast(String((err as Error).message), 'error')
  const draft = async () => {
    setDrafting(true)
    try {
      setOpen({ kind: 'new', body: await draftCompany(describe, model) })
      toast(t.reviewDraft, 'info')
    } catch (err) {
      fail(err)
    } finally {
      setDrafting(false)
    }
  }
  const importFile = async (f: File) => {
    try {
      const r = await previewImport(await f.text())
      setOpen({ kind: 'new', body: r.company, findings: r.findings })
    } catch (err) {
      fail(err)
    }
  }
  const showVersions = async (id: string) => {
    if (versions?.id === id) return setVersions(undefined)
    try {
      setVersions({ id, list: await companyHistory(id) })
    } catch (err) {
      fail(err)
    }
  }
  const exportOne = async (c: Company) => {
    try {
      download(
        await apiText(exportUrl(c.id)),
        `${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.company.yaml`,
      )
    } catch (err) {
      fail(err)
    }
  }
  return (
    <>
      <PageHeader title={t.title}>{t.intro}</PageHeader>
      <div {...settingRow('companies.add')} className="mb-5 flex flex-col gap-4">
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="borderless" onClick={() => file.current?.click()}>
            {t.import}
          </Button>
          <input
            ref={file}
            type="file"
            accept=".yaml,.yml,text/yaml"
            className="hidden"
            aria-label={t.import}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importFile(f)
              e.target.value = ''
            }}
          />
          <Button
            size="sm"
            variant="primary"
            icon={<Plus className="size-3.5" />}
            onClick={() => setOpen({ kind: 'new', body: blank() })}
          >
            {t.add}
          </Button>
        </div>
        <Card title={t.fromTemplate}>
          {templates.map((tpl) => (
            <div key={tpl.id} className="flex items-start gap-3 px-4 py-3">
              <FEATURE_ICONS.company className="mt-0.5 size-4 shrink-0 text-fg-2" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-reading font-semibold">{tpl.name}</span>
                  <span className="text-small text-muted">
                    {tpl.kind} · {t.roleCount(tpl.roles.length)} · {t.stageCount(tpl.playbook.length)}
                  </span>
                </div>
                <p className="text-callout text-fg-2">{tpl.description}</p>
                {tpl.credit && <p className="text-small text-muted">{tpl.credit}</p>}
              </div>
              <Button
                size="sm"
                onClick={() =>
                  void createFromTemplate(tpl.id).then(
                    (c) => toast(t.saved(c.name, c.version), 'success'),
                    fail,
                  )
                }
              >
                {t.useTemplate}
              </Button>
            </div>
          ))}
        </Card>
        <Card title={t.fromDescription} className="p-4">
          <div className="flex flex-col gap-3 p-4">
            <Field label={t.describe} hint={t.describeHint}>
              <TextArea
                value={describe}
                onChange={(e) => setDescribe(e.target.value)}
                rows={3}
                maxLength={4000}
              />
            </Field>
            <div className="flex items-center justify-end gap-2">
              <span className="text-small text-muted">{t.draftModel}</span>
              <ModelPicker
                variant="compact"
                placement="down"
                label={t.draftModel}
                value={model}
                models={[...props.models]}
                onChange={setModel}
              />
              <Button
                size="sm"
                variant="primary"
                loading={drafting}
                disabled={describe.trim().length < 10 || !model}
                onClick={() => void draft()}
              >
                {drafting ? t.drafting : t.draft}
              </Button>
            </div>
          </div>
        </Card>
        {open?.kind === 'new' && (
          <Card className="p-4">
            <CompanyEditor
              initial={open.body}
              findings={open.findings ?? []}
              onSaved={(c) => {
                toast(t.saved(c.name, c.version), 'success')
                setOpen(undefined)
              }}
              onCancel={() => setOpen(undefined)}
            />
          </Card>
        )}
      </div>
      {loaded && companies.length === 0 && open?.kind !== 'new' ? (
        <Empty icon={<FEATURE_ICONS.company className="size-5" />} title={t.empty}>
          {t.emptyHint}
        </Empty>
      ) : (
        <Card>
          {companies.map((c) => (
            <div
              key={c.id}
              {...settingItem('companies.company', c)}
              className="flex flex-col gap-3 px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <FEATURE_ICONS.company className="size-4 shrink-0 text-fg-2" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-reading font-semibold">{c.name}</span>
                    <span className="text-small text-muted">
                      {t.version(c.version)} · {c.kind} · {t.roleCount(c.roles.length)} ·{' '}
                      {t.stageCount(c.playbook.length)}
                    </span>
                  </div>
                  {c.description && <div className="truncate text-small text-muted">{c.description}</div>}
                </div>
                <Button size="sm" variant="borderless" onClick={() => setOpen({ kind: 'edit', id: c.id })}>
                  {t.edit}
                </Button>
                <Button size="sm" variant="borderless" onClick={() => void showVersions(c.id)}>
                  {t.history}
                </Button>
                <Button size="sm" variant="borderless" onClick={() => void exportOne(c)}>
                  {t.exportFile}
                </Button>
                <ConfirmButton
                  label={t.remove}
                  confirm={t.confirmRemove}
                  onConfirm={() =>
                    void removeCompany(c.id).then(() => toast(t.removed(c.name), 'info'), fail)
                  }
                />
              </div>
              {versions?.id === c.id && (
                <ul className="flex flex-col gap-1 rounded-base border border-line px-3 py-2">
                  {versions.list.map((v) => (
                    <li key={v.version} className="flex items-center gap-2 text-small">
                      <span className="font-semibold">{t.version(v.version)}</span>
                      <span className="text-muted">{new Date(v.savedAt).toLocaleString()}</span>
                      <span className="min-w-0 flex-1 truncate text-fg-2">{v.note}</span>
                      {v.version !== c.version && (
                        <Button
                          size="sm"
                          variant="borderless"
                          onClick={() =>
                            void rollbackCompany(c.id, v.version).then((back) => {
                              toast(t.rolledBack(v.version), 'success')
                              void companyHistory(back.id).then((list) => setVersions({ id: back.id, list }))
                            }, fail)
                          }
                        >
                          {t.rollback}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {open?.kind === 'edit' && open.id === c.id && (
                <CompanyEditor
                  id={c.id}
                  initial={c}
                  findings={[]}
                  onSaved={(saved) => {
                    toast(t.saved(saved.name, saved.version), 'success')
                    setOpen(undefined)
                  }}
                  onCancel={() => setOpen(undefined)}
                />
              )}
            </div>
          ))}
        </Card>
      )}
    </>
  )
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

/** A company as a form: its name and kind, how it starts, its roles (each a crewmate) and its playbook of stages. */
export function CompanyEditor(props: {
  id?: string
  initial: CompanyBody
  findings: readonly CompanyFinding[]
  onSaved(company: Company): void
  onCancel(): void
}) {
  const [c, setC] = useState<CompanyBody>(props.initial)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<CompanyProblem[]>([])
  const toast = useToast()
  const set = (patch: Partial<CompanyBody>) => setC((x) => ({ ...x, ...patch }))
  const setRole = (i: number, patch: Partial<CompanyRole>) =>
    set({ roles: c.roles.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const setStage = (i: number, patch: Partial<CompanyStage>) =>
    set({ playbook: c.playbook.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const save = async () => {
    setBusy(true)
    setProblems([])
    try {
      props.onSaved(await saveCompany(c, props.id, note || undefined))
    } catch (err) {
      if (err instanceof CompanyError && err.problems.length) setProblems(err.problems)
      else toast(String((err as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }
  const others = (name: string) => c.roles.filter((r) => r.name !== name)
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      {props.findings.length > 0 && (
        <div role="alert" className="rounded-base border border-danger/40 bg-danger/10 px-3 py-2 text-small">
          <p className="font-semibold">{t.findings}</p>
          <ul className="mt-1 list-disc pl-4">
            {props.findings.map((f) => (
              <li key={`${f.role}:${f.line}:${f.rule}`}>
                {f.role}: {f.why} ({f.excerpt})
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.name}>
          <TextInput value={c.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} />
        </Field>
        <Field label={t.kind} hint={t.kindHint}>
          <TextInput value={c.kind} onChange={(e) => set({ kind: e.target.value })} maxLength={30} />
        </Field>
      </div>
      <Field label={t.description}>
        <TextArea value={c.description} onChange={(e) => set({ description: e.target.value })} rows={2} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t.head}>
          <Select value={c.head} onChange={(e) => set({ head: e.target.value })}>
            {c.roles.map((r) => (
              <option key={r.name} value={r.name}>
                {r.title || r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t.start} hint={t.startHints[c.start]}>
          <Segmented
            id="company-start"
            value={c.start}
            options={COMPANY_STARTS.map((s) => ({ value: s, label: t.starts[s] }))}
            onChange={(start) => set({ start })}
          />
        </Field>
        <Field label={t.perRun} hint={t.perRunHint}>
          <TextInput
            type="number"
            min={0}
            step={0.5}
            value={c.budget?.perRunUsd ?? ''}
            onChange={(e) => {
              const n = Number(e.target.value)
              set({ budget: e.target.value && n > 0 ? { perRunUsd: n } : {} })
            }}
          />
        </Field>
      </div>

      <div className="section-label text-muted">{t.roles}</div>
      {c.roles.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: names and ids change as they are typed; the place is the identity
        <div key={i} className="flex flex-col gap-3 rounded-base border border-line p-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_1.5fr_auto]">
            <Field label={t.roleName}>
              <TextInput
                value={r.name}
                maxLength={24}
                onChange={(e) => {
                  const name = e.target.value.toLowerCase()
                  // Lines and the head follow a rename, so nothing points at the old name.
                  set({
                    head: c.head === r.name ? name : c.head,
                    roles: c.roles.map((x, j) =>
                      j === i ? { ...x, name } : x.reportsTo === r.name ? { ...x, reportsTo: name } : x,
                    ),
                  })
                }}
              />
            </Field>
            <Field label={t.roleTitle}>
              <TextInput
                value={r.title}
                maxLength={60}
                onChange={(e) => setRole(i, { title: e.target.value })}
              />
            </Field>
            {c.roles.length > 1 && (
              <button
                type="button"
                aria-label={t.removeRole(r.name)}
                onClick={() => set({ roles: c.roles.filter((_, j) => j !== i) })}
                className="mt-6 grid size-7 place-items-center rounded-md text-muted hover:bg-fill hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label={t.tier}>
              <Select
                value={r.tier}
                onChange={(e) => setRole(i, { tier: e.target.value as CompanyRole['tier'] })}
              >
                {MODEL_TIERS.map((x) => (
                  <option key={x} value={x}>
                    {t.tiers[x]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t.access}>
              <Select
                value={r.access}
                onChange={(e) => setRole(i, { access: e.target.value as CompanyRole['access'] })}
              >
                {COMPANY_ACCESS.map((x) => (
                  <option key={x} value={x}>
                    {t.accesses[x]}
                  </option>
                ))}
              </Select>
            </Field>
            {r.name !== c.head && (
              <Field label={t.reportsTo}>
                <Select
                  value={r.reportsTo ?? c.head}
                  onChange={(e) => setRole(i, { reportsTo: e.target.value })}
                >
                  {others(r.name).map((o) => (
                    <option key={o.name} value={o.name}>
                      {o.title || o.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {r.name !== c.head && (
              <Field label={t.owns}>
                <Select
                  value={r.stage ?? ''}
                  onChange={(e) => {
                    const { stage: _, ...rest } = r
                    set({
                      roles: c.roles.map((x, j) =>
                        j === i ? (e.target.value ? { ...rest, stage: e.target.value } : rest) : x,
                      ),
                    })
                  }}
                >
                  <option value="">{t.ownsNone}</option>
                  {c.playbook.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title || s.id}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <Field label={t.responsibilities} hint={t.responsibilitiesHint}>
            <TextArea
              value={r.responsibilities.join('\n')}
              rows={2}
              onChange={(e) => setRole(i, { responsibilities: lines(e.target.value) })}
            />
          </Field>
          <Field label={t.prompt} hint={t.promptHint}>
            <TextArea
              value={r.prompt}
              rows={5}
              maxLength={8000}
              onChange={(e) => setRole(i, { prompt: e.target.value })}
            />
          </Field>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="borderless"
          icon={<Plus className="size-3" />}
          onClick={() =>
            set({ roles: [...c.roles, { ...blankRole(c.roles.length + 1), reportsTo: c.head }] })
          }
        >
          {t.addRole}
        </Button>
      </div>

      <div className="section-label text-muted">{t.playbook}</div>
      {c.playbook.map((s, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: names and ids change as they are typed; the place is the identity
          key={i}
          className="grid gap-3 rounded-base border border-line p-3 sm:grid-cols-[1fr_2fr_1.5fr_1.5fr_auto]"
        >
          <Field label={t.stageId}>
            <TextInput
              value={s.id}
              maxLength={24}
              onChange={(e) => setStage(i, { id: e.target.value.toLowerCase() })}
            />
          </Field>
          <Field label={t.stageTitle}>
            <TextInput
              value={s.title}
              maxLength={80}
              onChange={(e) => setStage(i, { title: e.target.value })}
            />
          </Field>
          <Field label={t.after} hint={t.afterHint}>
            <TextInput
              value={s.after.join(', ')}
              onChange={(e) =>
                setStage(i, {
                  after: e.target.value
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <Field label={t.output}>
            <TextInput
              value={s.output ?? ''}
              onChange={(e) =>
                setStage(i, { output: e.target.value.trim() || undefined } as Partial<CompanyStage>)
              }
            />
          </Field>
          <button
            type="button"
            aria-label={t.removeStage(s.id)}
            onClick={() => set({ playbook: c.playbook.filter((_, j) => j !== i) })}
            className="mt-6 grid size-7 place-items-center rounded-md text-muted hover:bg-fill hover:text-fg"
          >
            <X className="size-3.5" />
          </button>
          <div className="sm:col-span-5">
            <Field label={t.brief}>
              <TextInput value={s.brief} onChange={(e) => setStage(i, { brief: e.target.value })} />
            </Field>
          </div>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="borderless"
          icon={<Plus className="size-3" />}
          onClick={() =>
            set({
              playbook: [
                ...c.playbook,
                { id: `stage-${c.playbook.length + 1}`, title: '', after: [], brief: '' },
              ],
            })
          }
        >
          {t.addStage}
        </Button>
      </div>

      {problems.length > 0 && (
        <div role="alert" className="rounded-base border border-danger/40 bg-danger/10 px-3 py-2 text-small">
          <p className="font-semibold">{t.problems}</p>
          <ul className="mt-1 list-disc pl-4">
            {problems.map((p) => (
              <li key={`${p.path}:${p.message}`}>
                <code>{p.path}</code>: {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        {props.id && (
          <TextInput
            aria-label={t.note}
            placeholder={t.note}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="max-w-64"
          />
        )}
        <Button type="button" variant="borderless" size="sm" onClick={props.onCancel} disabled={busy}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={busy}>
          {props.id ? t.save : t.saveNew}
        </Button>
      </div>
    </form>
  )
}
