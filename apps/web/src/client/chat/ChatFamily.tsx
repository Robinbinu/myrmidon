import { GitFork } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api, type ChatSummary, type ImportedSession } from '../api.ts'
import { copy } from '../copy.ts'
import { FEATURE_ICONS } from '../ui/icons.ts'
import { Badge, cn } from '../ui/primitives.tsx'
import { chatFamily, type FamilyNode, familySize } from './family.ts'

const t = copy.family

/**
 * A chat's family as a tree: each chat's runs down its trunk, and the chats forked from it branching off after the
 * run they continued from. Choosing a chat (or one of its runs) opens it.
 */
export function ChatFamily(props: {
  chats: readonly ChatSummary[]
  chatId: string
  onOpen(chatId: string): void
}) {
  const root = useMemo(() => chatFamily(props.chats, props.chatId), [props.chats, props.chatId])
  if (!root) return null
  return (
    <div className="flex flex-col gap-4">
      <p className="text-callout text-muted">{familySize(root) > 1 ? t.intro : t.alone}</p>
      <ul aria-label={t.title} className="flex flex-col">
        <Branch node={root} current={props.chatId} onOpen={props.onOpen} />
      </ul>
    </div>
  )
}

function Branch(props: { node: FamilyNode; current: string; onOpen(chatId: string): void }) {
  const { node } = props
  const chat = node.chat
  const rounds = chat?.rounds ?? []
  const attached = new Set(rounds.map((r) => r.round))
  // Forks whose run is not listed (made before runs had start times) branch off after the last run.
  const loose = node.children.filter((c) => c.forkedAfter === undefined || !attached.has(c.forkedAfter))
  const forksAfter = (round: number) => node.children.filter((c) => c.forkedAfter === round)
  const sub = (children: readonly FamilyNode[]) =>
    children.length > 0 && (
      <ul className="ml-1.5 flex flex-col border-l border-line pl-3">
        {children.map((c) => (
          <Branch key={c.chatId} node={c} current={props.current} onOpen={props.onOpen} />
        ))}
      </ul>
    )
  return (
    <li className="flex flex-col py-1">
      <div className="flex min-w-0 items-center gap-2">
        {node.forkedAfter !== undefined || chat?.forkOf ? (
          <GitFork aria-hidden className="size-3.5 shrink-0 text-muted" />
        ) : (
          <FEATURE_ICONS.chatFamily aria-hidden className="size-3.5 shrink-0 text-muted" />
        )}
        {chat ? (
          <button
            type="button"
            onClick={() => props.onOpen(chat.chatId)}
            aria-current={chat.chatId === props.current ? 'page' : undefined}
            title={t.openChat(chat.title)}
            className={cn(
              'min-w-0 truncate rounded-sm text-left text-body font-medium hover:underline',
              chat.chatId === props.current ? 'text-fg' : 'text-fg-2',
            )}
          >
            {chat.title}
          </button>
        ) : (
          <span className="text-body italic text-muted">{t.gone}</span>
        )}
        {chat?.chatId === props.current && <Badge tone="accent">{t.current}</Badge>}
        {chat && <span className="shrink-0 text-caption text-muted">{t.runs(rounds.length)}</span>}
      </div>
      {(node.forkedAfter !== undefined || chat?.importOf) && (
        <p className="ml-5.5 text-caption text-muted">
          {node.forkedAfter !== undefined && t.forkedAfter(node.forkedAfter)}
          {chat?.importOf && <ImportedFrom importId={chat.importOf} />}
        </p>
      )}
      {chat && rounds.length > 0 && (
        <ol className="ml-1.5 mt-1 flex flex-col border-l border-line pl-3">
          {rounds.map((r) => (
            <li key={`${r.colonyId}-${r.round}`} className="flex flex-col">
              <button
                type="button"
                onClick={() => props.onOpen(chat.chatId)}
                className="flex min-w-0 items-baseline gap-2 rounded-sm py-0.5 text-left text-callout text-fg-2 hover:text-fg"
              >
                <span className="shrink-0 tabular-nums text-muted">{t.run(r.round)}</span>
                <span className="min-w-0 truncate">{r.request}</span>
              </button>
              {sub(forksAfter(r.round))}
            </li>
          ))}
        </ol>
      )}
      {sub(chat ? loose : node.children)}
    </li>
  )
}

/** Which tool an imported chat came from, loaded when the tree shows it. */
function ImportedFrom(props: { importId: string }) {
  const [source, setSource] = useState<string>()
  useEffect(() => {
    let live = true
    api<ImportedSession>(`/api/imported/${encodeURIComponent(props.importId)}`)
      .then((s) => live && setSource(s.source))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [props.importId])
  return <>{source ? t.imported(t.tools[source] ?? source) : t.importedAny}</>
}
