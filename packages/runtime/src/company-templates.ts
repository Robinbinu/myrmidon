import type { CompanyBody } from '@myrmidon/protocol'
import marketing from '../companies/marketing-agency/company.yaml'
import marketingArtDirector from '../companies/marketing-agency/roles/art-director.md' with { type: 'text' }
import marketingChannels from '../companies/marketing-agency/roles/channels.md' with { type: 'text' }
import marketingCopywriter from '../companies/marketing-agency/roles/copywriter.md' with { type: 'text' }
import marketingDirector from '../companies/marketing-agency/roles/director.md' with { type: 'text' }
import marketingEditor from '../companies/marketing-agency/roles/editor.md' with { type: 'text' }
import marketingStrategist from '../companies/marketing-agency/roles/strategist.md' with { type: 'text' }
import lab from '../companies/research-lab/company.yaml'
import labAnalyst from '../companies/research-lab/roles/analyst.md' with { type: 'text' }
import labPi from '../companies/research-lab/roles/pi.md' with { type: 'text' }
import labScout from '../companies/research-lab/roles/scout.md' with { type: 'text' }
import labSkeptic from '../companies/research-lab/roles/skeptic.md' with { type: 'text' }
import labWriter from '../companies/research-lab/roles/writer.md' with { type: 'text' }
import startup from '../companies/software-startup/company.yaml'
import startupCeo from '../companies/software-startup/roles/ceo.md' with { type: 'text' }
import startupDesigner from '../companies/software-startup/roles/designer.md' with { type: 'text' }
import startupEngLead from '../companies/software-startup/roles/eng-lead.md' with { type: 'text' }
import startupPm from '../companies/software-startup/roles/pm.md' with { type: 'text' }
import startupQa from '../companies/software-startup/roles/qa.md' with { type: 'text' }
import startupRelease from '../companies/software-startup/roles/release.md' with { type: 'text' }
import { checkCompany } from './companies.ts'

/**
 * The built-in companies, read-only: "Use" copies one into the person's companies, where it is theirs to change. Each
 * is a company folder (packages/runtime/companies/<id>), bundled into the build like the harness docs. The software
 * startup's role prompts are adapted from gstack (MIT, see NOTICE); every prompt is rewritten for Myrmidon's tools.
 */
export interface CompanyTemplate {
  readonly id: string
  readonly company: CompanyBody
}

const folder = (id: string, raw: unknown, prompts: Record<string, string>): CompanyTemplate => ({
  id,
  company: checkCompany(raw, (file) => prompts[file]),
})

export const COMPANY_TEMPLATES: readonly CompanyTemplate[] = [
  folder('software-startup', startup, {
    'roles/ceo.md': startupCeo,
    'roles/pm.md': startupPm,
    'roles/designer.md': startupDesigner,
    'roles/eng-lead.md': startupEngLead,
    'roles/qa.md': startupQa,
    'roles/release.md': startupRelease,
  }),
  folder('marketing-agency', marketing, {
    'roles/director.md': marketingDirector,
    'roles/strategist.md': marketingStrategist,
    'roles/copywriter.md': marketingCopywriter,
    'roles/art-director.md': marketingArtDirector,
    'roles/editor.md': marketingEditor,
    'roles/channels.md': marketingChannels,
  }),
  folder('research-lab', lab, {
    'roles/pi.md': labPi,
    'roles/scout.md': labScout,
    'roles/analyst.md': labAnalyst,
    'roles/skeptic.md': labSkeptic,
    'roles/writer.md': labWriter,
  }),
]

export const companyTemplate = (id: string): CompanyTemplate | undefined =>
  COMPANY_TEMPLATES.find((t) => t.id === id)
