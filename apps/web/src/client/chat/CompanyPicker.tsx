import type { Company } from '@myrmidon/protocol'
import { useEffect, useState } from 'react'
import type { ModelOption, TeamConfig } from '../api.ts'
import { OPEN_SETTINGS_EVENT } from '../ComputerUse.tsx'
import { type CompanyEstimate, estimateCompany, useCompanies } from '../companies.ts'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Button, Select } from '../ui/primitives.tsx'
import { AGENT_MIN_WINDOW, COMPANY_ESTIMATE_DEBOUNCE_MS } from '../ui-config.ts'
import { ModelPicker, windowLabel } from './ModelPicker.tsx'

const t = copy.teamControls.company

const usd = (n: number) => (n < 0.01 ? `<$0.01` : `$${n.toFixed(2)}`)

/** The company the crew is made from, while one is picked and still exists. */
export function usePickedCompany(config: TeamConfig): Company | undefined {
  const { companies } = useCompanies()
  return config.company ? companies.find((c) => c.id === config.company) : undefined
}

/**
 * The crew panel's company choice: none (the helpers below), or one of the person's companies, whose roles then are the
 * crew. With one picked it shows the models its smart and fast roles run on, and what a playbook run should cost on
 * them before anything starts.
 */
export function CompanyPicker(props: {
  models: ModelOption[]
  config: TeamConfig
  onConfig(c: TeamConfig): void
  placement?: 'up' | 'down' | undefined
}) {
  const { config } = props
  const { companies } = useCompanies()
  const picked = config.company ? companies.find((c) => c.id === config.company) : undefined
  const [estimate, setEstimate] = useState<CompanyEstimate>()
  const pick = (id: string) => {
    const { company: _, tierModels: __, ...rest } = config
    props.onConfig(
      id ? { ...rest, company: id, ...(config.tierModels ? { tierModels: config.tierModels } : {}) } : rest,
    )
  }
  const tier = (key: 'smart' | 'fast', model: string) =>
    props.onConfig({ ...config, tierModels: { ...config.tierModels, [key]: model } })
  const key = JSON.stringify([config.company, config.leadModel, config.tierModels])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the parts of the config the estimate reads
  useEffect(() => {
    if (!config.company) return setEstimate(undefined)
    let live = true
    const timer = setTimeout(() => {
      void estimateCompany(config.company as string, config).then(
        (e) => live && setEstimate(e),
        () => live && setEstimate(undefined),
      )
    }, COMPANY_ESTIMATE_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [key])
  const smart = config.tierModels?.smart ?? config.roster[0]?.model ?? config.leadModel
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-body">
          <FEATURE_ICONS.company className="size-3.5 shrink-0 text-fg-2" />
          {t.label}
        </span>
        <Select
          value={picked?.id ?? ''}
          aria-label={t.label}
          onChange={(e) => pick(e.target.value)}
          className="h-[26px] max-w-56"
        >
          <option value="">{t.none}</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      {!picked && <p className="text-footnote text-muted">{t.noneHint}</p>}
      {picked && (
        <>
          <p className="text-footnote text-muted">
            {picked.description ? `${picked.description} ` : ''}
            {t.roles(picked.roles.length)}
          </p>
          {(['smart', 'fast'] as const).map((k) => (
            <div key={k} className="flex min-h-9 items-center justify-between gap-3">
              <span className="text-callout text-fg-2">{t.tierModel(copy.settings.companies.tiers[k])}</span>
              <ModelPicker
                variant="compact"
                placement={props.placement}
                label={t.tierModel(copy.settings.companies.tiers[k])}
                value={k === 'smart' ? smart : (config.tierModels?.fast ?? smart)}
                models={props.models}
                minWindow={AGENT_MIN_WINDOW}
                minReason={copy.teamControls.editor.minReason(windowLabel(AGENT_MIN_WINDOW))}
                onChange={(model) => tier(k, model)}
              />
            </div>
          ))}
          <p className="text-footnote text-fg-2" title={t.estimateHint}>
            {estimate?.usd !== undefined
              ? `${t.estimate(usd(estimate.usd))}${estimate.unpriced.length ? t.estimateUnpriced(estimate.unpriced.join(', ')) : ''}`
              : t.noEstimate}
            {estimate?.capUsd !== undefined ? `, ${t.cap(usd(estimate.capUsd))}` : ''}
          </p>
        </>
      )}
      <div>
        <Button
          size="sm"
          variant="borderless"
          onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: 'companies' }))}
        >
          {t.manage}
        </Button>
      </div>
    </div>
  )
}
