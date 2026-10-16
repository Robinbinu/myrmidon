import type { Company, CompanyBody, CompanyVersion } from '@myrmidon/protocol'
import { useEffect, useState } from 'react'
import { api, post, send, type TeamConfig } from './api.ts'

/** Sent when companies change, so the crew panel's picker and Settings load them again. */
export const COMPANIES_CHANGED = 'myr-companies-changed'

/** A built-in company, read-only: "Use" saves a copy of it. */
export type CompanyTemplate = CompanyBody & { id: string }

/** Where a company is wrong, as the server reports it. */
export interface CompanyProblem {
  path: string
  message: string
}

/** An imported prompt the skill scanner flagged. */
export interface CompanyFinding {
  role: string
  rule: string
  severity: string
  line: number
  excerpt: string
  why: string
}

export interface CompanyEstimate {
  usd?: number
  unpriced: string[]
  roles: { name: string; model: string; usd?: number }[]
  capUsd?: number
}

/** A save the server refused, with every problem it found. */
export class CompanyError extends Error {
  constructor(
    message: string,
    readonly problems: CompanyProblem[] = [],
  ) {
    super(message)
  }
}

const changed = () => window.dispatchEvent(new Event(COMPANIES_CHANGED))

/** The person's companies and the templates, loaded again whenever companies change anywhere on the page. */
export function useCompanies(): { companies: Company[]; templates: CompanyTemplate[]; loaded: boolean } {
  const [state, setState] = useState({
    companies: [] as Company[],
    templates: [] as CompanyTemplate[],
    loaded: false,
  })
  useEffect(() => {
    let live = true
    const load = () =>
      api<{ companies: Company[]; templates: CompanyTemplate[] }>('/api/companies')
        .then(
          (r) =>
            live && setState({ companies: r.companies ?? [], templates: r.templates ?? [], loaded: true }),
        )
        .catch(() => live && setState((s) => ({ ...s, loaded: true })))
    load()
    window.addEventListener(COMPANIES_CHANGED, load)
    return () => {
      live = false
      window.removeEventListener(COMPANIES_CHANGED, load)
    }
  }, [])
  return state
}

/** Runs a call that saves a company, turning the server's list of problems into a CompanyError. */
async function saving<T>(call: () => Promise<T>): Promise<T> {
  try {
    const r = await call()
    changed()
    return r
  } catch (err) {
    const body = (err as { body?: { problems?: CompanyProblem[] } }).body
    throw new CompanyError((err as Error).message, body?.problems ?? [])
  }
}

export const createFromTemplate = (template: string) =>
  saving(() => post<{ company: Company }>('/api/companies', { template })).then((r) => r.company)

/** Saves a new company, or (with `id`) a new version of one. */
export const saveCompany = (company: CompanyBody, id?: string, note?: string) =>
  saving(() =>
    id
      ? send<{ company: Company }>('PUT', `/api/companies/${encodeURIComponent(id)}`, { company, note })
      : post<{ company: Company }>('/api/companies', { company }),
  ).then((r) => r.company)

export const removeCompany = (id: string) =>
  saving(() => send('DELETE', `/api/companies/${encodeURIComponent(id)}`))

export const rollbackCompany = (id: string, version: number) =>
  saving(() =>
    post<{ company: Company }>(`/api/companies/${encodeURIComponent(id)}/rollback`, { version }),
  ).then((r) => r.company)

export const companyHistory = (id: string) =>
  api<{ history: CompanyVersion[] }>(`/api/companies/${encodeURIComponent(id)}`).then((r) => r.history)

/** The lead drafts a company from the person's words; nothing is saved until they save it. */
export const draftCompany = (description: string, model: string) =>
  post<{ company: CompanyBody }>('/api/companies/draft', { description, model }).then((r) => r.company)

/** A shared file read and checked, not saved: its company and what the scanner flagged in its prompts. */
export const previewImport = (text: string) =>
  post<{ company: CompanyBody; findings: CompanyFinding[] }>('/api/companies/import', { text })

export const exportUrl = (id: string) => `/api/companies/${encodeURIComponent(id)}/export`

export const estimateCompany = (id: string, config: TeamConfig) =>
  post<{ estimate: CompanyEstimate }>(`/api/companies/${encodeURIComponent(id)}/estimate`, config).then(
    (r) => r.estimate,
  )

export const decideCompanyProposal = (colonyId: string, proposal: string, approve: boolean) =>
  post<{ version?: number }>(
    `/api/colonies/${encodeURIComponent(colonyId)}/company-proposals/${encodeURIComponent(proposal)}`,
    { approve },
  ).then((r) => {
    changed()
    return r
  })

/** A blank role for the editor. */
export const blankRole = (n: number): CompanyBody['roles'][number] => ({
  name: `role-${n}`,
  title: '',
  responsibilities: [],
  tier: 'smart',
  access: 'no-shell',
  prompt: '',
})
