import { Check } from 'lucide-react'
import { type DragEvent, type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { copy } from '../copy.ts'
import { ConfirmButton } from '../ui/ConfirmButton.tsx'
import { FEATURE_ICONS } from '../ui/icons.ts'
import {
  Banner,
  Button,
  Card,
  CardRow,
  cn,
  Field,
  PageHeader,
  SectionHeader,
  TextArea,
} from '../ui/primitives.tsx'
import { MAX_IMPORTED_THEMES } from '../ui-config.ts'
import { applyTheme, forgetCachedTheme, paletteChoice, type ThemeChoice } from './apply.ts'
import { BUILTIN_THEMES } from './palettes.ts'
import { type ImportedTheme, importTheme, type SyntaxRole, themeTokens } from './vscode.ts'

type Tokens = Record<string, string>

/** Myrmidon's own looks for their cards: the values tokens.css gives these tokens. */
const MYRMIDON: Record<'light' | 'dark', Tokens> = {
  light: {
    window: '#f5f5f7',
    content: '#ffffff',
    label: '#1d1d1f',
    'label-3': '#616166',
    accent: '#ffb31a',
    'on-accent': '#1a1204',
    'code-bg': '#f5f5f7',
    'ok-soft': 'rgb(52 199 89 / 0.14)',
    'bad-soft': 'rgb(255 59 48 / 0.12)',
    separator: 'rgb(0 0 0 / 0.1)',
  },
  dark: {
    window: '#0b0b0e',
    content: '#111114',
    label: '#f4f4f6',
    'label-3': '#9a9aa5',
    accent: '#ffb31a',
    'on-accent': '#1a1204',
    'code-bg': '#0c0c0f',
    'ok-soft': 'rgb(61 220 132 / 0.11)',
    'bad-soft': 'rgb(255 99 105 / 0.11)',
    separator: 'rgb(255 255 255 / 0.08)',
  },
}

/** A tiny window in a theme's colours: a side bar, a title, a line of text, code, a diff and an accent button. */
function MiniWindow(props: { t: Tokens; syntax?: Partial<Record<SyntaxRole, string>> }) {
  const { t } = props
  const s = props.syntax ?? {}
  const bar = (width: string, color: string | undefined, height = 3) => (
    <span className="block rounded-full" style={{ width, height, background: color }} />
  )
  return (
    <span
      className="flex h-[84px] w-full overflow-hidden rounded-md"
      style={{ background: t.window, boxShadow: `inset 0 0 0 1px ${t.separator}` }}
      aria-hidden
    >
      <span className="flex w-[24%] flex-col gap-1.5 px-1.5 pt-2.5">
        {bar('80%', t['label-3'])}
        {bar('60%', t['label-3'])}
        <span className="block h-[5px] w-[90%] rounded-sm" style={{ background: t.accent }} />
        {bar('70%', t['label-3'])}
      </span>
      <span
        className="m-1 ml-0 flex flex-1 flex-col gap-1.5 rounded-[5px] px-2 pt-2"
        style={{ background: t.content }}
      >
        {bar('55%', t.label, 4)}
        {bar('80%', t['label-3'])}
        <span className="flex flex-col gap-1 rounded-sm px-1.5 py-1.5" style={{ background: t['code-bg'] }}>
          <span className="flex gap-1">
            {bar('22%', s.keyword ?? t.accent)}
            {bar('36%', s.function ?? t.label)}
            {bar('20%', s.string ?? t.label)}
          </span>
          {bar('48%', s.comment ?? t['label-3'])}
        </span>
        <span className="flex items-center gap-1">
          <span className="block h-[5px] flex-1 rounded-sm" style={{ background: t['ok-soft'] }} />
          <span className="block h-[5px] flex-1 rounded-sm" style={{ background: t['bad-soft'] }} />
          <span className="block h-[7px] w-[22%] rounded-sm" style={{ background: t.accent }} />
        </span>
      </span>
    </span>
  )
}

/** One theme in the gallery: its little window, its name and swatches. Hover or focus tries it; a click keeps it. */
function ThemeCard(props: {
  choice: ThemeChoice
  name: string
  note?: string
  selected: boolean
  preview: ReactNode
  swatches: readonly (string | undefined)[]
  onTry(choice: ThemeChoice): void
  onPick(choice: ThemeChoice): void
  action?: ReactNode
}) {
  return (
    <div className="relative">
      <button
        type="button"
        data-theme-card={props.choice}
        aria-pressed={props.selected}
        onMouseEnter={() => props.onTry(props.choice)}
        onFocus={() => props.onTry(props.choice)}
        onClick={() => props.onPick(props.choice)}
        className={cn(
          'flex w-full flex-col gap-2 rounded-lg border bg-surface p-1.5 pb-2 text-left transition-colors',
          props.selected ? 'border-accent ring-2 ring-accent/40' : 'border-line hover:border-line-strong',
        )}
      >
        {props.preview}
        <span className="flex min-w-0 items-center gap-1.5 px-1">
          <span className="flex shrink-0 -space-x-1" aria-hidden>
            {props.swatches.map((c, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of three swatches
                key={i}
                className="size-3 rounded-full ring-1 ring-line-strong"
                style={{ background: c }}
              />
            ))}
          </span>
          <span className="min-w-0 flex-1 truncate text-small font-medium text-fg">{props.name}</span>
          {props.selected && (
            <Check className="size-3.5 shrink-0 text-accent-fg" aria-label={copy.settings.appearance.inUse} />
          )}
        </span>
        {props.note && <span className="truncate px-1 text-caption text-muted">{props.note}</span>}
      </button>
      {props.action && <div className="absolute right-2 top-2">{props.action}</div>}
    </div>
  )
}

const swatchesOf = (t: Tokens) => [t.content, t.accent, t.label]

/**
 * Settings → Appearance: Myrmidon's own looks and VS Code themes as a gallery, grouped Myrmidon, Dark, Light and
 * Imported, and importing a theme file. Hovering or focusing a card shows its theme on the whole app until the pointer
 * or focus leaves the gallery or Esc is pressed; a click keeps it.
 */
export function AppearanceSection(props: {
  theme: ThemeChoice
  onTheme(t: ThemeChoice): void
  /** The person's imported themes; undefined while the settings load. */
  imported?: readonly ImportedTheme[]
  /** Saves the imported themes; resolves once saved. */
  onSaveImported(list: ImportedTheme[]): Promise<boolean>
}) {
  const t = copy.settings.appearance
  const g = copy.settings.general
  const imported = props.imported ?? []
  const [candidate, setCandidate] = useState<{ theme: ImportedTheme; dropped: number }>()
  const known = candidate
    ? [...imported.filter((x) => x.id !== candidate.theme.id), candidate.theme]
    : imported
  const trying = useRef<ThemeChoice>(undefined)
  const live = useRef({ theme: props.theme, known })
  live.current = { theme: props.theme, known }

  const tryOn = (choice: ThemeChoice) => {
    if (trying.current === choice) return
    trying.current = choice
    applyTheme(choice, live.current.known)
  }
  const putBack = () => {
    if (trying.current === undefined) return
    trying.current = undefined
    applyTheme(live.current.theme, live.current.known)
  }
  const pick = (choice: ThemeChoice) => {
    trying.current = undefined
    // Applied with the candidate known, so an imported theme is cached before the saved list comes back.
    applyTheme(choice, live.current.known)
    props.onTheme(choice)
  }
  // Leaving the page while trying a theme puts the person's own back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: putBack reads only refs, so the first one serves
  useEffect(() => () => putBack(), [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && trying.current !== undefined) {
      // Only puts the theme back; Settings itself stays open.
      e.stopPropagation()
      e.preventDefault()
      putBack()
      return
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (!step) return
    const cards = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-theme-card]')]
    const at = cards.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    cards[(at + step + cards.length) % cards.length]?.focus()
  }

  const card = (
    choice: ThemeChoice,
    name: string,
    tokens: Tokens,
    syntax?: Partial<Record<SyntaxRole, string>>,
    extra?: { note?: string; action?: ReactNode; preview?: ReactNode },
  ) => (
    <ThemeCard
      key={choice}
      choice={choice}
      name={name}
      selected={props.theme === choice}
      preview={extra?.preview ?? <MiniWindow t={tokens} {...(syntax ? { syntax } : {})} />}
      swatches={swatchesOf(tokens)}
      onTry={tryOn}
      onPick={pick}
      {...(extra?.note ? { note: extra.note } : {})}
      {...(extra?.action ? { action: extra.action } : {})}
    />
  )
  const builtin = (kind: 'dark' | 'light') =>
    BUILTIN_THEMES.filter((x) => x.type === kind).map((x) =>
      card(paletteChoice(x.id), x.name, themeTokens(x), x.syntax, { note: t.by(x.author) }),
    )
  const grid = (label: string, children: ReactNode, hint?: string) => (
    <section className="flex flex-col gap-2.5">
      <SectionHeader as="h4" title={label} {...(hint ? { note: hint } : {})} />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">{children}</div>
    </section>
  )

  const remove = async (id: string) => {
    forgetCachedTheme(id)
    if (props.theme === paletteChoice(id)) props.onTheme('system')
    await props.onSaveImported(imported.filter((x) => x.id !== id))
  }

  return (
    <>
      <PageHeader title={t.title}>{t.intro}</PageHeader>
      <section
        aria-label={t.gallery}
        className="flex flex-col gap-7"
        onKeyDown={onKeyDown}
        onMouseLeave={() => {
          if (!(document.activeElement as HTMLElement | null)?.closest('[data-theme-card]')) putBack()
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) putBack()
        }}
      >
        {grid(
          t.groups.myrmidon,
          <>
            {card('system', g.themeSystem, MYRMIDON.light, undefined, {
              // Light and dark, split corner to corner, as macOS draws its Auto appearance.
              preview: (
                <span className="relative block w-full">
                  <MiniWindow t={MYRMIDON.light} />
                  <span className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
                    <MiniWindow t={MYRMIDON.dark} />
                  </span>
                </span>
              ),
            })}
            {card('light', g.themeLight, MYRMIDON.light)}
            {card('dark', g.themeDark, MYRMIDON.dark)}
          </>,
          t.myrmidonHint,
        )}
        {grid(t.groups.dark, builtin('dark'))}
        {grid(t.groups.light, builtin('light'))}
        {grid(
          t.groups.imported,
          imported.length === 0 && !candidate ? (
            <p className="col-span-full text-callout text-muted">{t.noImported}</p>
          ) : (
            known.map((x) =>
              card(paletteChoice(x.id), x.name, themeTokens(x), x.syntax, {
                ...(candidate?.theme.id === x.id
                  ? {}
                  : {
                      action: (
                        <ConfirmButton
                          icon
                          label={t.remove(x.name)}
                          confirm={t.removeConfirm}
                          onConfirm={() => void remove(x.id)}
                        />
                      ),
                    }),
              }),
            )
          ),
        )}
      </section>
      <ImportForm
        full={imported.length >= MAX_IMPORTED_THEMES}
        candidate={candidate}
        onCandidate={setCandidate}
        onAdd={async (theme) => {
          const ok = await props.onSaveImported([...imported.filter((x) => x.id !== theme.id), theme])
          if (!ok) return false
          setCandidate(undefined)
          pick(paletteChoice(theme.id))
          return true
        }}
      />
    </>
  )
}

