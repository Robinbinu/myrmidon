import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act, useState } from 'react'
import { mount, press, withDom } from './dom.ts'

withDom()

type HappyWindow = { happyDOM: { setViewport(v: { width: number; height: number }): void } }
const resize = async (width: number) =>
  act(async () => {
    ;(window as unknown as HappyWindow).happyDOM.setViewport({ width, height: 860 })
    await Bun.sleep(5)
  })

afterEach(async () => {
  await resize(1024)
  localStorage.clear()
})

/**
 * The app's sidebar placement as App wires it: ⌘B, the palette's "Toggle sidebar" and the toolbar's sidebar button
 * all call `toggle`; picking a chat changes the place; `onAway` sends focus to the message box.
 */
async function app() {
  const { useSidebarPlacement } = await import('../src/client/ui/sidebar-placement.ts')
  const { Drawer } = await import('../src/client/ui/Drawer.tsx')
  const { useHotkeys } = await import('../src/client/ui/hooks.ts')
  let palette = () => {}
  function App() {
    const [collapsed, setCollapsed] = useState(false)
    const [chat, setChat] = useState('a')
    const placement = useSidebarPlacement({
      collapsed,
      setCollapsed,
      place: chat,
      onAway: () => document.getElementById('composer')?.focus(),
    })
    palette = placement.toggle
    useHotkeys([{ combo: 'mod+b', run: placement.toggle, inInputs: true }])
    const list = (
      <nav>
        <button type="button" onClick={() => setChat('b')}>
          Chat b
        </button>
      </nav>
    )
    return (
      <MotionConfig reducedMotion="always">
        {placement.beside && <aside data-docked>{list}</aside>}
        {/* Without AnimatePresence, whose exit animations never finish under happy-dom: the drawer leaves at once. */}
        {placement.drawer && (
          <Drawer label="Sidebar" width={260} onClose={placement.close}>
            {list}
          </Drawer>
        )}
        <main>
          {!placement.beside && (
            <button type="button" id="show" onClick={placement.toggle}>
              Show sidebar
            </button>
          )}
          <textarea id="composer" />
        </main>
      </MotionConfig>
    )
  }
  const view = await mount(<App />)
  return { ...view, palette: () => act(async () => palette()) }
}

const drawer = () => document.querySelector('[role="dialog"][aria-label="Sidebar"]')
const docked = () => document.querySelector('[data-docked]')
const settle = () => act(async () => Bun.sleep(30))
const commandB = async () => {
  const { isMac } = await import('../src/client/ui/platform.ts')
  await press('b', { metaKey: isMac, ctrlKey: !isMac })
}

test('a narrow window keeps the sidebar off the page; ⌘B, the toolbar and the palette slide it over', async () => {
  await resize(420)
  const { unmount, palette } = await app()
  try {
    expect(docked()).toBeNull()
    expect(drawer()).toBeNull()
    await commandB()
    expect(drawer()).not.toBeNull()
    // Focus moves into it, as into any dialog.
    expect(drawer()?.contains(document.activeElement)).toBe(true)
    await commandB()
    await settle()
    expect(drawer()).toBeNull()
    await act(async () => (document.getElementById('show') as HTMLButtonElement).click())
    expect(drawer()).not.toBeNull()
    await press('Escape')
    await settle()
    expect(drawer()).toBeNull()
    await palette()
    expect(drawer()).not.toBeNull()
  } finally {
    await unmount()
  }
})

test('a press on the dimmed page puts the drawer away, and focus goes back to the button that opened it', async () => {
  await resize(420)
  const { unmount } = await app()
  try {
    const show = document.getElementById('show') as HTMLButtonElement
    await act(async () => {
      show.focus()
      show.click()
    })
    const scrim = drawer()?.parentElement as HTMLElement
    await act(async () => {
      scrim.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await settle()
    expect(drawer()).toBeNull()
    expect(document.activeElement).toBe(show)
  } finally {
    await unmount()
  }
})

test('picking a chat in the drawer puts it away and leaves focus in the message box', async () => {
  await resize(420)
  const { unmount } = await app()
  try {
    await commandB()
    const pick = [...(drawer()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Chat b')
    await act(async () => pick?.click())
    await settle()
    expect(drawer()).toBeNull()
    expect(document.activeElement?.id).toBe('composer')
  } finally {
    await unmount()
  }
})

test('widening the window past the breakpoint puts the drawer away and docks the sidebar', async () => {
  await resize(420)
  const { unmount } = await app()
  try {
    await commandB()
    expect(drawer()).not.toBeNull()
    const { SIDEBAR_DOCK_PX } = await import('../src/client/ui-config.ts')
    await resize(SIDEBAR_DOCK_PX + 100)
    await settle()
    expect(drawer()).toBeNull()
    expect(docked()).not.toBeNull()
    // Not dropped on the page: the button that opened the drawer is gone with it.
    expect(document.activeElement?.id).toBe('composer')
  } finally {
    await unmount()
  }
})

test('in a wide window ⌘B hides and shows the docked sidebar, and never opens the drawer', async () => {
  await resize(1280)
  const { unmount } = await app()
  try {
    expect(docked()).not.toBeNull()
    await commandB()
    expect(docked()).toBeNull()
    expect(drawer()).toBeNull()
    await commandB()
    expect(docked()).not.toBeNull()
  } finally {
    await unmount()
  }
})
