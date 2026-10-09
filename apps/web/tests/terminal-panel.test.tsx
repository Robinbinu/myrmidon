import { afterEach, beforeEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { mount, press, withDom } from './dom.ts'

withDom()

/** Stands in for the terminal's socket: records what the page sends and lets a test speak for the server. */
class FakeSocket {
  static all: FakeSocket[] = []
  static readonly OPEN = 1
  readyState = 1
  binaryType = 'blob'
  sent: string[] = []
  closed = false
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
    this.readyState = 3
  }
  /** The shell's output, as a binary frame. */
  async output(text: string) {
    await act(async () => {
      this.onmessage?.({ data: new TextEncoder().encode(text).buffer })
      // xterm parses what it is given on a timer.
      await Bun.sleep(30)
    })
  }
  /** A note from the server, as a JSON text frame. */
  async note(message: object) {
    await act(async () => this.onmessage?.({ data: JSON.stringify(message) }))
  }
}

const RealSocket = globalThis.WebSocket
beforeEach(() => {
  FakeSocket.all = []
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket
  localStorage.clear()
})
afterEach(() => {
  globalThis.WebSocket = RealSocket
})

async function render() {
  const { TerminalPanel } = await import('../src/client/chat/TerminalPanel.tsx')
  const view = await mount(
    <MotionConfig reducedMotion="always">
      <TerminalPanel project={{ id: 'p1', name: 'app' }} />
    </MotionConfig>,
  )
  const doc = view.host.ownerDocument
  const tabs = () => [...doc.querySelectorAll<HTMLElement>('[role=tab]')]
  const labels = () =>
    tabs().map((tab) => `${tab.textContent}${tab.getAttribute('aria-selected') === 'true' ? '*' : ''}`)
  const button = (name: string) => {
    const found = [...doc.querySelectorAll<HTMLElement>('button')].find(
      (b) => b.getAttribute('aria-label') === name || b.textContent === name,
    )
    if (!found) throw new Error(`no button ${name}`)
    return found
  }
  const click = (el: Element) => act(async () => (el as HTMLElement).click())
  return { ...view, doc, tabs, labels, button, click }
}

test('terminals open as tabs, each its own shell, kept alive and named by what runs in it', async () => {
  const ui = await render()
  try {
    expect(ui.labels()).toEqual(['Terminal 1 · app*'])
    expect(FakeSocket.all).toHaveLength(1)
    expect(FakeSocket.all[0]?.url).toContain('project=p1')
    await ui.click(ui.button('New terminal'))
    await ui.click(ui.button('New terminal'))
    expect(ui.labels()).toEqual(['Terminal 1 · app', 'Terminal 2 · app', 'Terminal 3 · app*'])
    expect(FakeSocket.all).toHaveLength(3)

    // The server names what runs in the foreground; back at the prompt the folder names it again.
    await FakeSocket.all[1]?.note({ type: 'process', name: 'sleep 30' })
    expect(ui.labels()[1]).toBe('Terminal 2 · sleep 30')
    await FakeSocket.all[0]?.note({ type: 'process', name: 'bun run dev' })
    await FakeSocket.all[0]?.note({ type: 'process', name: null })
    expect(ui.labels()[0]).toBe('Terminal 1 · app')
    // A shell that puts its folder in the title (OSC 0 or 2) names the folder it moved to; other titles are ignored.
    await FakeSocket.all[0]?.output('\x1b]0;robin@mac:~/code/site\x07')
    expect(ui.labels()[0]).toBe('Terminal 1 · site')
    await FakeSocket.all[0]?.output('\x1b]2;robin@mac: ~\x07')
    expect(ui.labels()[0]).toBe('Terminal 1 · ~')
    await FakeSocket.all[0]?.output('\x1b]2;my session\x07')
    expect(ui.labels()[0]).toBe('Terminal 1 · app')

    // Arrow keys move along the tabs; every terminal stays mounted (hidden) with its socket open.
    ui.tabs()[2]?.focus()
    await press('ArrowRight')
    expect(ui.labels()[0]).toBe('Terminal 1 · app*')
    expect(ui.doc.activeElement).toBe(ui.tabs()[0] ?? null)
    await press('End')
    expect(ui.labels()[2]).toBe('Terminal 3 · app*')
    await press('ArrowLeft')
    expect(ui.labels()[1]).toBe('Terminal 2 · sleep 30*')
    expect(ui.doc.querySelectorAll('[role=tabpanel]')).toHaveLength(3)
    expect(ui.doc.querySelectorAll('[role=tabpanel].hidden')).toHaveLength(2)
    expect(FakeSocket.all.some((s) => s.closed)).toBe(false)
    const panel = ui.doc.getElementById(ui.tabs()[1]?.getAttribute('aria-controls') ?? '')
    expect(panel?.getAttribute('aria-labelledby')).toBe(ui.tabs()[1]?.id ?? '')

    // ⌃⇥ and ⌃⇧⇥ step between them, wrapping, from anywhere in the view.
    await press('Tab', { ctrlKey: true })
    expect(ui.labels()[2]).toBe('Terminal 3 · app*')
    await press('Tab', { ctrlKey: true })
    expect(ui.labels()[0]).toBe('Terminal 1 · app*')
    await press('Tab', { ctrlKey: true, shiftKey: true })
    expect(ui.labels()[2]).toBe('Terminal 3 · app*')
  } finally {
    await ui.unmount()
  }
})

