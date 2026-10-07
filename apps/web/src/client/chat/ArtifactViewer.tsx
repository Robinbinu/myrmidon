import type { ArtifactVersion } from '@myrmidon/protocol'
import { BookOpen, Check, Copy, Download, ExternalLink, FileCode, GitCompare, Monitor } from 'lucide-react'
import { useEffect, useState } from 'react'
import { blobText, previewUrl } from '../api.ts'
import { diffLines } from '../diff.ts'
import { compact, useCopy } from '../ui/hooks.ts'
import { Modal } from '../ui/Modal.tsx'
import { Button, cn, Select, Skeleton, Tabs } from '../ui/primitives.tsx'
import { Markdown } from './Markdown.tsx'

type View = 'code' | 'preview' | 'diff'

/**
 * File viewer for one artifact: source with line numbers, a live preview for HTML or rendered Markdown, and
 * a diff against the previous version.
 */
export function ArtifactViewer(props: {
  colonyId: string
  name: string
  versions: readonly ArtifactVersion[]
  onClose(): void
}) {
  const [version, setVersion] = useState(props.versions.at(-1)?.version ?? 1)
  const selected = props.versions.find((v) => v.version === version) ?? props.versions.at(-1)
  const previous = selected ? props.versions.find((v) => v.version === selected.parentVersion) : undefined
  const isHtml = selected?.mediaType === 'text/html'
  const isMarkdown = selected?.mediaType === 'text/markdown' || /\.(md|markdown)$/i.test(props.name)
  const [view, setView] = useState<View>(isHtml || isMarkdown ? 'preview' : 'code')
  const [text, setText] = useState<string>()
  const [prev, setPrev] = useState<string>()
  const [preview, setPreview] = useState<string>()
  const [error, setError] = useState<string>()
  const [copied, copy] = useCopy()

  const blob = selected?.blob
  const prevBlob = previous?.blob
  useEffect(() => {
    if (!blob) return
    let cancelled = false
    setText(undefined)
    Promise.all([blobText(props.colonyId, blob), prevBlob ? blobText(props.colonyId, prevBlob) : undefined])
      .then(([t, p]) => {
        if (cancelled) return
        setText(t)
        setPrev(p)
      })
      .catch((err) => !cancelled && setError(String(err.message ?? err)))
    return () => {
      cancelled = true
    }
  }, [props.colonyId, blob, prevBlob])

  useEffect(() => {
    if (isHtml) void previewUrl(props.colonyId, props.name).then(setPreview)
  }, [isHtml, props.colonyId, props.name])

  const download = () => {
    if (text === undefined) return
    const url = URL.createObjectURL(new Blob([text], { type: selected?.mediaType ?? 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = props.name.split('/').pop() ?? 'artifact'
    a.click()
    URL.revokeObjectURL(url)
  }

  const tabs = [
    ...(isHtml
      ? [
          {
            value: 'preview' as const,
            label: (
              <>
                <Monitor className="size-3.5" /> Preview
              </>
            ),
          },
        ]
      : isMarkdown
        ? [
            {
              value: 'preview' as const,
              label: (
                <>
                  <BookOpen className="size-3.5" /> Rendered
                </>
              ),
            },
          ]
        : []),
    {
      value: 'code' as const,
      label: (
        <>
          <FileCode className="size-3.5" /> {isMarkdown ? 'Source' : 'Code'}
        </>
      ),
    },
    ...(previous
      ? [
          {
            value: 'diff' as const,
            label: (
              <>
                <GitCompare className="size-3.5" /> Changes from v{previous.version}
              </>
            ),
          },
        ]
      : []),
  ]

  return (
    <Modal
      title={<span className="font-mono text-[14px]">{props.name}</span>}
      onClose={props.onClose}
      size="full"
      flush
      actions={
        <div className="flex items-center gap-1.5">
          {props.versions.length > 1 && (
            <Select value={version} onChange={(e) => setVersion(Number(e.target.value))} aria-label="Version">
              {props.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} · {v.author}
                </option>
              ))}
            </Select>
          )}
          <Button
            size="sm"
            onClick={() => text !== undefined && copy(text)}
            disabled={text === undefined}
            icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          >
            {copied ? 'Copied' : isMarkdown ? 'Copy markdown' : 'Copy'}
          </Button>
          <Button
            size="sm"
            onClick={download}
            disabled={text === undefined}
            icon={<Download className="size-3.5" />}
          >
            Download
          </Button>
          {preview && (
            <a
              href={preview}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[12.5px] font-medium transition-colors hover:bg-surface-2"
            >
              <ExternalLink className="size-3.5" /> Open
            </a>
          )}
        </div>
      }
    >
      <div className="flex items-center justify-between border-b border-line pr-4">
        <Tabs id="viewer" value={view} onChange={setView} tabs={tabs} className="border-0" />
        <span className="shrink-0 text-[12px] text-muted">
          {compact(selected?.size ?? 0)}B · {selected?.mediaType} · by {selected?.author}
        </span>
      </div>
      {error && <div className="bg-bad-soft px-4 py-2 text-[13px] text-bad-ink">{error}</div>}
      {view === 'preview' && preview ? (
        <iframe
          className="min-h-[60vh] w-full flex-1 border-0 bg-white"
          src={preview}
          title={`Preview of ${props.name}`}
          sandbox="allow-scripts allow-forms allow-same-origin"
        />
      ) : text === undefined ? (
        <div className="space-y-2 p-5">
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-2/5" />
        </div>
      ) : view === 'preview' && isMarkdown ? (
        <div className="flex-1 overflow-auto">
          <article className="mx-auto max-w-3xl px-8 py-6 text-[14.5px] leading-relaxed">
            <Markdown text={text} />
          </article>
        </div>
      ) : (
        <pre className="m-0 flex-1 overflow-auto bg-code py-3 font-mono text-[12.5px] leading-[1.65]">
          {(view === 'diff' && prev !== undefined
            ? diffLines(prev, text)
            : text.split('\n').map((line) => ({ kind: 'same' as const, text: line }))
          ).map((l, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
              key={i}
              className={cn(
                'flex px-0 hover:bg-surface-2/60',
                l.kind === 'add' && 'bg-ok-soft',
                l.kind === 'del' && 'bg-bad-soft',
              )}
            >
              <span className="w-14 shrink-0 select-none pr-4 text-right text-muted/70">
                {view === 'diff' ? (l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : '') : i + 1}
              </span>
              <span className="whitespace-pre pr-6">{l.text}</span>
            </div>
          ))}
        </pre>
      )}
    </Modal>
  )
}
