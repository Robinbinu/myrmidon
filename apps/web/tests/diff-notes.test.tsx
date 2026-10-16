import { expect, test } from 'bun:test'
import { act } from 'react'
import { mount, withDom } from './dom.ts'

withDom()

const PATCH = `diff --git a/src/math.ts b/src/math.ts
index 1..2 100644
--- a/src/math.ts
+++ b/src/math.ts
@@ -1,3 +1,4 @@ export
 export const a = 1
-export const b = 2
+export const b = 3
+export const c = 4
 export const d = 5
`

const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement | undefined)?.click())

/** Types into a field as React hears it here (see live-share.test.tsx). */
async function type(el: HTMLTextAreaElement, value: string) {
  await act(async () => {
    el.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.at(-1) ?? '' }))
  })
}

test('a diff line takes a pinned note for the next /review, shows the notes pinned to it, and lets one go', async () => {
  const { DiffView } = await import('../src/client/chat/DiffView.tsx')
  const pinned: { path: string; line: number; text: string }[] = []
  const unpinned: string[] = []
  const notes = {
    list: [{ id: 'note-1', path: 'src/math.ts', line: 2, text: 'Is 3 right here?' }],
    pin: async (path: string, line: number, text: string) => {
      pinned.push({ path, line, text })
    },
    unpin: async (id: string) => {
      unpinned.push(id)
    },
  }
  const view = await mount(
    <DiffView
      files={[{ path: 'src/math.ts', status: 'M', added: 2, removed: 1 }]}
      patch={PATCH}
      notes={notes}
    />,
  )
  await click(view.host.querySelector('button[aria-expanded="false"]'))
  // The note already pinned shows under its line.
  expect(view.host.textContent).toContain('Is 3 right here?')
  // Line 3 (new side) takes a note.
  await click(view.host.querySelector('button[aria-label="Pin a note to line 3 for the next /review"]'))
  const box = view.host.querySelector('textarea')
  expect(box).not.toBeNull()
  await type(box as HTMLTextAreaElement, 'c is never read')
  await click([...view.host.querySelectorAll('button')].find((b) => b.textContent === 'Pin note'))
  expect(pinned).toEqual([{ path: 'src/math.ts', line: 3, text: 'c is never read' }])
  await click(view.host.querySelector('button[aria-label="Remove the note on line 2"]'))
  expect(unpinned).toEqual(['note-1'])
  // Without notes the numbers are plain: nothing to pin.
  await view.unmount()
  const plain = await mount(<DiffView files={[{ path: 'src/math.ts', status: 'M' }]} patch={PATCH} />)
  await click(plain.host.querySelector('button[aria-expanded="false"]'))
  expect(plain.host.querySelector('button[aria-label^="Pin a note"]')).toBeNull()
  await plain.unmount()
})
