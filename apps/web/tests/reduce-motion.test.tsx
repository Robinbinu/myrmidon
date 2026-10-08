import { expect, test } from 'bun:test'
import { MotionConfig } from 'motion/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Snore } from '../src/client/ui/pixel.tsx'

test('the in-app Reduce motion setting stills animations, not only the system setting', () => {
  const still = renderToStaticMarkup(
    <MotionConfig reducedMotion="always">
      <Snore size={32} />
    </MotionConfig>,
  )
  const moving = renderToStaticMarkup(
    <MotionConfig reducedMotion="never">
      <Snore size={32} />
    </MotionConfig>,
  )
  expect(still).toContain('opacity:0.6')
  expect(moving).toContain('opacity:0')
  expect(moving).not.toContain('opacity:0.6')
})
