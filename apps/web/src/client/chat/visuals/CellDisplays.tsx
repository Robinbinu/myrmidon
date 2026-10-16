import type { CellDisplay } from '@myrmidon/protocol'
import { useEffect, useMemo, useState } from 'react'
import { blobImage, blobText } from '../../api.ts'
import { copy } from '../../copy.ts'
import { type Parsed, parseVisual, sanitizeSvg, tableOf } from './spec.ts'
import { DrawnVisual, VisualImage } from './Visual.tsx'

const say = copy.visuals

/** A display() value as a visual: a list of records or rows as a table, anything else as a tree. */
export function jsonVisual(json: string): Parsed | undefined {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (Array.isArray(value) && value.length > 0) {
    const table = tableOf(value)
    if (table.ok) return table
  }
  return { ok: true, visual: { kind: 'tree', value } }
}

function Failed({ why }: { why: string }) {
  return <p className="px-3 py-2 text-callout text-muted">{why}</p>
}

/** One display, checked like a reply's visual; a cut or broken one shows as its text. */
function Shown(props: { colony: string; display: CellDisplay; at: number }) {
  const d = props.display
  const [error, setError] = useState<string>()
  const parsed = useMemo(
    () =>
      d.kind === 'json' ? jsonVisual(d.json) : d.kind === 'chart' ? parseVisual('chart', d.json) : undefined,
    [d],
  )
  if (d.kind === 'image')
    return d.mimeType === 'image/svg+xml' ? (
      <ShownSvg colony={props.colony} blob={d.blob} />
    ) : (
      <ShownImage colony={props.colony} blob={d.blob} mimeType={d.mimeType} at={props.at} />
    )
  if (!parsed)
    return (
      <pre className="my-2 max-h-72 overflow-auto rounded-lg border border-line bg-code p-3 font-mono text-callout">
        {d.json}
      </pre>
    )
  if (!parsed.ok || error !== undefined)
    return (
      <Failed
        why={say.cantDraw(
          say.kinds[d.kind === 'chart' ? 'chart' : 'tree'],
          error ?? (parsed.ok ? '' : parsed.error),
        )}
      />
    )
  return (
    <DrawnVisual visual={parsed.visual} source={d.json} onError={(m) => setError(say.errors.render(m))} />
  )
}

function ShownImage(props: { colony: string; blob: string; mimeType: string; at: number }) {
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let made: string | undefined
    let stop = false
    blobImage(props.colony, props.blob)
      .then((u) => {
        if (stop) URL.revokeObjectURL(u)
        else {
          made = u
          setUrl(u)
        }
      })
      .catch(() => !stop && setFailed(true))
    return () => {
      stop = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [props.colony, props.blob])
  if (failed) return <Failed why={say.imageFailed} />
  if (!url) return <div className="my-2 h-24 animate-pulse rounded-lg bg-fill less-motion:animate-none" />
  const ext = props.mimeType.split('/')[1] ?? 'png'
  return <VisualImage src={url} alt="" name={`${say.fileName(say.kinds.image)}-${props.at + 1}.${ext}`} />
}

function ShownSvg(props: { colony: string; blob: string }) {
  const [svg, setSvg] = useState<string | null>()
  useEffect(() => {
    let stop = false
    blobText(props.colony, props.blob)
      .then((t) => !stop && setSvg(sanitizeSvg(t) ?? null))
      .catch(() => !stop && setSvg(null))
    return () => {
      stop = true
    }
  }, [props.colony, props.blob])
  if (svg === null) return <Failed why={say.imageFailed} />
  if (svg === undefined)
    return <div className="my-2 h-24 animate-pulse rounded-lg bg-fill less-motion:animate-none" />
  return <DrawnVisual visual={{ kind: 'svg', svg }} onError={() => setSvg(null)} />
}

/** What a code cell's display() calls showed, drawn with the same components as a reply's visuals. */
export function CellDisplays(props: { colony: string; displays: readonly CellDisplay[] }) {
  return (
    <div className="mt-1.5 space-y-2">
      {props.displays.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a cell's displays are positional and never reorder
        <Shown key={i} colony={props.colony} display={d} at={i} />
      ))}
    </div>
  )
}
