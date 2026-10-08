import { ArrowUp, Folder, FolderPlus, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type Project, send } from '../api.ts'
import { copy } from '../copy.ts'
import { Modal } from '../ui/Modal.tsx'
import { Button, TextInput } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'
import { PermissionMark } from './ProjectPermissions.tsx'

interface Listing {
  path: string
  parent?: string
  folders: string[]
}

/**
 * Picks a project folder on this machine. The browser cannot open a native folder dialog, so the server lists
 * folders and the person walks to the one they want (or types its path).
 */
export function FolderPicker(props: { onClose(): void; onAdded(project: Project, all: Project[]): void }) {
  const toast = useToast()
  const [listing, setListing] = useState<Listing>()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  const open = (path: string) =>
    api<Listing>(`/api/folders?path=${encodeURIComponent(path)}`)
      .then((l) => {
        setListing(l)
        setTyped(l.path)
      })
      .catch((err) => toast(String((err as Error).message), 'error'))

  // biome-ignore lint/correctness/useExhaustiveDependencies: start in the home folder once
  useEffect(() => {
    void open('~')
  }, [])

  const add = async (path: string) => {
    setBusy(true)
    try {
      const r = await send<{ project: Project; projects: Project[] }>('POST', '/api/projects', { path })
      props.onAdded(r.project, r.projects)
      toast(copy.folderPicker.added(r.project.name), 'success')
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={copy.folderPicker.title}
      onClose={props.onClose}
      size="md"
      actions={
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !typed.trim()}
          onClick={() => add(typed)}
          icon={
            busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <FolderPlus className="size-3.5" />
          }
        >
          {copy.folderPicker.useFolder}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] text-muted">{copy.folderPicker.intro}</p>
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
            className="font-mono text-[12.5px]"
          />
          <Button size="sm" type="submit">
            {copy.folderPicker.go}
          </Button>
        </form>
        <div className="max-h-[50vh] overflow-auto rounded-xl border border-line">
          {listing?.parent && (
            <button
              type="button"
              onClick={() => open(listing.parent ?? '/')}
              className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-[13px] text-fg-2 hover:bg-surface-2"
            >
              <ArrowUp className="size-4 text-muted" /> ..
            </button>
          )}
          {listing?.folders.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => open(`${listing.path}/${f}`)}
              className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-[13px] last:border-0 hover:bg-surface-2"
            >
              <Folder className="size-4 shrink-0 text-muted" />
              <span className="truncate">{f}</span>
            </button>
          ))}
          {listing && listing.folders.length === 0 && (
            <p className="px-3 py-4 text-[12.5px] text-muted">{copy.folderPicker.empty}</p>
          )}
        </div>
      </div>
    </Modal>
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
    'inline-flex h-8 min-w-0 max-w-[180px] shrink items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted'
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
      className={`${pill} relative transition-colors duration-150 hover:bg-surface-2 hover:text-fg`}
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
