import {
  normalizeLevel,
  type PermissionRule,
  type RoleScope,
  RULE_KINDS,
  type RuleDecision,
  type RuleKind,
  sameTarget,
} from '@myrmidon/protocol'
import { Plus, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useId, useMemo, useState } from 'react'
import { copy } from '../copy.ts'
import { settingItem } from '../settings/Setting.tsx'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Button, cn, IconButton, Select, TextInput } from '../ui/primitives.tsx'
import { RULES_LIST_MAX_PX, spring } from '../ui-config.ts'
import { type CatalogTool, RULE_ICONS, shownTarget } from './describe.ts'

const t = copy.permissions.rules
const DECISIONS: RuleDecision[] = ['allow', 'ask', 'deny']
const DECISION_TONE: Record<RuleDecision, string> = {
  allow: 'bg-ok-soft text-ok-ink',
  ask: 'bg-warn-soft text-warn-ink',
  deny: 'bg-bad-soft text-bad-ink',
}

/** What the server offers rules to name: every tool (built-in and MCP), the MCP servers, and the remote hosts. */
export interface RuleCatalog {
  tools: CatalogTool[]
  servers: string[]
  hosts?: string[]
}

/**
 * One level's rules, grouped by what they name (tools, file changes, commands, MCP servers, MCP tools, remote
 * hosts), with search, an inline form to add one, and each rule's decision and who it applies to changeable in place.
 * Rules remembered from approval cards land here too.
 */
