import { afterEach, expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { copy } from '../src/client/copy.ts'
import { withDom } from './dom.ts'

withDom()

afterEach(async () => {
  const { setAvatarBag } = await import('../src/client/ui/avatar-bag.ts')
  setAvatarBag(undefined)
})

test('an emote pops up when the state changes, the persona stays, and small avatars keep quiet', async () => {
  const { AvatarBag, AvatarScope, setAvatarBag } = await import('../src/client/ui/avatar-bag.ts')
  const { AgentAvatar } = await import('../src/client/ui/pixel.tsx')
  setAvatarBag(new AvatarBag({ seed: 21 }))
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const show = (status: string, size: number) =>
    act(async () =>
      root.render(
        <MotionConfig reducedMotion="always">
          <AvatarScope value="colony-x">
            <AgentAvatar name="vega" status={status} size={size} />
          </AvatarScope>
        </MotionConfig>,
      ),
    )
  await show('working', 40)
  const persona = host.querySelector('[data-persona]')?.getAttribute('data-persona') as string
  expect(persona).toBeTruthy()
  expect(host.querySelector('[data-emote]')).toBeNull()
  await show('completed', 40)
  const words = copy.avatars.personas[persona as keyof typeof copy.avatars.personas]
  expect(host.querySelector('[data-emote]')?.getAttribute('data-emote')).toBe(words.emotes.done)
  expect(host.querySelector('[data-persona]')?.getAttribute('data-persona')).toBe(persona)
  // The emote is drawn by CSS, so it stays out of the text of the row the avatar sits in.
  expect(host.textContent).toBe('')
  await show('failed', 20)
  expect(host.querySelector('[data-emote]')).toBeNull()
  expect(host.querySelector('[data-persona]')?.getAttribute('data-persona')).toBe(persona)
  await act(async () => root.unmount())
  host.remove()
})

test('the bag is kept in this browser, so a reload keeps every face', async () => {
  const { avatarBag, setAvatarBag } = await import('../src/client/ui/avatar-bag.ts')
  localStorage.removeItem('myr-avatars')
  setAvatarBag(undefined)
  const first = avatarBag().assign('colony-y', 'orion')
  setAvatarBag(undefined)
  expect(avatarBag().peek('colony-y', 'orion')).toBe(first)
})
