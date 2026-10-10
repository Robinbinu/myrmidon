import { type ColonyState, foldColony, type MyrEvent, roundSlice } from '@myrmidon/protocol'
import { api, apiText, type ChatSummary } from '../api.ts'
import { copy } from '../copy.ts'
import { sealHtml, shareFile } from './share.ts'

/** What Export can write: Markdown to read or paste, a page that stands alone, or that page sealed to share. */
export type ExportFormat = 'md' | 'html'

/** A file name from the chat's title, safe on every system. */
export function exportName(title: string, ext: string): string {
  const base =
    title
      .replace(/[^\w -]+/g, '')
      .trim()
      .slice(0, 60) || copy.app.export.fallbackName
  return `${base}.${ext}`
}

/** Hands the browser a file to save: it goes where the person's downloads go, and nowhere else. */
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** A chat as Markdown: each round's request, the colony's replies, and the files it delivered. */
async function markdown(chat: ChatSummary): Promise<string> {
  const lines = [`# ${chat.title}`, '']
  const loaded = new Map<string, { state: ColonyState; events: MyrEvent[] }>()
  for (const round of chat.rounds) {
    let colony = loaded.get(round.colonyId)
    if (!colony) {
      const events = await api<MyrEvent[]>(`/api/colonies/${round.colonyId}/events?from=1&limit=20000`)
      colony = { events, state: foldColony(round.colonyId, events) }
      loaded.set(round.colonyId, colony)
    }
    const { state, info } = roundSlice(colony.state, colony.events, round.round)
    lines.push(`## ${copy.app.export.round(round.round)}`, '')
    for (const m of state.chatMessages)
      lines.push(`**${m.from === 'user' ? copy.app.export.you : m.from}:**`, '', m.text, '')
    const from = info?.startSeq ?? 0
    const files = Object.entries(state.artifacts)
      .filter(([, v]) => v.some((x) => x.seq >= from && x.author !== 'user'))
      .map(([name]) => name)
    if (files.length) lines.push(copy.app.export.files(files.join(', ')), '')
  }
  return lines.join('\n')
}

/** The chat as one HTML page, built (and its secrets redacted) by the server. */
const page = (chat: ChatSummary) => apiText(`/api/chats/${encodeURIComponent(chat.chatId)}/export`)

/** Downloads a chat as Markdown or as a self-contained HTML page. */
export async function exportChat(chat: ChatSummary, format: ExportFormat = 'md'): Promise<void> {
  if (format === 'html')
    return download(new Blob([await page(chat)], { type: 'text/html' }), exportName(chat.title, 'html'))
  download(new Blob([await markdown(chat)], { type: 'text/markdown' }), exportName(chat.title, 'md'))
}

/**
 * Seals the chat's page in this browser and downloads the share file; returns the key, which only the person sees.
 * The file is named for no chat, as its contents are hidden until opened.
 */
export async function shareChat(chat: ChatSummary): Promise<{ key: string; fileName: string }> {
  const { sealed, key } = await sealHtml(await page(chat))
  const fileName = copy.share.fileName
  download(new Blob([shareFile(sealed, copy.share.file)], { type: 'text/html' }), fileName)
  return { key, fileName }
}
