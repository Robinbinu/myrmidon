import { completeSimple } from '@oh-my-pi/pi-ai'
import { CHAT_TITLE_MS } from './config.ts'
import type { ModelResolver } from './models.ts'
import { prompts } from './prompts.ts'

/** How much of the person's messages and the crew's answer the namer reads. */
const ASKED_CHARS = 2_000
const ANSWER_CHARS = 1_500

/**
 * Names a chat from what it is about (as ChatGPT and Open WebUI do after the first exchange), instead of its first
 * message, which may be "hi". Returns nothing while there is not enough to go on, so the chat is named later.
 */
export async function nameChat(
  resolver: ModelResolver,
  model: string,
  input: { asked: readonly string[]; answer?: string },
): Promise<string | undefined> {
  const resolved = resolver.resolve(model)
  const apiKey = await resolver.requireApiKey(resolved.model)
  let budget = ASKED_CHARS
  const asked = input.asked.flatMap((a) => {
    if (budget <= 0) return []
    const cut = a.slice(0, budget)
    budget -= cut.length
    return [cut.replace(/\s+/g, ' ').trim()]
  })
  const context = {
    systemPrompt: [prompts.chatTitle.system],
    messages: [
      {
        role: 'user' as const,
        content: prompts.chatTitle.facts({
          asked,
          ...(input.answer ? { answer: input.answer.slice(0, ANSWER_CHARS) } : {}),
        }),
        timestamp: Date.now(),
      },
    ],
  }
  const signal = AbortSignal.timeout(CHAT_TITLE_MS)
  const reply = resolved.streamFn
    ? await (await resolved.streamFn(resolved.model, context, { apiKey, signal })).result()
    : await completeSimple(resolved.model, context, { apiKey, signal })
  if (reply.stopReason === 'error') throw new Error(reply.errorMessage ?? 'the model failed')
  return parseTitle(reply.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(''))
}

/** The model's JSON as a usable name, or nothing (it had nothing to name, or answered badly). */
export function parseTitle(text: string): string | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return undefined
  let raw: { title?: unknown }
  try {
    raw = JSON.parse(json) as { title?: unknown }
  } catch {
    return undefined
  }
  if (typeof raw.title !== 'string') return undefined
  const title = raw.title
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!title || title.length > 60 || /^(chat|conversation|new chat)$/i.test(title)) return undefined
  return title
}
