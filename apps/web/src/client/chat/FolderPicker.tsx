import { ArrowUp, Folder, FolderPlus, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type Project, send } from '../api.ts'
import { Modal } from '../ui/Modal.tsx'
import { Button, TextInput } from '../ui/primitives.tsx'
import { useToast } from '../ui/Toast.tsx'

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
      toast(`Added ${r.project.name}`, 'success')
    } catch (err) {
      toast(String((err as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Open a project folder"
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
          Use this folder
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px] text-muted">
          Agents in this project's chats work in the folder: they read and edit its files and run commands
          there.
        </p>
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
            placeholder="~/code/my-app"
            aria-label="Folder path"
            className="font-mono text-[12.5px]"
          />
          <Button size="sm" type="submit">
            Go
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
            <p className="px-3 py-4 text-[12.5px] text-muted">No sub-folders here.</p>
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
  onAdd(): void
}) {
  const pill =
    'inline-flex h-8 min-w-0 max-w-[180px] shrink items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted'
  if (props.fixed)
    return (
      <span className={pill} title={`Works in ${props.fixed.name}`}>
        <Folder className="size-3.5 shrink-0" />
        <span className="truncate">{props.fixed.name}</span>
      </span>
    )
  const current = props.projects.find((p) => p.id === props.value)
  return (
    <label
      className={`${pill} relative cursor-pointer transition-colors duration-150 hover:bg-surface-2 hover:text-fg`}
      title={current ? current.path : 'Work in a project folder'}
    >
      <Folder className="size-3.5 shrink-0" />
      <span className="truncate">{current?.name ?? 'No project'}</span>
      <select
        aria-label="Project folder"
        value={current?.id ?? ''}
        onChange={(e) => {
          if (e.target.value === ADD) props.onAdd()
          else props.onChange(e.target.value || undefined)
        }}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        <option value="">No project (scratch only)</option>
        {props.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value={ADD}>Open a folder…</option>
      </select>
    </label>
  )
}
