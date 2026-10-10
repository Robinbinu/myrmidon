import { afterEach, expect, test } from 'bun:test'
import type { PermissionLevel, PermissionRule } from '@myrmidon/protocol'
import { MotionConfig } from 'motion/react'
import { act, type ReactNode, useState } from 'react'
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

const buttons = (doc: Document) => [...doc.querySelectorAll('button')]
const byText = (doc: Document, text: string) =>
  buttons(doc).find((b) => b.textContent?.trim() === text) as HTMLButtonElement
const byLabel = (doc: Document, label: string) =>
  doc.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement
const click = async (el: HTMLElement | null) => {
  if (!el) throw new Error('nothing to click')
  await act(async () => {
    el.click()
    await Bun.sleep(5)
  })
}

async function page(ui: ReactNode) {
  const { ToastProvider } = await import('../src/client/ui/Toast.tsx')
  const { ScopeContext } = await import('../src/client/DeviceGate.tsx')
  return {
    with: async (scope: 'full' | 'chat' = 'full') =>
      mount(
        <MotionConfig reducedMotion="always">
          <ScopeContext.Provider value={scope}>
            <ToastProvider>{ui}</ToastProvider>
          </ScopeContext.Provider>
        </MotionConfig>,
      ),
  }
}

const command = {
  id: 'approval-1',
  agent: 'lead',
  tool: 'shell',
  summary: 'bun test src/app.test.ts',
  time: '',
  offer: [
    { kind: 'command' as const, target: 'bun test' },
    { kind: 'command' as const, target: '*' },
  ],
  why: { by: 'preset' as const, scope: 'project' as const, preset: 'ask' as const },
}