/** Pasting or dropping a VS Code theme file: checked on Preview, with what is wrong said under the field. */
function ImportForm(props: {
  full: boolean
  candidate?: { theme: ImportedTheme; dropped: number }
  onCandidate(c?: { theme: ImportedTheme; dropped: number }): void
  /** Saves the theme and puts it to use; false when it could not be saved. */
  onAdd(theme: ImportedTheme): Promise<boolean>
}) {
  const t = copy.settings.appearance
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const fieldId = useId()

  const check = (value: string) => {
    const r = importTheme(value)
    if (!r.ok) {
      setError(r.error)
      props.onCandidate(undefined)
      return
    }
    setError(undefined)
    props.onCandidate({ theme: r.theme, dropped: r.dropped })
  }
  const read = (f: File | undefined) => {
    if (!f) return
    f.text()
      .then((value) => {
        setText(value)
        check(value)
      })
      .catch(() => setError(t.importErrors.unreadable))
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setOver(false)
    read(e.dataTransfer.files[0])
  }

  return (
    <Card className="mt-8">
      <CardRow>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target around the field, which stays the control */}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          className={cn(
            'rounded-lg transition-shadow',
            over && 'ring-2 ring-accent ring-offset-4 ring-offset-surface',
          )}
        >
          <Field label={t.importTitle} hint={t.importHint} {...(error ? { error } : {})}>
            <TextArea
              id={fieldId}
              value={text}
              rows={5}
              spellCheck={false}
              aria-label={t.importLabel}
              placeholder={t.importPlaceholder}
              disabled={props.full}
              onChange={(e) => {
                setText(e.target.value)
                if (error) setError(undefined)
              }}
              className="font-mono text-small"
            />
          </Field>
          {props.full && (
            <p className="mt-2 text-callout text-muted" role="status">
              {t.full(MAX_IMPORTED_THEMES)}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              ref={file}
              type="file"
              accept=".json,.jsonc,application/json"
              className="hidden"
              onChange={(e) => {
                read(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <Button
              disabled={props.full}
              icon={<FEATURE_ICONS.themeImport className="size-3.5" />}
              onClick={() => file.current?.click()}
            >
              {t.chooseFile}
            </Button>
            <Button disabled={props.full} onClick={() => check(text)}>
              {t.check}
            </Button>
          </div>
          {props.candidate && (
            <Banner tone="ok" role="status" className="mt-3 flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1">
                {t.ready(props.candidate.theme.name)}
                {props.candidate.dropped > 0 && <> {t.dropped(props.candidate.dropped)}</>}
              </span>
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                onClick={() => {
                  const c = props.candidate
                  if (!c) return
                  setBusy(true)
                  void props.onAdd(c.theme).then((added) => {
                    setBusy(false)
                    if (added) setText('')
                  })
                }}
              >
                {t.add}
              </Button>
              <Button size="sm" variant="borderless" onClick={() => props.onCandidate(undefined)}>
                {t.cancel}
              </Button>
            </Banner>
          )}
        </div>
      </CardRow>
    </Card>
  )
}
