import { afterEach, expect, test } from 'bun:test'
import { emptyColonyState } from '@myrmidon/protocol'
import { AnimatePresence } from 'motion/react'
import { act, type ReactNode, useState } from 'react'
import { Modal } from '../src/client/ui/Modal.tsx'
import { mount, press, withDom } from './dom.ts'

withDom()

let unmount: (() => Promise<void>) | undefined
afterEach(async () => {
  await unmount?.()
  unmount = undefined
})

async function show(ui: ReactNode) {
  unmount = (await mount(ui)).unmount
}

/** What a screen reader would announce for `el`: its role and name. */
function named(el: Element | null): string {
  if (!el || el === document.body) return 'nothing'
  const role = el.getAttribute('role') ?? el.tagName.toLowerCase()
  const name = el.getAttribute('aria-label') ?? el.querySelector('h2')?.textContent ?? el.textContent
  return `${role} ${name}`
}

/** Compared by name, not as elements: a failed match then prints a line rather than a whole DOM node. */
const focused = () => named(document.activeElement)

function find(selector: string, name: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(selector)].find((el) =>
    named(el).endsWith(` ${name}`),
  )
  if (!found) throw new Error(`no ${selector} named "${name}"`)
  return found
}
const button = (name: string) => find('button', name)
const dialog = (name: string) => find('[role="dialog"]', name)
const insideDialog = (name: string) => dialog(name).contains(document.activeElement)

/** Focuses `el` and clicks it, as pressing a button does. */
async function choose(el: HTMLElement) {
  el.focus()
  await act(async () => el.click())
}

/** A button that opens a dialog, mounted the way the app mounts them: inside AnimatePresence. */
function Opener(props: { label: string; children(close: () => void): ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {props.label}
      </button>
      <AnimatePresence>{open && props.children(() => setOpen(false))}</AnimatePresence>
    </>
  )
}

/**
 * Settings with a confirmation over it, opened by a button inside Settings. The confirmation renders inside the
 * Settings dialog (`nested`) or next to it.
 */
function Stacked(props: { nested: boolean; closed: string[] }) {
  const [settings, setSettings] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const confirmation = (
    <AnimatePresence>
      {confirm && (
        <Modal
          title="Confirm"
          onClose={() => {
            props.closed.push('Confirm')
            setConfirm(false)
          }}
        >
          <button type="button">Yes</button>
        </Modal>
      )}
    </AnimatePresence>
  )
  return (
    <>
      <button type="button" onClick={() => setSettings(true)}>
        Open settings
      </button>
      <AnimatePresence>
        {settings && (
          <Modal
            title="Settings"
            onClose={() => {
              props.closed.push('Settings')
              setSettings(false)
            }}
          >
            <button type="button" onClick={() => setConfirm(true)}>
              Delete
            </button>
            {props.nested && confirmation}
          </Modal>
        )}
      </AnimatePresence>
      {!props.nested && confirmation}
    </>
  )
}

for (const nested of [false, true]) {
  test(`Escape closes only the topmost of two dialogs, the second rendered ${nested ? 'inside' : 'beside'} the first`, async () => {
    const closed: string[] = []
    await show(<Stacked nested={nested} closed={closed} />)
    await choose(button('Open settings'))
    await choose(button('Delete'))
    expect(insideDialog('Confirm')).toBe(true)

    await press('Escape')
    expect(closed).toEqual(['Confirm'])
    // Focus goes back to the button in the first dialog that opened the second.
    expect(focused()).toBe('button Delete')

    await press('Escape')
    expect(closed).toEqual(['Confirm', 'Settings'])
    expect(focused()).toBe('button Open settings')
  })
}

test('a dialog that opens already holding another sits below it, so Escape closes the inner one first', async () => {
  const closed: string[] = []
  function Both() {
    const [outer, setOuter] = useState(true)
    const [inner, setInner] = useState(true)
    return (
      <AnimatePresence>
        {outer && (
          <Modal
            title="Outer"
            onClose={() => {
              closed.push('Outer')
              setOuter(false)
            }}
          >
            <AnimatePresence>
              {inner && (
                <Modal
                  title="Inner"
                  onClose={() => {
                    closed.push('Inner')
                    setInner(false)
                  }}
                >
                  <button type="button">Inner action</button>
                </Modal>
              )}
            </AnimatePresence>
          </Modal>
        )}
      </AnimatePresence>
    )
  }
  await show(<Both />)
  await press('Escape')
  expect(closed).toEqual(['Inner'])
  await press('Escape')
  expect(closed).toEqual(['Inner', 'Outer'])
})

