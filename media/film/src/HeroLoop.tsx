import { AbsoluteFill, Sequence, useCurrentFrame } from 'remotion'
import { EASES, tween } from './anim.ts'
import { Film } from './Film.tsx'
import { C } from './theme.ts'

/** The README's loop: the crew's triptych, the three close-ups, and the fold onto the board. */
export const HERO = { from: 1520, to: 2420 }
export const HERO_FRAMES = HERO.to - HERO.from
const FADE = 20

/** A window of the film itself, faded in and out of black so it loops without a jump. */
export function HeroLoop() {
  const f = useCurrentFrame()
  const opacity = Math.min(tween(f, 0, FADE, 0, 1, EASES.out), 1 - tween(f, HERO_FRAMES - FADE, HERO_FRAMES, 0, 1, EASES.in))
  return (
    <AbsoluteFill style={{ background: C.black }}>
      <AbsoluteFill style={{ opacity }}>
        <Sequence from={-HERO.from} layout="none">
          <Film />
        </Sequence>
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
