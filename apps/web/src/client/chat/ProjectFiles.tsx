import { Check, Copy } from 'lucide-react'
import { AnimatePresence } from 'motion/react'
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { api } from '../api.ts'
import { copy } from '../copy.ts'
import { useCopy } from '../ui/hooks.ts'
import { Button, Skeleton } from '../ui/primitives.tsx'
import { Sheet } from '../ui/Sheet.tsx'
import { CodeLines } from './ArtifactViewer.tsx'

const OpenFile = createContext<((path: string) => void) | undefined>(undefined)

/** Opens a file of the chat's project folder; undefined outside a project chat, where there is no folder to open. */
export const useOpenProjectFile = () => useContext(OpenFile)

/**
 * Lets anything inside open a file of the project the chat works in (a step that edited it, an approval, a changed
 * file), in a viewer over the chat. Outside a project chat it only renders its children.
 */
export function ProjectFiles(props: {
  project?: { id: string; name: string } | undefined
  children: ReactNode
}) {
  const [path, setPath] = useState<string>()
  const { project } = props
  if (!project) return props.children
  return (
    <OpenFile.Provider value={setPath}>
      {props.children}
      <AnimatePresence>
        {path && (
          <ProjectFileViewer key={path} project={project} path={path} onClose={() => setPath(undefined)} />
        )}
      </AnimatePresence>
    </OpenFile.Provider>
  )
}

/** One project file as it is in the folder now, with line numbers. */
function ProjectFileViewer(props: { project: { id: string; name: string }; path: string; onClose(): void }) {
  const [file, setFile] = useState<{ path: string; text: string }>()
  const [error, setError] = useState<string>()
  const [copied, copyText] = useCopy()
  useEffect(() => {
    let cancelled = false
    api<{ path: string; text: string }>(
      `/api/projects/${props.project.id}/file?path=${encodeURIComponent(props.path)}`,
    )
      .then((f) => !cancelled && setFile(f))
      .catch((err) => !cancelled && setError(String((err as Error).message)))
    return () => {
      cancelled = true
    }
  }, [props.project.id, props.path])
  return (
    <Sheet
      title={<span className="font-mono text-title">{file?.path ?? props.path}</span>}
      onClose={props.onClose}
      size="full"
      flush
      actions={
        <Button
          size="sm"
          onClick={() => file && copyText(file.text)}
          disabled={!file}
          icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        >
          {copied ? copy.projectFile.copied : copy.projectFile.copy}
        </Button>
      }
    >
      <div className="border-b border-line px-4 py-2 text-small text-muted">
        {copy.projectFile.where(props.project.name)}
      </div>
      {error ? (
        <div className="bg-bad-soft px-4 py-2 text-body text-bad-ink" role="alert">
          {error}
        </div>
      ) : !file ? (
        <div className="space-y-2 p-5">
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-2/5" />
        </div>
      ) : (
        <CodeLines
          // A file's closing newline ends its last line; it is not another one.
          lines={file.text
            .replace(/\n$/, '')
            .split('\n')
            .map((text) => ({ kind: 'same' as const, text }))}
        />
      )}
    </Sheet>
  )
}
