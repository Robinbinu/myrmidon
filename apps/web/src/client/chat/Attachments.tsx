import {
  FileArchive,
  FileAudio,
  FileCode,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  FileVideo,
  ImageIcon,
  X,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { blobImage } from '../api.ts'
import { copy } from '../copy.ts'
import { Modal } from '../ui/Modal.tsx'
import { cn } from '../ui/primitives.tsx'
import { ATTACH_THUMB_PX } from '../ui-config.ts'

/** Pictures a browser shows by itself; SVG is left out (it can carry script) and shown as a file. */
const PICTURE = /^image\/(png|jpeg|gif|webp)$/
const PICTURE_NAME = /\.(png|jpe?g|gif|webp)$/i

type Kind = keyof typeof copy.attachments.kinds

/** What kind of file a name and media type are, for its icon and its label. */
export function fileKind(name: string, mediaType = ''): Kind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (PICTURE.test(mediaType) || PICTURE_NAME.test(name) || mediaType.startsWith('image/')) return 'image'
  if (mediaType === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mediaType.startsWith('audio/') || ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'flac'].includes(ext))
    return 'audio'
  if (mediaType.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'video'
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext)) return 'archive'
  if (['csv', 'tsv', 'xls', 'xlsx', 'numbers'].includes(ext)) return 'sheet'
  if (
    [
      'ts',
      'tsx',
      'js',
      'jsx',
      'py',
      'go',
      'rs',
      'java',
      'rb',
      'sh',
      'json',
      'yaml',
      'yml',
      'html',
      'css',
    ].includes(ext)
  )
    return 'code'
  if (mediaType.startsWith('text/') || ['txt', 'md', 'doc', 'docx', 'rtf', 'pages'].includes(ext))
    return 'text'
  return 'file'
}

const ICONS: Record<Kind, typeof FileIcon> = {
  image: ImageIcon,
  pdf: FileText,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  sheet: FileSpreadsheet,
  code: FileCode,
  text: FileText,
  file: FileIcon,
}

/** Tints per kind, as ChatGPT colours its file cards, so a PDF and a sheet are told apart at a glance. */
const TINTS: Record<Kind, string> = {
  image: 'bg-accent-soft text-accent-fg',
  pdf: 'bg-bad-soft text-bad-ink',
  audio: 'bg-warn-soft text-warn-ink',
  video: 'bg-warn-soft text-warn-ink',
  archive: 'bg-fill-strong text-fg-2',
  sheet: 'bg-ok-soft text-ok-ink',
  code: 'bg-fill-strong text-fg-2',
  text: 'bg-accent-soft text-accent-fg',
  file: 'bg-fill-strong text-fg-2',
}

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** A file as a card: its type icon, name, and kind (and size when known). */
export function FileCard(props: {
  name: string
  mediaType?: string
  size?: number
  onOpen?(): void
  onRemove?(): void
}) {
  const kind = fileKind(props.name, props.mediaType)
  const Icon = ICONS[kind]
  const label = copy.attachments.kinds[kind]
  const body = (
    <>
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', TINTS[kind])}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate text-callout font-medium text-fg">{props.name}</span>
        <span className="block truncate text-footnote text-muted">
          {props.size !== undefined ? `${label} · ${formatSize(props.size)}` : label}
        </span>
      </span>
    </>
  )
  return (
    <span className="relative inline-flex w-[220px] max-w-full">
      {props.onOpen ? (
        <button
          type="button"
          onClick={props.onOpen}
          title={copy.attachments.open(props.name)}
          className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface p-2 transition-colors hover:bg-surface-2"
        >
          {body}
        </button>
      ) : (
        <span className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface p-2">
          {body}
        </span>
      )}
      {props.onRemove && <Remove name={props.name} onRemove={props.onRemove} />}
    </span>
  )
}

function Remove(props: { name: string; onRemove(): void }) {
  return (
    <button
      type="button"
      aria-label={copy.composer.removeFile(props.name)}
      title={copy.composer.removeFile(props.name)}
      onClick={props.onRemove}
      className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-line bg-surface text-muted shadow-soft transition-colors hover:text-fg"
    >
      <X className="size-3" />
    </button>
  )
}

/** A local file's picture, for the message box before it is sent; the address is let go once it is not shown. */
function useLocalPicture(file: File): string | undefined {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    const made = URL.createObjectURL(file)
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [file])
  return url
}

