import { ArrowUp, Folder, FolderPlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { activeGateway, api, type Project, send } from '../api.ts'
import { copy } from '../copy.ts'
import { desktop } from '../ui/desktop.ts'
import { Button, TextInput } from '../ui/primitives.tsx'
import { Sheet } from '../ui/Sheet.tsx'
import { useToast } from '../ui/Toast.tsx'
import { PermissionMark } from './ProjectPermissions.tsx'

interface Listing {
  path: string
  parent?: string
  folders: string[]
}

/**
 * Picks a project folder on this machine. The browser cannot open a native folder dialog, so the server lists
 * folders and the person walks to the one they want (or types its path). The desktop app opens the native dialog
 * instead, while the window shows this machine's Myrmidon (another gateway's folders are on another machine).
 */
export function FolderPicker(props: { onClose(): void; onAdded(project: Project, all: Project[]): void }) {
  const toast = useToast()
  const [native] = useState(() => (activeGateway() ? undefined : desktop()))
  const [listing, setListing] = useState<Listing>()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  // Only the latest request shows: the home folder's listing, slow to come, must not replace a path typed meanwhile.
  const latest = useRef(0)

  const open = (path: string) => {
    const ask = ++latest.current
    return api<Listing>(`/api/folders?path=${encodeURIComponent(path)}`)
      .then((l) => {
        if (ask !== latest.current) return
        setListing(l)
        setTyped(l.path)
      })
      .catch((err) => {
        if (ask === latest.current) toast(String((err as Error).message), 'error')
      })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: start in the home folder (or the native dialog) once
  useEffect(() => {
    if (!native) return void open('~')
    native
      .pickFolder()
      .then((path) => (path ? add(path).then(props.onClose) : props.onClose()))
      .catch((err) => {
        toast(String((err as Error).message), 'error')
        props.onClose()
      })
  }, [])

  const add = async (path: string) => {
    setBusy(true)
    try {
      const r = await send<{ project: Project; projects: Project[] }>('POST', '/api/projects', { path })
      props.onAdded(r.project, r.projects)
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }

  if (native) return null
  return (
    <Sheet
      title={copy.folderPicker.title}
      onClose={props.onClose}
      size="md"
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={!typed.trim()}
          onClick={() => add(typed)}
          loading={busy}
          icon={<FolderPlus className="size-3.5" />}
        >
          {copy.folderPicker.useFolder}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-callout text-muted">{copy.folderPicker.intro}</p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void open(typed)
          }}
        >
          <TextInput
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={copy.folderPicker.path.placeholder}
            aria-label={copy.folderPicker.path.label}
            className="font-mono"
          />
          <Button size="sm" type="submit">
            {copy.folderPicker.go}
          </Button>
        </form>
        <div className="max-h-[50vh] overflow-auto rounded-lg border border-line">
          {listing?.parent && (
            <button
              type="button"
              onClick={() => open(listing.parent ?? '/')}
              className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-body text-fg-2 hover:bg-fill"
            >
              <ArrowUp className="size-4 text-muted" /> ..
            </button>
          )}
          {listing?.folders.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => open(`${listing.path}/${f}`)}
              className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-body last:border-0 hover:bg-fill"
            >
              <Folder className="size-4 shrink-0 text-muted" />
              <span className="truncate">{f}</span>
            </button>
          ))}
          {listing && listing.folders.length === 0 && (
            <p className="px-3 py-4 text-callout text-muted">{copy.folderPicker.empty}</p>
          )}
        </div>
      </div>
    </Sheet>
  )
}

const ADD = '__add__'

/** The composer's project control: a picker for a new chat, a plain label once the chat exists. */
export function ProjectPill(props: {
  projects: Project[]
  /** The chat's project, once the chat exists; it cannot change after that. */
  fixed?: { id: string; name: string }
  value?: string
  onChange(id: string | undefined): void
  /** Opens the folder picker; without it (a chats-only device) the list offers no new folder. */
  onAdd?(): void
}) {
  const pill =
    'inline-flex h-7 min-w-0 max-w-[180px] shrink items-center gap-1.5 rounded-md px-2 text-body text-muted'
  if (props.fixed) {
    const mode = props.projects.find((p) => p.id === props.fixed?.id)?.permissions?.mode
    return (
      <span
        className={pill}
        title={copy.folderPicker.pill.worksIn(props.fixed.name, mode && mode !== 'auto' ? mode : '')}
      >
        <Folder className="size-3.5 shrink-0" />
        <span className="truncate">{props.fixed.name}</span>
        <PermissionMark {...(mode ? { mode } : {})} />
      </span>
    )
  }
  const current = props.projects.find((p) => p.id === props.value)
  return (
    <label
      className={`${pill} relative transition-colors duration-150 hover:bg-fill hover:text-fg`}
      title={current ? current.path : copy.folderPicker.pill.title}
    >
      <Folder className="size-3.5 shrink-0" />
      <span className="truncate">{current?.name ?? copy.folderPicker.pill.none}</span>
      <PermissionMark {...(current?.permissions ? { mode: current.permissions.mode } : {})} />
      <select
        aria-label={copy.folderPicker.pill.label}
        value={current?.id ?? ''}
        onChange={(e) => {
          if (e.target.value === ADD) props.onAdd?.()
          else props.onChange(e.target.value || undefined)
        }}
        className="absolute inset-0 opacity-0"
      >
        <option value="">{copy.folderPicker.pill.noneOption}</option>
        {props.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {props.onAdd && <option value={ADD}>{copy.folderPicker.pill.open}</option>}
      </select>
    </label>
  )
}
