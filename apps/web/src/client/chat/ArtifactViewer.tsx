import type { ArtifactVersion } from '@myrmidon/protocol'
import { BookOpen, Check, Copy, Download, ExternalLink, FileCode, GitCompare, Monitor } from 'lucide-react'
import { useEffect, useState } from 'react'
import { blobText, previewUrl } from '../api.ts'
import { copy } from '../copy.ts'
import { diffLines } from '../diff.ts'
import { compact, useCopy } from '../ui/hooks.ts'
import { Modal } from '../ui/Modal.tsx'
import { Button, cn, Select, Skeleton, Tabs, tabPanel } from '../ui/primitives.tsx'
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
  const [noPreview, setNoPreview] = useState(false)
  const [error, setError] = useState<string>()
  const [copied, copyText] = useCopy()

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
    if (isHtml)
      void previewUrl(props.colonyId, props.name).then((url) => {
        setPreview(url)
        setNoPreview(url === undefined)
      })
  }, [isHtml, props.colonyId, props.name])

  const download = () => {
    if (text === undefined) return
    const url = URL.createObjectURL(new Blob([text], { type: selected?.mediaType ?? 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = props.name.split('/').pop() ?? copy.artifactViewer.downloadName
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
                <Monitor className="size-3.5" /> {copy.artifactViewer.tabs.preview}
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
                  <BookOpen className="size-3.5" /> {copy.artifactViewer.tabs.rendered}
                </>
              ),
            },
          ]
        : []),
    {
      value: 'code' as const,
      label: (
        <>
          <FileCode className="size-3.5" />{' '}
          {isMarkdown ? copy.artifactViewer.tabs.source : copy.artifactViewer.tabs.code}
        </>
      ),
    },
    ...(previous
      ? [
          {
            value: 'diff' as const,
            label: (
              <>
                <GitCompare className="size-3.5" /> {copy.artifactViewer.tabs.changesFrom(previous.version)}
              </>
            ),
          },
        ]
      : []),
  ]

  return (
    <Modal
      title={<span className="font-mono text-title">{props.name}</span>}
      onClose={props.onClose}
      size="full"
      flush
      actions={
        <div className="flex items-center gap-1.5">
          {props.versions.length > 1 && (
            <Select
              value={version}
              onChange={(e) => setVersion(Number(e.target.value))}
              aria-label={copy.artifactViewer.version}
            >
              {props.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {copy.artifactViewer.versionOption(v.version, v.author)}
                </option>
              ))}
            </Select>
          )}
          <Button
            size="sm"
            onClick={() => text !== undefined && copyText(text)}
            disabled={text === undefined}
            icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          >
            {copied
              ? copy.artifactViewer.copied
              : isMarkdown
                ? copy.artifactViewer.copyMarkdown
                : copy.artifactViewer.copy}
          </Button>
          <Button
            size="sm"
            onClick={download}
            disabled={text === undefined}
            icon={<Download className="size-3.5" />}
          >
            {copy.artifactViewer.download}
          </Button>
          {preview && (
            <a
              href={preview}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line px-2.5 text-callout font-medium transition-colors hover:bg-fill"
            >
              <ExternalLink className="size-3.5" /> {copy.artifactViewer.open}
            </a>
          )}
        </div>
      }
    >
      <div className="flex items-center justify-between border-b border-line pr-4">
        <Tabs id="viewer" value={view} onChange={setView} tabs={tabs} className="border-0" />
        <span className="shrink-0 text-small text-muted">
          {compact(selected?.size ?? 0)}B · {selected?.mediaType} · {copy.artifactViewer.by}{' '}
          {selected?.author}
        </span>
      </div>
      <div {...tabPanel('viewer', view)} className="flex min-h-0 flex-1 flex-col">
        {error && <div className="bg-bad-soft px-4 py-2 text-body text-bad-ink">{error}</div>}
        {view === 'preview' && noPreview && (
          <div className="border-b border-line bg-fill px-4 py-2 text-callout text-fg-2">
            {copy.artifactViewer.noPreview}
          </div>
        )}
        {view === 'preview' && preview ? (
          <iframe
            className="min-h-[60vh] w-full flex-1 border-0 bg-white"
            src={preview}
            title={copy.artifactViewer.previewOf(props.name)}
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
            <article className="mx-auto max-w-3xl px-8 py-6 text-title leading-relaxed">
              <Markdown text={text} />
            </article>
          </div>
        ) : (
          <pre className="m-0 flex-1 overflow-auto bg-code py-3 font-mono text-callout leading-[1.65]">
            {(view === 'diff' && prev !== undefined
              ? diffLines(prev, text)
              : text.split('\n').map((line) => ({ kind: 'same' as const, text: line }))
            ).map((l, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
                key={i}
                className={cn(
                  'flex px-0 hover:bg-fill/60',
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
      </div>
    </Modal>
  )
}
