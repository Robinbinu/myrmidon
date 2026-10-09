import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

/** Records every request the page sends, answering each with `reply`. */
function recordFetch(reply: (url: string) => unknown = () => ({})) {
  const sent: { url: string; method: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    sent.push({ url, method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? 'null')) })
    return Response.json(reply(url))
  }) as unknown as typeof fetch
  return sent
}

const buttonIn = (doc: Document, text: string) =>
  [...doc.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement

test("a project's readable folders are saved with its permissions", async () => {
  const sent = recordFetch(() => ({ projects: [] }))
  const { ProjectPermissions } = await import('../src/client/chat/ProjectPermissions.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const project = {
    id: 'site-1',
    name: 'site',
    path: '/tmp/site',
    addedAt: '',
    permissions: { mode: 'auto' as const, allow: [], read: ['~/Documents/specs'] },
  }
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always">
      <ProjectPermissions project={project} onClose={() => {}} onSaved={() => {}} />
    </MotionConfig>,
  )
  const doc = host.ownerDocument
  try {
    const field = doc.getElementById('read-folders') as HTMLTextAreaElement
    expect(field.value).toBe('~/Documents/specs')
    await act(async () => {
      buttonIn(doc, copy.permissions.save).click()
      await Bun.sleep(10)
    })
    expect(sent[0]?.body).toMatchObject({ mode: 'auto', read: ['~/Documents/specs'] })
  } finally {
    await unmount()
  }
})

test('a request to read a folder is allowed once or for the chat; the chat’s folder shows as a chip that hides it again', async () => {
  const sent = recordFetch((url) => (url.includes('/readable') ? { reads: [] } : {}))
  const { Approval, ChatGrantChips } = await import('../src/client/chat/ApprovalCards.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const request = {
    id: 'approval-1',
    agent: 'lead',
    tool: 'request_read',
    summary: 'read ~/Documents/specs (the spec is there)',
    read: '/Users/me/Documents/specs',
    time: '',
  }
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always">
      <ToastProvider>
        <Approval colonyId="colony-1" chatId="chat-1" request={request} />
        <ChatGrantChips chatId="chat-1" grants={[]} reads={['/Users/me/notes']} onChanged={() => {}} />
      </ToastProvider>
    </MotionConfig>,
  )
  const doc = host.ownerDocument
  try {
    expect(buttonIn(doc, copy.approvals.approval.approveOnce)).toBeDefined()
    await act(async () => {
      buttonIn(doc, copy.approvals.reads.approveAll).click()
      await Bun.sleep(10)
    })
    // The request itself is answered first (so a note or edits go with it), then the folder is allowed for the chat.
    expect(sent).toEqual([
      {
        url: expect.stringContaining('/api/colonies/colony-1/approvals/approval-1'),
        method: 'POST',
        body: { approved: true },
      },
      {
        url: expect.stringContaining('/api/chats/chat-1/readable'),
        method: 'PUT',
        body: { folder: '/Users/me/Documents/specs', allowed: true },
      },
    ])
    expect(doc.body.textContent).toContain(copy.approvals.reads.chip('notes'))
    const remove = doc.querySelector(`[aria-label="${copy.approvals.reads.revoke('/Users/me/notes')}"]`)
    await act(async () => {
      ;(remove as HTMLButtonElement).click()
      await Bun.sleep(10)
    })
    expect(sent[2]).toMatchObject({ method: 'PUT', body: { folder: '/Users/me/notes', allowed: false } })
  } finally {
    await unmount()
  }
})