test('an approval card answers once by default, and its menu remembers the answer at the level chosen', async () => {
  const sent = recordFetch()
  const { Approval } = await import('../src/client/chat/ApprovalCards.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.permissions.card
  const { host, unmount } = await (
    await page(<Approval colonyId="colony-1" chatId="chat-1" project="site" request={command} />)
  ).with()
  const doc = host.ownerDocument
  try {
    // Why it asked, in words.
    expect(doc.body.textContent).toContain(
      copy.permissions.why.preset(
        'Ask',
        copy.permissions.why.setOn.project,
        copy.permissions.why.presetWhat.ask,
      ),
    )
    expect(doc.body.textContent).toContain('This project is set to Ask, so this waits for you.')
    const more = byLabel(doc, t.moreAllow)
    expect(more.getAttribute('aria-haspopup')).toBe('dialog')
    await click(more)
    expect(more.getAttribute('aria-expanded')).toBe('true')
    const menu = doc.querySelector(`[role=dialog][aria-label="${t.moreAllow}"]`) as HTMLElement
    // What to remember: the command's prefix first and chosen, then every command; then where.
    const radios = [...menu.querySelectorAll('[role=menuitemradio]')]
    expect(radios.map((r) => r.textContent)).toEqual([t.target.command('bun test'), t.target.everyCommand])
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true')
    const scopes = [...menu.querySelectorAll('[role=menuitem]')].map((m) => m.textContent)
    expect(scopes).toEqual([
      `${t.scopes.chat}${t.scopeHint.chat}`,
      `${t.scopes.project}${t.scopeHint.project}`,
      `${t.scopes.global}${t.scopeHint.global}`,
    ])
    await click(radios[1] as HTMLElement)
    const everywhere = [...menu.querySelectorAll('[role=menuitem]')].find((m) =>
      m.textContent?.startsWith(t.scopes.global),
    )
    await click(everywhere as HTMLElement)
    // Every command, in every chat: nothing is saved until a second, spelled-out yes.
    expect(sent).toEqual([])
    const yes = byText(doc, t.confirm.allow(t.target.everyCommand, t.confirm.where.global))
    expect(yes).toBeDefined()
    await click(byText(doc, t.confirm.back))
    expect(sent).toEqual([])
    await click(
      [...menu.querySelectorAll('[role=menuitem]')].find((m) =>
        m.textContent?.startsWith(t.scopes.global),
      ) as HTMLElement,
    )
    const confirm = byText(doc, t.confirm.allow(t.target.everyCommand, t.confirm.where.global))
    // A held Enter's repeats, and the second click of a double-click, land on it at once: neither says yes.
    const repeat = new KeyboardEvent('keydown', {
      key: 'Enter',
      repeat: true,
      bubbles: true,
      cancelable: true,
    })
    await act(async () => {
      confirm.dispatchEvent(repeat)
    })
    expect(repeat.defaultPrevented).toBe(true)
    await click(confirm)
    expect(sent).toEqual([])
    const { CONFIRM_ARM_DELAY_MS } = await import('../src/client/ui-config.ts')
    await act(async () => Bun.sleep(CONFIRM_ARM_DELAY_MS))
    await click(confirm)
    expect(sent).toEqual([
      {
        url: expect.stringContaining('/api/colonies/colony-1/approvals/approval-1'),
        method: 'POST',
        body: {
          approved: true,
          remember: { scope: 'global', rules: [{ kind: 'command', target: '*', decision: 'allow' }] },
        },
      },
    ])
  } finally {
    await unmount()
  }
})

test("a compound command's parts are remembered together, so the same command runs next time", async () => {
  const sent = recordFetch()
  const { Approval } = await import('../src/client/chat/ApprovalCards.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.permissions.card
  const compound = {
    ...command,
    summary: 'bun run build && bun test',
    offer: [
      { kind: 'command' as const, target: 'bun run build' },
      { kind: 'command' as const, target: 'bun test' },
      { kind: 'command' as const, target: '*' },
    ],
  }
  const { host, unmount } = await (
    await page(<Approval colonyId="c" chatId="chat-1" request={compound} />)
  ).with()
  const doc = host.ownerDocument
  try {
    await click(byLabel(doc, t.moreAllow))
    const menu = doc.querySelector(`[role=dialog][aria-label="${t.moreAllow}"]`) as HTMLElement
    expect([...menu.querySelectorAll('[role=menuitemradio]')].map((r) => r.textContent)).toEqual([
      `${t.target.command('bun run build')}${t.and}${t.target.command('bun test')}`,
      t.target.everyCommand,
    ])
    await click(menu.querySelector('[role=menuitem]') as HTMLElement)
    expect(sent[0]?.body).toEqual({
      approved: true,
      remember: {
        scope: 'chat',
        rules: [
          { kind: 'command', target: 'bun run build', decision: 'allow' },
          { kind: 'command', target: 'bun test', decision: 'allow' },
        ],
      },
    })
  } finally {
    await unmount()
  }
})

test('deny has its own menu; a chats-only device may remember only for the chat', async () => {
  const sent = recordFetch()
  const { Approval } = await import('../src/client/chat/ApprovalCards.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.permissions.card
  const mcp = {
    ...command,
    tool: 'mcp__github_delete_repo',
    summary: 'mcp__github_delete_repo {"repo":"x"}',
    offer: [
      { kind: 'mcp-tool' as const, target: 'mcp__github_delete_repo' },
      { kind: 'mcp-server' as const, target: 'github' },
    ],
  }
  const { host, unmount } = await (
    await page(<Approval colonyId="colony-1" chatId="chat-1" project="site" request={mcp} />)
  ).with('chat')
  const doc = host.ownerDocument
  try {
    await click(byLabel(doc, t.moreDeny))
    const menu = doc.querySelector(`[role=dialog][aria-label="${t.moreDeny}"]`) as HTMLElement
    expect([...menu.querySelectorAll('[role=menuitem]')].map((m) => m.textContent)).toEqual([
      `${t.scopes.chat}${t.scopeHint.chat}`,
    ])
    await click(menu.querySelector('[role=menuitem]') as HTMLElement)
    expect(sent[0]?.body).toEqual({
      approved: false,
      remember: {
        scope: 'chat',
        rules: [{ kind: 'mcp-tool', target: 'mcp__github_delete_repo', decision: 'deny' }],
      },
    })
  } finally {
    await unmount()
  }
})

test('a card that asked because someone else started the round offers no menu: no rule could lift it', async () => {
  const sent = recordFetch()
  const { Approval } = await import('../src/client/chat/ApprovalCards.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const { offer: _, ...rest } = command
  const member = { ...rest, why: { by: 'askAll' as const } }
  const { host, unmount } = await (
    await page(<Approval colonyId="c" chatId="chat-1" request={member} />)
  ).with()
  const doc = host.ownerDocument
  try {
    expect(byLabel(doc, copy.permissions.card.moreAllow)).toBeNull()
    expect(doc.body.textContent).toContain(copy.permissions.why.askAll)
    await click(byText(doc, copy.permissions.card.allowOnce))
    expect(sent[0]?.body).toEqual({ approved: true })
  } finally {
    await unmount()
  }
})

test("the chat's control shows the preset in effect, sets the chat's own, and removes what it remembered", async () => {
  const sent = recordFetch()
  const { ChatPermissions } = await import('../src/client/permissions/ChatPermissions.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.permissions
  const level: PermissionLevel = { rules: [{ kind: 'command', target: 'bun test', decision: 'allow' }] }
  let saved = 0
  const { host, unmount } = await (
    await page(
      <ChatPermissions
        chatId="chat-1"
        level={level}
        project={{ name: 'site', level: { preset: 'ask', rules: [] } }}
        globalPreset="auto"
        canEdit
        onPending={() => {}}
        onSaved={() => saved++}
      />,
    )
  ).with()
  const doc = host.ownerDocument
  try {
    // The project's Ask is in effect.
    const pill = doc.querySelector(`[title="${t.chat.label('Ask')}"]`) as HTMLButtonElement
    expect(pill.textContent).toContain('Ask')
    await click(pill)
    const items = [...doc.querySelectorAll('[role=menuitemradio]')]
    expect(items.map((i) => i.querySelector('.font-medium')?.textContent)).toEqual([
      t.inherit.project('Ask'),
      'Read only',
      'Ask',
      'Auto',
      'Full access',
    ])
    expect(items[0]?.getAttribute('aria-checked')).toBe('true')
    await click(items[3] as HTMLElement)
    expect(sent.at(-1)).toMatchObject({
      url: expect.stringContaining('/api/chats/chat-1/permissions'),
      method: 'PUT',
      body: { preset: 'auto', rules: level.rules },
    })
    // Full access asks first.
    await click(pill)
    await click([...doc.querySelectorAll('[role=menuitemradio]')][4] as HTMLElement)
    expect(doc.body.textContent).toContain(t.confirmFullTitle)
    expect(sent).toHaveLength(1)
    await click(byText(doc, t.confirmFull))
    expect(sent.at(-1)?.body).toMatchObject({ preset: 'full' })
    // Remembered rules are listed with a remove button.
    await click(pill)
    await click(byLabel(doc, t.rules.remove(t.card.target.command('bun test'))))
    expect(sent.at(-1)?.body).toEqual({ rules: [] })
    expect(saved).toBe(3)
  } finally {
    await unmount()
  }
})

test("before a chat exists the control holds the new chat's choice, and a read-only project cannot be loosened", async () => {
  const sent = recordFetch()
  const { ChatPermissions } = await import('../src/client/permissions/ChatPermissions.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.permissions
  const pending: (PermissionLevel | undefined)[] = []
  function Host() {
    const [level, setLevel] = useState<PermissionLevel>()
    return (
      <ChatPermissions
        level={level}
        globalPreset="auto"
        canEdit
        onPending={(l) => {
          pending.push(l)
          setLevel(l)
        }}
        onSaved={() => {}}
      />
    )
  }
  const one = await (await page(<Host />)).with()
  try {
    const doc = one.host.ownerDocument
    const pill = doc.querySelector(`[title="${t.chat.newLabel('Auto')}"]`) as HTMLButtonElement
    await click(pill)
    await click([...doc.querySelectorAll('[role=menuitemradio]')][2] as HTMLElement)
    expect(pending).toEqual([{ rules: [], preset: 'ask' }])
    expect(sent).toEqual([])
    expect(doc.querySelector(`[title="${t.chat.newLabel('Ask')}"]`)).not.toBeNull()
  } finally {
    await one.unmount()
  }
  const two = await (
    await page(
      <ChatPermissions
        chatId="chat-2"
        project={{ name: 'docs', level: { preset: 'read-only', rules: [] } }}
        globalPreset="full"
        canEdit
        onPending={() => {}}
        onSaved={() => {}}
      />,
    )
  ).with()
  try {
    const doc = two.host.ownerDocument
    await click(doc.querySelector(`[title="${t.chat.label('Read only')}"]`) as HTMLButtonElement)
    expect(doc.querySelectorAll('[role=menuitemradio]')).toHaveLength(0)
    expect(doc.body.textContent).toContain(t.readOnlyFloor('docs'))
  } finally {
    await two.unmount()
  }
})

test('the rules table adds, changes and removes rules, grouped by what they name', async () => {
  const { RulesEditor } = await import('../src/client/permissions/RulesEditor.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.permissions.rules
  const changes: PermissionRule[][] = []
  function Host() {
    const [rules, setRules] = useState<PermissionRule[]>([
      { kind: 'mcp-server', target: 'github', decision: 'ask' },
      { kind: 'tool', target: 'web_fetch', decision: 'deny', who: 'crew' },
    ])
    return (
      <RulesEditor
        rules={rules}
        catalog={{ tools: [{ name: 'web_fetch', description: 'Reads a page.' }], servers: ['github'] }}
        onChange={(next) => {
          changes.push(next)
          setRules(next)
        }}
      />
    )
  }
  const { host, unmount } = await (await page(<Host />)).with()
  const doc = host.ownerDocument
  try {
    expect([...doc.querySelectorAll('section')].map((g) => g.getAttribute('aria-label'))).toEqual([
      t.kinds.tool,
      t.kinds['mcp-server'],
    ])
    expect(doc.body.textContent).toContain('Reads a page.')
    // Change github from ask to allow.
    const github = doc.querySelector(`fieldset[aria-label="${t.decisionLabel('github')}"]`) as HTMLElement
    await click(github.querySelector('input[value=allow]') as HTMLElement)
    expect(changes.at(-1)?.[0]).toEqual({ kind: 'mcp-server', target: 'github', decision: 'allow' })
    // Add a rule for every file change. (Typing into a text field does not reach React under happy-dom, whose page
    // goes up after react-dom loaded; a select's change does.)
    await click(byText(doc, t.add))
    const kind = doc.querySelector('form select') as HTMLSelectElement
    await act(async () => {
      kind.value = 'edit'
      kind.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect((doc.querySelector('input[list]') as HTMLInputElement).value).toBe('*')
    await click(doc.querySelector('form button[type=submit]') as HTMLButtonElement)
    expect(changes.at(-1)?.at(-1)).toEqual({ kind: 'edit', target: '*', decision: 'allow' })
    // Remove web_fetch.
    await click(byLabel(doc, t.remove('web_fetch')))
    expect(changes.at(-1)?.some((r) => r.target === 'web_fetch')).toBe(false)
  } finally {
    await unmount()
  }
})

test('who can use what shows where each value comes from, and a project can set one or go back to global', async () => {
  const { AccessMatrix } = await import('../src/client/permissions/AccessMatrix.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.permissions.access
  const changes: unknown[] = []
  const { host, unmount } = await (
    await page(
      <AccessMatrix
        levels={{
          global: { preset: 'auto', rules: [], access: { lead: { shell: false } } },
          project: { rules: [], access: { lead: { web: false } } },
        }}
        scope="project"
        onChange={(a) => changes.push(a)}
      />,
    )
  ).with()
  const doc = host.ownerDocument
  try {
    const shell = byLabel(doc, t.toggle(t.groups.shell.label, t.lead))
    expect(shell.getAttribute('aria-checked')).toBe('false')
    expect(shell.closest('td')?.textContent).toContain(copy.permissions.from('global'))
    await click(shell)
    expect(changes.at(-1)).toEqual({ lead: { web: false, shell: true } })
    await click(byLabel(doc, t.resetLabel(t.groups.web.label, t.lead)))
    expect(changes.at(-1)).toBeUndefined()
  } finally {
    await unmount()
  }
})

test('checking a tool says what happens for the lead and the crew, and which level decided', async () => {
  const { Explainer } = await import('../src/client/permissions/Explainer.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const { host, unmount } = await (
    await page(
      <Explainer
        global={{
          preset: 'auto',
          rules: [{ kind: 'command', target: 'git push', decision: 'deny', who: 'crew' }],
        }}
        projects={[]}
        tools={[{ name: 'shell', description: 'Runs a command.', tier: 'exec' }]}
      />,
    )
  ).with()
  const doc = host.ownerDocument
  try {
    const rows = [...doc.querySelectorAll('ul[aria-live] li')].map((li) => li.textContent)
    const e = copy.permissions.explain.outcome
    // `git push origin main` is destructive: Auto asks the lead; the crew's deny rule refuses it.
    expect(rows[0]).toContain(e.ask)
    expect(rows[0]).toContain('Auto')
    expect(rows[1]).toContain(e.deny)
    expect(rows[1]).toContain(copy.permissions.card.target.command('git push'))
  } finally {
    await unmount()
  }
})

test('walking the presets with the arrow keys saves only the one they rest on; a click saves at once', async () => {
  const { PresetChoice } = await import('../src/client/permissions/PresetChoice.tsx')
  const { PRESET_SETTLE_MS } = await import('../src/client/ui-config.ts')
  const saved: (string | undefined)[] = []
  function Host() {
    const [value, setValue] = useState<'read-only' | 'ask' | 'auto' | 'full' | undefined>('read-only')
    return (
      <PresetChoice
        value={value}
        onChange={(next) => {
          saved.push(next)
          setValue(next)
        }}
      />
    )
  }
  const { host, unmount } = await (await page(<Host />)).with()
  const doc = host.ownerDocument
  const radio = (v: string) => doc.querySelector(`input[value="${v}"]`) as HTMLInputElement
  // A browser moves the check on an arrow key; here the key goes first, then the change it causes.
  const arrowTo = async (v: string) =>
    act(async () => {
      radio(v).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      radio(v).click()
    })
  try {
    await arrowTo('ask')
    await arrowTo('auto')
    expect(saved).toEqual([])
    expect(radio('auto').checked).toBe(true)
    await act(async () => Bun.sleep(PRESET_SETTLE_MS + 50))
    expect(saved).toEqual(['auto'])
    // Space saves without waiting.
    await arrowTo('ask')
    await act(async () => {
      radio('ask').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })
    expect(saved).toEqual(['auto', 'ask'])
    // Passing Full access asks to confirm it, and saves nothing.
    await arrowTo('full')
    await act(async () => Bun.sleep(PRESET_SETTLE_MS + 50))
    expect(saved).toEqual(['auto', 'ask'])
    // A click is a choice made.
    await click(radio('read-only'))
    expect(saved).toEqual(['auto', 'ask', 'read-only'])
  } finally {
    await unmount()
  }
})

test('while computer use is off, its switches are off and say where to turn it on', async () => {
  const { AccessMatrix } = await import('../src/client/permissions/AccessMatrix.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.permissions.access
  let setUp = 0
  const { host, unmount } = await (
    await page(
      <AccessMatrix
        levels={{ global: { preset: 'auto', rules: [] } }}
        scope="global"
        computerOff={{ onSetUp: () => setUp++ }}
        onChange={() => {}}
      />,
    )
  ).with()
  const doc = host.ownerDocument
  try {
    const computer = byLabel(doc, t.toggle(t.groups.computer.label, t.lead))
    expect(computer.getAttribute('aria-checked')).toBe('false')
    expect(computer.disabled).toBe(true)
    expect(computer.closest('tr')?.textContent).toContain(t.computerOff)
    expect(byLabel(doc, t.toggle(t.groups.web.label, t.lead)).getAttribute('aria-checked')).toBe('true')
    await click(byText(doc, t.computerOn))
    expect(setUp).toBe(1)
  } finally {
    await unmount()
  }
})

test('the tools to check are listed by names people know, grouped, with the id after', async () => {
  const { Explainer } = await import('../src/client/permissions/Explainer.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.permissions.explain
  const { host, unmount } = await (
    await page(
      <Explainer
        global={{ preset: 'auto', rules: [] }}
        projects={[]}
        tools={[
          { name: 'shell', description: '', tier: 'exec' },
          { name: 'request_final_verification', description: '' },
          { name: 'mcp', description: '', mcp: true },
          { name: 'mcp__stagehand_browserbase_screenshot', description: '', mcp: true, server: 'stagehand' },
          // Tool names carry the server's name folded as omp folds it: lower case, other characters as one _.
          { name: 'mcp__chrome_devtools_click', description: '', mcp: true, server: 'chrome-devtools' },
          { name: 'mcp__my_server_list_files', description: '', mcp: true, server: 'My Server' },
        ]}
      />,
    )
  ).with()
  const doc = host.ownerDocument
  try {
    const groups = [...doc.querySelectorAll('optgroup')].map((g) => [
      g.getAttribute('label'),
      [...g.querySelectorAll('option')].map((o) => o.textContent),
    ])
    expect(groups).toEqual([
      [copy.permissions.access.groups.shell.label, [t.option('Run a command', 'shell')]],
      [copy.permissions.access.groups.mcp.label, [t.option('Any MCP tool', 'mcp')]],
      [t.otherGroup, [t.option('Ask for the final review', 'request_final_verification')]],
      [
        t.mcpGroup('stagehand'),
        [t.option('browserbase screenshot', 'mcp__stagehand_browserbase_screenshot')],
      ],
      [t.mcpGroup('chrome-devtools'), [t.option('click', 'mcp__chrome_devtools_click')]],
      [t.mcpGroup('My Server'), [t.option('list files', 'mcp__my_server_list_files')]],
    ])
  } finally {
    await unmount()
  }
})

test("a card's buttons are named by the words they show (WCAG 2.5.3)", async () => {
  recordFetch()
  const { Approval } = await import('../src/client/chat/ApprovalCards.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const file = {
    ...command,
    tool: 'fs_write',
    review: {
      kind: 'file' as const,
      title: 'Write notes.md',
      fields: [{ key: 'content', label: 'notes.md', value: 'hi', format: 'text' as const, editable: true }],
    },
  }
  const { host, unmount } = await (
    await page(<Approval colonyId="c" chatId="chat-1" request={file} />)
  ).with()
  const doc = host.ownerDocument
  try {
    const edit = buttons(doc).find((b) =>
      b.textContent?.startsWith(copy.approvals.review.edit),
    ) as HTMLElement
    // No aria-label to replace what it shows; the field it edits follows the visible word.
    expect(edit.hasAttribute('aria-label')).toBe(false)
    expect(edit.textContent).toBe(`${copy.approvals.review.edit} notes.md`)
    await click(edit)
    expect(edit.textContent).toBe(`${copy.approvals.review.preview} notes.md`)
  } finally {
    await unmount()
  }
  const { steer, queue } = copy.composer.deliveries
  expect(copy.composer.deliveryLabel(steer.label, queue.label).startsWith(steer.label)).toBe(true)
})

test('a chats-only device is not offered what the server would refuse it: every command, or reading for the chat', async () => {
  recordFetch()
  const { Approval } = await import('../src/client/chat/ApprovalCards.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const { targetText } = await import('../src/client/permissions/describe.ts')
  const t = copy.permissions.card
  const every = targetText({ kind: 'command', target: '*' })
  const read = {
    ...command,
    id: 'approval-2',
    tool: 'request_read',
    summary: 'read ~/notes',
    read: { path: '~/notes' },
  }
  for (const [scope, offered] of [
    ['full', true],
    ['chat', false],
  ] as const) {
    const { host, unmount } = await (
      await page(
        <>
          <Approval colonyId="colony-1" chatId="chat-1" project="site" request={command} />
          <Approval colonyId="colony-1" chatId="chat-1" project="site" request={read as never} />
        </>,
      )
    ).with(scope)
    const doc = host.ownerDocument
    try {
      await click(byLabel(doc, t.moreAllow))
      const menu = doc.querySelector(`[role=dialog][aria-label="${t.moreAllow}"]`) as HTMLElement
      expect(menu.textContent?.includes(every)).toBe(offered)
      const readButton = [...doc.querySelectorAll('button')].some(
        (b) => b.textContent?.trim() === copy.approvals.reads.approveAll,
      )
      expect(readButton).toBe(offered)
    } finally {
      await unmount()
    }
  }
})

test('remembering a command that runs project code warns that the crew can change what it runs', async () => {
  recordFetch()
  const { Approval } = await import('../src/client/chat/ApprovalCards.tsx')
  const { copy } = await import('../src/client/copy.ts')
  const t = copy.permissions.card
  const tests = {
    ...command,
    offer: [{ kind: 'command' as const, target: 'bun test', projectCode: true as const }],
  }
  for (const [scope, warned] of [
    ['full', true],
    ['chat', false],
  ] as const) {
    const { host, unmount } = await (
      await page(<Approval colonyId="colony-1" chatId="chat-1" project="site" request={tests} />)
    ).with(scope)
    const doc = host.ownerDocument
    try {
      await click(byLabel(doc, t.moreAllow))
      const menu = doc.querySelector(`[role=dialog][aria-label="${t.moreAllow}"]`) as HTMLElement
      // Only where it could be remembered beyond this chat: a chats-only device keeps to the chat.
      expect(menu.textContent?.includes(t.projectCode)).toBe(warned)
    } finally {
      await unmount()
    }
  }
})