test('focus moves into a dialog as it opens, Tab and Shift+Tab stay inside it, and focus returns on close', async () => {
  let closes = 0
  await show(
    <>
      <button type="button">Behind</button>
      <Opener label="Open">
        {(close) => (
          <Modal
            title="Dialog"
            onClose={() => {
              closes++
              close()
            }}
          >
            <button type="button">One</button>
            <button type="button">Two</button>
          </Modal>
        )}
      </Opener>
    </>,
  )
  await choose(button('Open'))
  expect(focused()).toBe('dialog Dialog')
  // The header's Close button is the first Tab stop, the last child the last.
  expect(dialog('Dialog').contains(button('Close'))).toBe(true)

  // From the dialog itself Shift+Tab would step out backwards; it wraps to the last stop instead. (Tab reaches the
  // first stop inside without help.)
  let key = await press('Tab', { shiftKey: true })
  expect(key.defaultPrevented).toBe(true)
  expect(focused()).toBe('button Two')

  key = await press('Tab')
  expect(key.defaultPrevented).toBe(true)
  expect(focused()).toBe('button Close')

  key = await press('Tab', { shiftKey: true })
  expect(key.defaultPrevented).toBe(true)
  expect(focused()).toBe('button Two')

  // Between the ends the browser moves focus itself; the dialog leaves those presses alone.
  button('One').focus()
  key = await press('Tab')
  expect(key.defaultPrevented).toBe(false)

  // Focus that got out (a click on the page behind, say) comes back in with the next Tab.
  button('Behind').focus()
  key = await press('Tab')
  expect(key.defaultPrevented).toBe(true)
  expect(focused()).toBe('button Close')

  await press('Escape')
  expect(closes).toBe(1)
  expect(focused()).toBe('button Open')
  // Closed, it no longer answers keys.
  await press('Escape')
  expect(closes).toBe(1)
})

test('the Close button and a press on the backdrop close a dialog and give focus back', async () => {
  await show(
    <Opener label="Open">
      {(close) => (
        <Modal title="Dialog" onClose={close}>
          Body
        </Modal>
      )}
    </Opener>,
  )

  await choose(button('Open'))
  await choose(button('Close'))
  expect(focused()).toBe('button Open')

  await choose(button('Open'))
  const backdrop = dialog('Dialog').parentElement as HTMLElement
  await act(async () => {
    backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  expect(focused()).toBe('button Open')
})

test('the agent sheet takes focus when it opens, keeps Tab inside, closes on Escape, and gives focus back', async () => {
  // The sheet loads saved specialists; answer without a server. Taking the page down puts Bun's fetch back.
  globalThis.fetch = (async () => Response.json({ specialists: [] })) as unknown as typeof fetch
  // Loaded here, not up top: the sheet's imports read the page's address as they load.
  const { AgentSheet } = await import('../src/client/chat/AgentSheet.tsx')
  const state = emptyColonyState('c')
  state.agents.ada = {
    info: { name: 'ada', role: 'worker', model: 'test-model', tools: [] },
    status: 'working',
    turns: 0,
    tokens: 0,
    cost: 0,
    costKnown: true,
    toolCalls: 0,
    lastSeq: 0,
  }
  let closes = 0
  await show(
    <Opener label="ada">
      {(close) => (
        <AgentSheet
          name="ada"
          state={state}
          events={[]}
          onClose={() => {
            closes++
            close()
          }}
        />
      )}
    </Opener>,
  )
  await choose(button('ada'))
  expect(focused()).toBe('dialog ada details')

  await press('Tab', { shiftKey: true })
  expect(insideDialog('ada details')).toBe(true)
  await press('Tab')
  expect(insideDialog('ada details')).toBe(true)

  await press('Escape')
  expect(closes).toBe(1)
  expect(focused()).toBe('button ada')
})