export function RulesEditor(props: {
  rules: readonly PermissionRule[]
  onChange(rules: PermissionRule[]): void
  catalog?: RuleCatalog
  disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const described = useMemo(
    () => new Map((props.catalog?.tools ?? []).map((tool) => [tool.name, tool])),
    [props.catalog],
  )
  const q = query.trim().toLowerCase()
  const shown = props.rules.filter(
    (r) =>
      !q ||
      r.target.toLowerCase().includes(q) ||
      t.kinds[r.kind].toLowerCase().includes(q) ||
      described.get(r.target)?.description.toLowerCase().includes(q),
  )
  const replace = (old: PermissionRule, next: PermissionRule | undefined) =>
    props.onChange(props.rules.flatMap((r) => (r === old ? (next ? [next] : []) : [r])))
  return (
    <div className="rounded-base border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <TextInput
          type="search"
          aria-label={t.search}
          placeholder={t.searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-7 min-w-0 flex-1"
        />
        <Button
          size="md"
          icon={<Plus className="size-3.5" />}
          disabled={props.disabled || adding}
          onClick={() => setAdding(true)}
        >
          {t.add}
        </Button>
      </div>
      <AnimatePresence initial={false}>
        {adding && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
            className="overflow-hidden border-b border-line"
          >
            <AddRule
              catalog={props.catalog}
              onCancel={() => setAdding(false)}
              onAdd={(rule) => {
                setAdding(false)
                props.onChange([...props.rules.filter((r) => !sameTarget(r, rule)), rule])
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <div className="overflow-y-auto overscroll-contain" style={{ maxHeight: RULES_LIST_MAX_PX }}>
        {props.rules.length === 0 ? (
          <p className="px-4 py-6 text-center text-callout text-muted">{t.none}</p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-6 text-center text-callout text-muted">{t.noMatch}</p>
        ) : (
          RULE_KINDS.map((kind) => {
            const rules = shown.filter((r) => r.kind === kind)
            if (!rules.length) return null
            return (
              <section key={kind} aria-label={t.kinds[kind]}>
                <h5 className="flex items-center justify-between bg-fill/50 px-4 py-1 section-label text-muted">
                  <span>{t.kinds[kind]}</span>
                  <span className="tabular-nums">{rules.length}</span>
                </h5>
                <ul className="divide-y divide-line">
                  {rules.map((rule) => (
                    <RuleRow
                      key={`${rule.kind}:${rule.target}:${rule.who ?? 'all'}`}
                      rule={rule}
                      tool={described.get(rule.target)}
                      disabled={props.disabled}
                      onChange={(next) => replace(rule, next)}
                      onRemove={() => replace(rule, undefined)}
                    />
                  ))}
                </ul>
              </section>
            )
          })
        )}
      </div>
    </div>
  )
}

function RuleRow(props: {
  rule: PermissionRule
  tool: CatalogTool | undefined
  disabled?: boolean | undefined
  onChange(rule: PermissionRule): void
  onRemove(): void
}) {
  const { rule } = props
  const Icon = RULE_ICONS[rule.kind]
  const name = shownTarget(rule)
  return (
    <li {...settingItem('permissions.rule', rule)} className="flex items-center gap-3 px-4 py-2">
      <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-body', rule.target === '*' ? 'font-medium' : 'font-mono')}>
          {name}
        </div>
        {props.tool?.description && (
          <div className="truncate text-small text-muted" title={props.tool.description}>
            {props.tool.readOnly ? `${t.readOnlyTool} · ` : ''}
            {props.tool.description}
          </div>
        )}
      </div>
      <Select
        aria-label={t.whoLabel(name)}
        value={rule.who ?? 'all'}
        disabled={props.disabled}
        onChange={(e) => {
          const who = e.target.value as RoleScope
          const { who: _, ...rest } = rule
          props.onChange(who === 'all' ? rest : { ...rest, who })
        }}
        className="h-6 text-small"
      >
        <option value="all">{t.who.all}</option>
        <option value="lead">{t.who.lead}</option>
        <option value="crew">{t.who.crew}</option>
      </Select>
      <DecisionPicker
        label={t.decisionLabel(name)}
        value={rule.decision}
        disabled={props.disabled}
        onChange={(decision) => props.onChange({ ...rule, decision })}
      />
      <IconButton size="sm" label={t.remove(name)} disabled={props.disabled} onClick={props.onRemove}>
        <X className="size-3.5" />
      </IconButton>
    </li>
  )
}

/** Allow · Ask · Deny as a small radio group (real radio buttons, so the arrow keys move between them), each in its own
 * colour once chosen. */
function DecisionPicker(props: {
  label: string
  value: RuleDecision
  disabled?: boolean | undefined
  onChange(decision: RuleDecision): void
}) {
  const name = useId()
  return (
    <fieldset
      aria-label={props.label}
      disabled={props.disabled}
      className="m-0 inline-flex shrink-0 rounded-md border-0 bg-fill-strong p-[2px]"
    >
      {DECISIONS.map((d) => (
        <label
          key={d}
          className={cn(
            'inline-flex h-[20px] cursor-pointer items-center rounded-sm px-2 text-small font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus/40 has-[:disabled]:cursor-default has-[:disabled]:opacity-50',
            props.value === d ? DECISION_TONE[d] : 'text-fg-2 hover:text-fg',
          )}
        >
          <input
            type="radio"
            name={name}
            value={d}
            checked={props.value === d}
            onChange={() => props.onChange(d)}
            className="sr-only"
          />
          {t.decisions[d]}
        </label>
      ))}
    </fieldset>
  )
}

/** The form a new rule starts in: what kind, what it names (with suggestions), who, and the decision. */
function AddRule(props: {
  catalog?: RuleCatalog | undefined
  onAdd(rule: PermissionRule): void
  onCancel(): void
}) {
  const id = useId()
  const [kind, setKind] = useState<RuleKind>('command')
  const [target, setTarget] = useState('')
  const [who, setWho] = useState<RoleScope>('all')
  const [decision, setDecision] = useState<RuleDecision>('allow')
  const suggestions = useMemo(() => {
    const tools = props.catalog?.tools ?? []
    if (kind === 'tool') return tools.filter((x) => !x.mcp).map((x) => x.name)
    if (kind === 'mcp-tool') return tools.filter((x) => x.mcp && x.name !== 'mcp').map((x) => x.name)
    if (kind === 'mcp-server') return ['*', ...(props.catalog?.servers ?? [])]
    if (kind === 'ssh-host') return ['*', ...(props.catalog?.hosts ?? [])]
    if (kind === 'command') return ['*', 'bun test', 'bun run', 'git status', 'git commit', 'npm test']
    return ['*']
  }, [kind, props.catalog])
  const value = kind === 'edit' ? '*' : target
  const rule = normalizeLevel({
    rules: [{ kind, target: value, decision, ...(who === 'all' ? {} : { who }) }],
  }).rules[0]
  return (
    <form
      className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (rule) props.onAdd(rule)
      }}
    >
      <label htmlFor={`${id}kind`} className="text-callout text-muted">
        {t.kindLabel}
      </label>
      <Select
        id={`${id}kind`}
        value={kind}
        onChange={(e) => setKind(e.target.value as RuleKind)}
        className="w-48"
      >
        {RULE_KINDS.map((k) => (
          <option key={k} value={k}>
            {t.kindOne[k]}
          </option>
        ))}
      </Select>
      <label htmlFor={`${id}target`} className="text-callout text-muted">
        {t.targetLabel}
      </label>
      <div className="min-w-0">
        <TextInput
          id={`${id}target`}
          list={`${id}list`}
          value={value}
          disabled={kind === 'edit'}
          // The form opened for this field: typing what the rule names is the next step.
          autoFocus
          placeholder={t.targetPlaceholder[kind]}
          aria-describedby={`${id}hint`}
          onChange={(e) => setTarget(e.target.value)}
          className="font-mono"
        />
        <datalist id={`${id}list`}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <p id={`${id}hint`} className="mt-1 text-small text-muted">
          {t.targetHint[kind]}
        </p>
      </div>
      <span className="text-callout text-muted">{t.decisionHeading}</span>
      <div className="flex flex-wrap items-center gap-2">
        <DecisionPicker
          label={t.decisionLabel(value || t.targetLabel)}
          value={decision}
          onChange={setDecision}
        />
        <Select
          aria-label={t.whoLabel(value || t.targetLabel)}
          value={who}
          onChange={(e) => setWho(e.target.value as RoleScope)}
          className="h-6 text-small"
        >
          <option value="all">{t.who.all}</option>
          <option value="lead">{t.who.lead}</option>
          <option value="crew">{t.who.crew}</option>
        </Select>
        <span className="flex-1" />
        <Button size="sm" variant="borderless" onClick={props.onCancel}>
          {t.cancel}
        </Button>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={!rule}
          icon={<FEATURE_ICONS.toolRules className="size-3.5" />}
        >
          {t.add}
        </Button>
      </div>
    </form>
  )
}
