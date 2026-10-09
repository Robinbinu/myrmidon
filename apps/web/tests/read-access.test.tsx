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
    permissions: { rules: [], read: ['~/Documents/specs'] },
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
    // The sheet reads the global level and the tool catalog first; the save is the one PUT.
    expect(sent.find((r) => r.method === 'PUT')?.body).toMatchObject({
      preset: null,
      rules: [],
      read: ['~/Documents/specs'],
    })
  } finally {
    await unmount()
  }
})

test('a request to read a folder is allowed once or for the chat; the chat’s folder shows as a chip that hides it again', async () => {
  const sent = recordFetch((url) => (url.includes('/readable') ? { reads: [] } : {}))
  const { Approval, ChatReadChips } = await import('../src/client/chat/ApprovalCards.tsx')
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
        <ChatReadChips chatId="chat-1" reads={['/Users/me/notes']} onChanged={() => {}} />
      </ToastProvider>
    </MotionConfig>,
  )
  const doc = host.ownerDocument
  try {
    expect(buttonIn(doc, copy.permissions.card.allowOnce)).toBeDefined()
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

test('a request to read a folder of keys warns, and offers it once or for this chat only', async () => {
  const sent = recordFetch((url) => (url.includes('/readable') ? { reads: [] } : {}))
  const { Approval } = await import('../src/client/chat/ApprovalCards.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const request = {
    id: 'approval-2',
    agent: 'lead',
    tool: 'request_read',
    summary: 'read ~/.ssh (to list the keys)',
    read: '/Users/me/.ssh',
    sensitive: true,
    // Even offered rules (none are, for a read) could not remember it for the project or everywhere.
    offer: [{ kind: 'tool' as const, target: 'request_read' }],
    time: '',
  }
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always">
      <ToastProvider>
        <Approval colonyId="colony-1" chatId="chat-1" project="site" request={request} />
      </ToastProvider>
    </MotionConfig>,
  )
  const doc = host.ownerDocument
  try {
    expect(doc.querySelector('[role="note"]')?.textContent).toBe(copy.approvals.reads.sensitive)
    const labels = [...doc.querySelectorAll('button')].map(
      (b) => b.textContent?.trim() || b.getAttribute('aria-label'),
    )
    expect(labels).toEqual([
      copy.permissions.card.denyOnce,
      copy.approvals.reads.approveAll,
      copy.permissions.card.allowOnce,
    ])
    expect(doc.body.textContent).not.toContain(copy.permissions.card.scopes.project)
    expect(doc.body.textContent).not.toContain(copy.permissions.card.scopes.global)
    await act(async () => {
      buttonIn(doc, copy.permissions.card.allowOnce).click()
      await Bun.sleep(10)
    })
    expect(sent).toEqual([
      {
        url: expect.stringContaining('/api/colonies/colony-1/approvals/approval-2'),
        method: 'POST',
        body: { approved: true },
      },
    ])
  } finally {
    await unmount()
  }
})

test('when the read is allowed but the folder cannot be opened for the chat, the person is told just that', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).includes('/readable')
      ? Response.json({ error: 'at most 20 folders in one chat' }, { status: 422 })
      : Response.json({})) as unknown as typeof fetch
  const { Approval } = await import('../src/client/chat/ApprovalCards.tsx')
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const request = {
    id: 'approval-2',
    agent: 'lead',
    tool: 'request_read',
    summary: 'read ~/Documents/specs',
    read: '/Users/me/Documents/specs',
    time: '',
  }
  const { host, unmount } = await mount(
    <MotionConfig reducedMotion="always">
      <ToastProvider>
        <Approval colonyId="colony-1" chatId="chat-1" request={request} />
      </ToastProvider>
    </MotionConfig>,
  )
  const doc = host.ownerDocument
  try {
    await act(async () => {
      buttonIn(doc, copy.approvals.reads.approveAll).click()
      await Bun.sleep(10)
    })
    expect(doc.body.textContent).toContain(
      copy.approvals.reads.onceOnly('/Users/me/Documents/specs', 'at most 20 folders in one chat'),
    )
  } finally {
    await unmount()
  }
})