function LocalThumb(props: { file: File; onRemove(): void }) {
  const url = useLocalPicture(props.file)
  return (
    <span className="relative inline-block" style={{ width: ATTACH_THUMB_PX, height: ATTACH_THUMB_PX }}>
      {url && (
        <img
          src={url}
          alt={props.file.name}
          title={props.file.name}
          className="size-full rounded-xl border border-line object-cover"
        />
      )}
      <Remove name={props.file.name} onRemove={props.onRemove} />
    </span>
  )
}

/** Files in the message box, before sending: pictures as thumbnails, the rest as cards; each can be removed. */
export function PendingFiles(props: { files: readonly File[]; onRemove(index: number): void }) {
  return (
    <div className="flex flex-wrap items-end gap-2 px-4 pt-3">
      {props.files.map((f, i) =>
        PICTURE.test(f.type) ? (
          <LocalThumb
            key={`${f.name}-${f.size}-${f.lastModified}`}
            file={f}
            onRemove={() => props.onRemove(i)}
          />
        ) : (
          <FileCard
            key={`${f.name}-${f.size}-${f.lastModified}`}
            name={f.name}
            mediaType={f.type}
            size={f.size}
            onRemove={() => props.onRemove(i)}
          />
        ),
      )}
    </div>
  )
}

/** A sent file as the chat keeps it: an artifact's first version. */
export interface SentFile {
  readonly name: string
  readonly mediaType?: string
  readonly blob?: string
  readonly size?: number
}

/** A picture stored with the chat, fetched with the page's access (never a token in the address). */
function useStoredPicture(colonyId: string, blob: string | undefined): string | undefined | null {
  const [url, setUrl] = useState<string | null>()
  useEffect(() => {
    if (!blob) return
    let made: string | undefined
    let live = true
    blobImage(colonyId, blob).then(
      (u) => {
        made = u
        if (live) setUrl(u)
        else URL.revokeObjectURL(u)
      },
      () => live && setUrl(null),
    )
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [colonyId, blob])
  return url
}

function StoredThumb(props: {
  colonyId: string
  file: SentFile
  single: boolean
  onOpen(url: string): void
}) {
  const url = useStoredPicture(props.colonyId, props.file.blob)
  const name = props.file.name.replace(/^uploads\//, '')
  // Not a picture after all (or gone): shown as a file instead.
  if (url === null) return <FileCard name={name} {...(props.file.size ? { size: props.file.size } : {})} />
  return (
    <button
      type="button"
      onClick={() => url && props.onOpen(url)}
      title={copy.attachments.view(name)}
      className={cn(
        'overflow-hidden rounded-2xl border border-line bg-surface-2',
        props.single ? 'max-h-[320px] max-w-[min(100%,360px)]' : 'size-[140px]',
      )}
    >
      {url ? (
        <img
          src={url}
          alt={name}
          className={cn('block', props.single ? 'max-h-[320px] w-auto' : 'size-full object-cover')}
        />
      ) : (
        <span className="block size-[140px] animate-pulse bg-surface-2" />
      )}
    </button>
  )
}

/**
 * Files on a sent message, as ChatGPT shows them: pictures as a grid above the message (one shown larger), opening
 * full size; other files as cards that open in the file viewer.
 */
export function SentFiles(props: {
  colonyId: string
  files: readonly SentFile[]
  onOpenFile(name: string): void
}) {
  const [viewing, setViewing] = useState<{ url: string; name: string }>()
  const pictures = props.files.filter((f) => fileKind(f.name, f.mediaType) === 'image' && f.blob)
  const others = props.files.filter((f) => !pictures.includes(f))
  return (
    <>
      {pictures.length > 0 && (
        <div className="flex max-w-[min(85%,640px)] flex-wrap justify-end gap-1.5">
          {pictures.map((f) => (
            <StoredThumb
              key={f.name}
              colonyId={props.colonyId}
              file={f}
              single={pictures.length === 1}
              onOpen={(url) => setViewing({ url, name: f.name.replace(/^uploads\//, '') })}
            />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex max-w-[min(85%,640px)] flex-wrap justify-end gap-1.5">
          {others.map((f) => (
            <FileCard
              key={f.name}
              name={f.name.replace(/^uploads\//, '')}
              {...(f.mediaType ? { mediaType: f.mediaType } : {})}
              {...(f.size ? { size: f.size } : {})}
              onOpen={() => props.onOpenFile(f.name)}
            />
          ))}
        </div>
      )}
      <AnimatePresence>
        {viewing && (
          <Modal title={viewing.name} size="lg" flush onClose={() => setViewing(undefined)}>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="grid min-h-0 flex-1 place-items-center bg-surface-2 p-4"
            >
              <img src={viewing.url} alt={viewing.name} className="max-h-full max-w-full object-contain" />
            </motion.div>
          </Modal>
        )}
      </AnimatePresence>
    </>
  )
}