test('closing a terminal with a command running asks first; closing the last leaves a way to open one', async () => {
  const { CONFIRM_ARM_DELAY_MS } = await import('../src/client/ui-config.ts')
  const ui = await render()
  try {
    await ui.click(ui.button('New terminal'))
    await FakeSocket.all[0]?.note({ type: 'process', name: 'sleep 30' })
    // The pointer's × on Terminal 1: something runs there, so it asks.
    const cross = ui.tabs()[0]?.querySelector('[aria-hidden=true]')
    if (!cross) throw new Error('no close cross')
    await ui.click(cross)
    expect(ui.doc.querySelector('[role=alert]')?.textContent).toContain(
      'sleep 30 is still running in Terminal 1.',
    )
    expect(ui.labels()).toHaveLength(2)
    // Taking it back keeps the terminal.
    await ui.click(ui.button('Cancel'))
    expect(ui.doc.querySelector('[role=alert]')).toBeNull()
    await ui.click(cross)
    // A second click straight after the first (a double-click) does not confirm.
    await ui.click(ui.button('Yes, close terminal'))
    expect(ui.labels()).toHaveLength(2)
    await act(async () => Bun.sleep(CONFIRM_ARM_DELAY_MS + 50))
    await ui.click(ui.button('Yes, close terminal'))
    expect(ui.labels()).toEqual(['Terminal 2 · app*'])
    expect(FakeSocket.all[0]?.closed).toBe(true)

    // An idle shell closes at once, by Delete on its tab; then the view offers a new one.
    ui.tabs()[0]?.focus()
    await press('Delete')
    expect(ui.tabs()).toHaveLength(0)
    expect(ui.doc.body.textContent).toContain('No terminals open')
    const again = [...ui.doc.querySelectorAll('button')].filter((b) => b.textContent === 'New terminal')
    await ui.click(again.at(-1) as HTMLElement)
    expect(ui.labels()).toEqual(['Terminal 1 · app*'])
  } finally {
    await ui.unmount()
  }
})

test('a chat holds a limited number of terminals', async () => {
  const { MAX_TERMINAL_TABS } = await import('../src/client/ui-config.ts')
  const ui = await render()
  try {
    for (let i = 1; i < MAX_TERMINAL_TABS + 2; i++) await ui.click(ui.button('New terminal'))
    expect(ui.tabs()).toHaveLength(MAX_TERMINAL_TABS)
    expect(ui.button('New terminal').hasAttribute('disabled')).toBe(true)
  } finally {
    await ui.unmount()
  }
})

test('the ⋯ menu sets cursor, blink, copy on select and scrollback for every terminal, remembered here', async () => {
  const ui = await render()
  try {
    await ui.click(ui.button('Terminal options'))
    const item = (name: string) =>
      [...ui.doc.querySelectorAll<HTMLElement>('[role^=menuitem]')].find((i) => i.textContent === name)
    const checked = () =>
      [...ui.doc.querySelectorAll<HTMLElement>('[role^=menuitem][aria-checked=true]')].map(
        (i) => i.textContent,
      )
    expect(checked()).toEqual(['Block', 'Blink cursor', '10,000 lines'])
    expect(item('Copy on select')?.getAttribute('role')).toBe('menuitemcheckbox')
    expect(item('Bar')?.getAttribute('role')).toBe('menuitemradio')
    await ui.click(item('Bar') as HTMLElement)
    await ui.click(item('Blink cursor') as HTMLElement)
    await ui.click(item('Copy on select') as HTMLElement)
    await ui.click(item('50,000 lines') as HTMLElement)
    expect(checked()).toEqual(['Bar', 'Copy on select', '50,000 lines'])
    expect(localStorage.getItem('myr-terminal-cursor')).toBe('bar')
    expect(localStorage.getItem('myr-terminal-scrollback')).toBe('50000')
  } finally {
    await ui.unmount()
  }
  // A new view (another chat, a reload) starts with them.
  const next = await render()
  try {
    await next.click(next.button('Terminal options'))
    const checked = [...next.doc.querySelectorAll('[role^=menuitem][aria-checked=true]')].map(
      (i) => i.textContent,
    )
    expect(checked).toEqual(['Bar', 'Copy on select', '50,000 lines'])
  } finally {
    await next.unmount()
  }
})

test('maximize fills the window; Escape outside the shell or the button restores it', async () => {
  const ui = await render()
  const root = () => ui.host.querySelector('[role=tablist]')?.parentElement?.parentElement
  try {
    await ui.click(ui.button('Maximize terminal'))
    expect(root()?.className).toContain('fixed')
    // Escape typed into the shell is the shell's.
    const screen = ui.doc.querySelector<HTMLElement>('[data-terminal-screen]')
    await act(async () => {
      screen?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(root()?.className).toContain('fixed')
    ui.tabs()[0]?.focus()
    await press('Escape')
    expect(root()?.className).not.toContain('fixed')
    await ui.click(ui.button('Maximize terminal'))
    await ui.click(ui.button('Restore terminal (Esc)'))
    expect(root()?.className).not.toContain('fixed')
  } finally {
    await ui.unmount()
  }
})
